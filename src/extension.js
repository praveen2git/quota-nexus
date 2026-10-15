'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const { AgyClient } = require('./agyClient');
const { ClaudeContextReader, fetchClaudeUsage, usageDue, usageResult } = require('./claudeCode');
const { CodexReader } = require('./codex');
const { Accounts } = require('./accounts');
const { evaluateAlerts } = require('./alerts');
const { History } = require('./history');
const { buildViewState, seriesId, claudeWindows, codexWindows, markActive, IDLE_MS } = require('./viewState');
const { settingsView, isValidSetting } = require('./settingsUi');
const { StatusBar } = require('./statusBar');
const { DashboardProvider } = require('./webview');
const { maskEmail, formatCountdown, formatAgo } = require('./util');

const ALERTS_KEY = 'nexus.alerts.v1';
const SNOOZE_KEY = 'nexus.alertsSnooze';
const SNOOZE_MS = 3600e3;
const USAGE_MIN_GAP_MS = 5 * 60000;
const USAGE_KEY = 'nexus.ccUsage';
const WATCH_THROTTLE_MS = 1500;
const FOCUS_REFRESH_MS = 60000;
const AG_WATCH_MS = 5000;
const AG_STATUS_MS = 30000;
const TICK_MS = 60000;
const SIGNIN_START_MS = 3500;
const SIGNIN_STEP_MS = 1500;
const SIGNIN_RESCAN_MS = 8000;
// Google OAuth authorization codes look like "4/0A..."; anything else is not pasted.
const AUTH_CODE_RE = /^4\/[\w-]{20,512}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Nexus {
    constructor(context) {
        this.context = context;
        this.home = os.homedir();
        this.log = vscode.window.createOutputChannel('Quota Nexus', { log: true });
        this.agy = new AgyClient(this.log);
        this.claude = new ClaudeContextReader(this.home);
        this.codexReader = new CodexReader(this.home);
        this.accounts = new Accounts(context.globalState);
        this.history = new History(context.globalState);
        this.bar = new StatusBar();
        this.view = new DashboardProvider(context.extensionUri, m => this.onMessage(m));
        this.status = null;
        this.connected = false;
        this.agContext = null;
        this.ccContext = null;
        this.ccUsage = null;
        this.ccUsageError = '';
        this.usageForce = false;
        this.ccUsageUntil = 0;
        this.codexData = null;
        this.updatedAt = 0;
        this.lastRefreshMs = 0;
        this.inFlight = null;
        this.timer = null;
        this.startTimer = null;
        this.renderTimer = null;
        this.watchers = [];
        this.ctxSeen = {};
        this.ctxKeys = {};
        this.agChecked = false;
        this.agStatusAt = 0;
        this.tickTimer = null;
    }

    // Title-bar icons switch on these (bell vs bell-slash, eye vs eye-closed).
    setContextKey(key, value) {
        if (this.ctxKeys[key] === value) return;
        this.ctxKeys[key] = value;
        vscode.commands.executeCommand('setContext', key, value);
    }

    markActive(c) {
        return markActive(this.ctxSeen, c, Date.now());
    }

    start() {
        const c = this.context;
        const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
        c.subscriptions.push(
            this.log,
            this.bar,
            vscode.window.registerWebviewViewProvider('quotaNexus.dashboard', this.view),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (!e.affectsConfiguration(cfg.SECTION)) return;
                if (e.affectsConfiguration(`${cfg.SECTION}.refresh`)) this.schedule();
                const refetch = ['antigravity', 'claudeCode', 'codex', 'contextWindow'].some(k => e.affectsConfiguration(`${cfg.SECTION}.${k}`));
                if (refetch) this.refresh();
                else this.render();
            }),
            vscode.window.onDidChangeWindowState(s => {
                if (s.focused && Date.now() - this.updatedAt > Math.min(cfg.interval(), FOCUS_REFRESH_MS)) this.refresh();
            }),
            cmd('quotaNexus.refresh', () =>
                vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Quota Nexus: refreshing' }, () => this.refresh(true))),
            cmd('quotaNexus.switchAccount', () => this.pickAccount()),
            cmd('quotaNexus.signIn', () => this.guidedSignIn(null)),
            cmd('quotaNexus.toggleMask', () => cfg.set('privacy.maskEmails', !cfg.get('privacy.maskEmails', true))),
            cmd('quotaNexus.maskEmails', () => cfg.set('privacy.maskEmails', true)),
            cmd('quotaNexus.showEmails', () => cfg.set('privacy.maskEmails', false)),
            cmd('quotaNexus.resumeAlerts', () => this.toggleSnooze()),
            cmd('quotaNexus.togglePercentMode', () => cfg.set('display.percentMode', cfg.get('display.percentMode', 'used') === 'left' ? 'used' : 'left')),
            cmd('quotaNexus.snoozeAlerts', () => this.toggleSnooze()),
            cmd('quotaNexus.showDiagnostics', () => this.showDiagnostics()),
            cmd('quotaNexus.openSettings', () =>
                vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${c.extension.id}`)),
            cmd('quotaNexus.quickSettings', () => this.view.showSettings()),
            { dispose: () => this.dispose() }
        );
        this.log.info(`Quota Nexus ${c.extension.packageJSON.version} started on ${process.platform}`);
        cfg.migrate()
            .then(moved => moved.forEach(m => this.log.info(`Setting moved: ${m}`)))
            .catch(e => this.log.warn(`Settings migration skipped: ${e && e.message}`));
        this.watch();
        this.schedule();
        this.render();
        this.startTimer = setTimeout(() => this.refresh(), 50);
    }

    schedule() {
        clearInterval(this.timer);
        this.timer = setInterval(() => {
            if (cfg.get('refresh.pauseWhenUnfocused', true) && !vscode.window.state.focused) return;
            this.refresh();
        }, cfg.interval());
        // Redraw only (no I/O) so countdowns and "Updated" stay current between refreshes.
        clearInterval(this.tickTimer);
        this.tickTimer = setInterval(() => {
            if (vscode.window.state.focused) this.render();
        }, TICK_MS);
    }

    refresh(force) {
        if (force) this.usageForce = true;
        if (!this.inFlight) {
            this.inFlight = this.doRefresh()
                .catch(e => this.log.warn(`Refresh failed: ${e && e.message}`))
                .finally(() => { this.inFlight = null; });
        }
        return this.inFlight;
    }

    wsPaths() {
        return (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
    }

    agEnabled() {
        return cfg.get('antigravity.enable', true);
    }

    wantAgContext() {
        return this.agEnabled() && cfg.get('antigravity.showContextWindow', true) && cfg.get('contextWindow.display', 'auto') !== 'off';
    }

    // Each source renders as soon as it lands, so fast local logs never wait for agy discovery.
    async doRefresh() {
        const started = Date.now();
        const ws = this.wsPaths();
        const force = this.usageForce;
        this.usageForce = false;
        const settle = (name, task, apply) => task
            .then(apply, e => this.log.warn(`${name}: ${e && e.message}`))
            .then(() => { this.updatedAt = Date.now(); this.render(); });
        const agyTask = (async () => {
            if (!this.agEnabled()) return { s: null, ctx: null };
            const s = await this.agy.getStatus();
            const ctx = s && this.wantAgContext() ? await this.agy.getContext(ws, s.modelLabels).catch(() => null) : null;
            return { s, ctx };
        })().catch(e => {
            this.log.warn(`Antigravity: ${e && e.message}`);
            return { s: null, ctx: null };
        });
        await Promise.all([
            settle('Antigravity', agyTask, ({ s, ctx }) => {
                this.agChecked = true;
                this.agStatusAt = Date.now();
                if (s) {
                    this.onStatus(s);
                    for (const o of this.agy.takeOthers()) {
                        if (o.email.toLowerCase() !== s.email.toLowerCase()) this.accounts.recordActive(o);
                    }
                    this.agContext = ctx;
                } else {
                    this.connected = false;
                    this.agContext = null;
                }
            }),
            settle('Claude Code logs', cfg.get('claudeCode.enable', true) ? this.claude.read(ws) : Promise.resolve(null), v => { this.ccContext = v; }),
            settle('Codex logs', cfg.get('codex.enable', true) ? this.codexReader.read(ws) : Promise.resolve(null), v => {
                this.codexData = v;
                this.runToolAlerts();
            }),
            settle('Claude Code limits', this.refreshUsage(force), () => this.runToolAlerts())
        ]);
        this.lastRefreshMs = Date.now() - started;
    }

    async refreshUsage(force) {
        if (!cfg.get('claudeCode.enable', true) || !cfg.get('claudeCode.fetchUsageLimits', false)) {
            this.ccUsage = null;
            this.ccUsageError = '';
            return;
        }
        // Shared with other windows and reloads so they reuse one result instead of each asking.
        const gap = Math.max(USAGE_MIN_GAP_MS, cfg.interval());
        const shared = this.context.globalState.get(USAGE_KEY) || {};
        this.applyUsage(shared);
        if (!usageDue(shared, Date.now(), gap, force)) return;
        await this.context.globalState.update(USAGE_KEY, { ...shared, at: Date.now() });
        const r = await fetchClaudeUsage(this.home);
        const next = usageResult(shared, r, Date.now(), gap);
        await this.context.globalState.update(USAGE_KEY, next);
        if (r.error && r.error !== this.ccUsageError) this.log.warn(`Claude Code limits: ${r.error}`);
        this.applyUsage(next);
    }

    applyUsage(s) {
        if (s.data) this.ccUsage = s.data;
        this.ccUsageError = s.error || '';
        this.ccUsageUntil = s.until || 0;
    }

    onStatus(s) {
        const prev = this.connected && this.status ? this.status.email : null;
        this.status = s;
        this.connected = true;
        this.accounts.recordActive(s);
        if (prev && s.email && prev.toLowerCase() !== s.email.toLowerCase()) {
            vscode.window.showInformationMessage(`Quota Nexus: Antigravity is now signed in as ${maskEmail(s.email, cfg.get('privacy.maskEmails', true))}.`);
        }
        this.runAlerts(s.email.toLowerCase(), s.pools, s.pools);
    }

    runToolAlerts() {
        const usedToPools = (wins, prefix) => wins.map(w => ({ id: w.id, name: `${prefix} ${w.name}`, remainingPct: 100 - w.pct, resetTime: w.resetsAt }));
        if (cfg.get('claudeCode.enable', true) && cfg.get('claudeCode.fetchUsageLimits', false) && this.ccUsage) {
            this.runAlerts('claudeCode', usedToPools(claudeWindows(this.ccUsage), 'Claude Code'), []);
        }
        const lim = cfg.get('codex.enable', true) && this.codexData && this.codexData.limits;
        if (lim && Date.now() - (lim.at || 0) <= IDLE_MS) {
            const fresh = codexWindows(lim).filter(w => !(Date.parse(w.resetsAt || '') <= Date.now()));
            this.runAlerts('codex', usedToPools(fresh, 'Codex'), []);
        }
    }

    // Opt-in stays explicit: the user sees exactly what is read and where it goes.
    async enableClaudeLimits() {
        const detail = [
            'Quota Nexus will read your existing Claude Code sign-in token from ~/.claude/.credentials.json.',
            'It sends it only to api.anthropic.com, at most every 5 minutes, to fetch your 5-hour and weekly limits.',
            'The token is never stored, logged, refreshed or rewritten. You can turn this off any time in Settings.'
        ].join('\n\n');
        const pick = await vscode.window.showInformationMessage('Show Claude Code limits?', { modal: true, detail }, 'Turn On');
        if (pick === 'Turn On') await cfg.set('claudeCode.fetchUsageLimits', true);
    }

    // From the dashboard panel; turning on Claude limits still goes through the consent dialog.
    async setSetting(key, value) {
        if (!isValidSetting(key, value)) return;
        if (key === 'claudeCode.fetchUsageLimits' && value === true) await this.enableClaudeLimits();
        else await cfg.set(key, value);
        this.render();
    }

    snoozedUntil() {
        return this.context.globalState.get(SNOOZE_KEY) || 0;
    }

    toggleSnooze() {
        const on = this.snoozedUntil() > Date.now();
        this.context.globalState.update(SNOOZE_KEY, on ? 0 : Date.now() + SNOOZE_MS).then(() => this.render());
        vscode.window.showInformationMessage(on ? 'Quota Nexus: alerts resumed.' : 'Quota Nexus: alerts snoozed for 1 hour.');
    }

    // siblings: other pools of the same tool, used to suggest one that still has room.
    runAlerts(key, pools, siblings) {
        if (!cfg.get('alerts.enabled', true) || !key) return;
        const store = this.context.globalState.get(ALERTS_KEY) || {};
        const { next, events } = evaluateAlerts(store[key] || {}, pools, {
            thresholds: cfg.get('alerts.thresholds', [20, 5]),
            notifyOnReset: cfg.get('alerts.notifyOnReset', true)
        });
        if (JSON.stringify(next) !== JSON.stringify(store[key])) {
            store[key] = next;
            this.context.globalState.update(ALERTS_KEY, store);
        }
        if (!events.length || this.snoozedUntil() > Date.now()) return;
        for (const e of events) {
            if (e.type === 'reset') {
                vscode.window.showInformationMessage(`Quota Nexus: ${e.pool.name} quota has reset.`);
                continue;
            }
            const when = formatCountdown(e.pool.resetTime);
            const spare = siblings.filter(p => p.id !== e.pool.id && p.remainingPct >= 50).sort((a, b) => b.remainingPct - a.remainingPct)[0];
            const hint = spare ? ` ${spare.name} still has ${spare.remainingPct}% - switch models to keep working.` : '';
            vscode.window.showWarningMessage(
                `Quota Nexus: ${e.pool.name} is at ${e.pool.remainingPct}% left${when ? `, resets in ${when}` : ''}.${hint}`,
                'Open Dashboard', 'Snooze 1 Hour'
            ).then(pick => {
                if (pick === 'Open Dashboard') vscode.commands.executeCommand('quotaNexus.dashboard.focus');
                else if (pick === 'Snooze 1 Hour') this.context.globalState.update(SNOOZE_KEY, Date.now() + SNOOZE_MS).then(() => this.render());
            });
        }
    }

    recordHistory(v) {
        const now = Date.now();
        if (v.active) for (const p of v.active.pools) this.history.add(seriesId.ag(v.active.email, p.id), p.pct, now);
        for (const w of v.claude.windows) this.history.add(seriesId.cc(w.id), 100 - w.pct, now);
        for (const w of v.codex.windows) this.history.add(seriesId.cx(w.id), 100 - w.pct, now);
        this.history.save();
    }

    render() {
        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(() => this.renderNow(), 30);
    }

    renderNow() {
        const fetchUsage = cfg.get('claudeCode.fetchUsageLimits', false);
        const ccEnabled = cfg.get('claudeCode.enable', true);
        const cxEnabled = cfg.get('codex.enable', true);
        const v = buildViewState({
            mask: cfg.get('privacy.maskEmails', true),
            percentMode: cfg.get('display.percentMode', 'used'),
            antigravityEnabled: this.agEnabled(),
            connected: this.connected && this.agEnabled(),
            connecting: !this.agChecked && this.agEnabled(),
            status: this.status,
            accounts: this.accounts.all(),
            agContext: this.markActive(this.agContext),
            claude: {
                enabled: ccEnabled,
                usageEnabled: ccEnabled && fetchUsage,
                context: this.markActive(this.ccContext),
                usage: this.ccUsage,
                usageError: this.ccUsageError
            },
            codex: { enabled: cxEnabled, data: this.codexData && { ...this.codexData, context: this.markActive(this.codexData.context) } },
            history: id => this.history.series(id),
            updatedAt: this.updatedAt
        });
        this.recordHistory(v);
        v.snoozed = this.snoozedUntil() > Date.now();
        this.bar.update(v, {
            show: cfg.get('statusBar.show', true),
            showEmail: cfg.get('statusBar.showEmail', false),
            format: cfg.get('statusBar.format', 'descriptive'),
            thresholds: cfg.get('alerts.thresholds', [20, 5]).map(Number).filter(n => n > 0 && n < 100),
            showAgUsage: cfg.get('antigravity.showInStatusBar', true),
            showClaudeUsage: cfg.get('claudeCode.showInStatusBar', true),
            showCodexUsage: cfg.get('codex.showInStatusBar', true),
            showAgContext: cfg.get('antigravity.showContextWindow', true),
            showCcContext: ccEnabled && cfg.get('claudeCode.showContextWindow', true),
            showCxContext: cxEnabled && cfg.get('codex.showContextWindow', true),
            contextDisplay: cfg.get('contextWindow.display', 'auto')
        });
        v.settings = settingsView(k => cfg.get(k));
        this.setContextKey('quotaNexus.snoozed', v.snoozed);
        this.setContextKey('quotaNexus.masked', v.mask);
        this.view.setState(v);
    }

    async onMessage(msg) {
        const email = typeof msg.email === 'string' ? msg.email : '';
        const acc = email ? this.accounts.find(email) : null;
        switch (msg.type) {
            case 'refresh': return this.refresh(true);
            case 'signIn': return this.guidedSignIn(null);
            case 'switch': return acc && this.guidedSignIn(acc.email);
            case 'toggleMask': return cfg.set('privacy.maskEmails', !cfg.get('privacy.maskEmails', true));
            case 'openSettings': return vscode.commands.executeCommand('quotaNexus.openSettings');
            case 'diagnostics': return this.showDiagnostics();
            case 'enableClaudeLimits': return this.enableClaudeLimits();
            case 'setSetting': return this.setSetting(msg.key, msg.value);
            case 'snooze': {
                this.toggleSnooze();
                return this.render();
            }
            case 'rename': {
                if (!acc) return;
                const label = await vscode.window.showInputBox({
                    title: 'Account label',
                    prompt: 'A short name such as Work or Personal. Leave empty to clear.',
                    value: acc.label || ''
                });
                if (label === undefined) return;
                this.accounts.setLabel(acc.email, label.trim());
                return this.render();
            }
            case 'remove': {
                if (!acc) return;
                const masked = maskEmail(acc.email, cfg.get('privacy.maskEmails', true));
                const ok = await vscode.window.showWarningMessage(`Remove ${masked} from Quota Nexus? This only forgets the saved snapshot.`, { modal: true }, 'Remove');
                if (ok !== 'Remove') return;
                this.accounts.remove(acc.email);
                return this.render();
            }
            case 'moveAccount': {
                if (!acc) return;
                const dir = msg.direction === 'up' ? 'up' : 'down';
                this.accounts.move(acc.email, dir);
                return this.render();
            }
            default:
        }
    }

    async pickAccount() {
        const mask = cfg.get('privacy.maskEmails', true);
        const activeEmail = this.connected && this.status ? this.status.email.toLowerCase() : '';
        const items = this.accounts.all()
            .filter(a => a.email.toLowerCase() !== activeEmail)
            .map(a => ({ label: `$(account) ${a.label || maskEmail(a.email, mask)}`, description: a.planName || '', detail: a.label ? maskEmail(a.email, mask) : undefined, email: a.email }));
        items.push({ label: '$(add) Sign in with another account', email: null });
        const pick = await vscode.window.showQuickPick(items, { title: 'Switch Antigravity account', placeHolder: 'Pick the account to sign in with' });
        if (pick) await this.guidedSignIn(pick.email);
    }

    agyPath() {
        const p = path.join(this.home, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
        return fs.existsSync(p) ? p : null;
    }

    // Quota Nexus never stores or moves sign-in tokens; switching drives Antigravity's own sign-in.
    async guidedSignIn(targetEmail) {
        const who = targetEmail ? maskEmail(targetEmail, cfg.get('privacy.maskEmails', true)) : 'another Google account';
        const agy = this.agyPath();
        const detail = agy ? [
            'Quota Nexus opens agy, signs it out and starts Google sign-in for you. Then:',
            '',
            `1. In the browser, pick ${who} and click Continue.`,
            '2. Copy the code Google shows.',
            '3. Click "Paste Code" in VS Code (or paste it in the agy terminal).',
            '',
            'Antigravity IDE users: use the account menu in the IDE instead.'
        ].join('\n') : 'agy CLI not found in ~/.gemini/bin. In the Antigravity IDE, use its account menu to sign in as the other account. Quota Nexus picks it up automatically.';
        const pick = await vscode.window.showInformationMessage(`Switch to ${who}`, { modal: true, detail }, ...(agy ? ['Sign Out and Switch'] : []));
        if (pick !== 'Sign Out and Switch') return;
        // agy has no ready signal, so keys are paced. Sign out in one session, then a fresh one opens its sign-in menu.
        if (this.connected) {
            const out = await this.agyTerminal(agy, 'Antigravity sign-out');
            out.sendText('/logout', false);
            await sleep(400);
            out.sendText('\r', false);
            await sleep(SIGNIN_STEP_MS);
            out.sendText('\r', false);
            await sleep(SIGNIN_STEP_MS);
            out.dispose();
        }
        const t = await this.agyTerminal(agy, 'Antigravity sign-in');
        t.sendText('\r', false);
        this.offerCodePaste(t);
    }

    async agyTerminal(agy, name) {
        const t = vscode.window.createTerminal({ name, shellPath: agy });
        t.show();
        await t.processId;
        await sleep(SIGNIN_START_MS);
        return t;
    }

    // The code goes straight from the clipboard into agy's own prompt; it is never stored or logged.
    async offerCodePaste(t) {
        const pick = await vscode.window.showInformationMessage(
            'Pick your account in the browser, click Continue, then copy the code Google shows.', 'Paste Code', 'Cancel');
        if (pick !== 'Paste Code') return;
        const code = (await vscode.env.clipboard.readText()).trim();
        if (!AUTH_CODE_RE.test(code)) {
            const again = await vscode.window.showWarningMessage('The clipboard does not hold a Google sign-in code. Copy the code from the browser page and try again.', 'Paste Code');
            if (again === 'Paste Code') return this.offerCodePaste(t);
            return;
        }
        t.show();
        t.sendText(code, false);
        await sleep(200);
        t.sendText('\r', false);
        // The new sign-in may come up as a new agy server; look again once it has started.
        setTimeout(() => { this.agy.rediscoverSoon(); this.refresh(); }, SIGNIN_RESCAN_MS);
    }

    showDiagnostics() {
        const d = this.agy.diag;
        const srv = this.agy.server;
        const exists = p => (fs.existsSync(path.join(this.home, ...p)) ? 'found' : 'not found');
        const snooze = this.snoozedUntil();
        const lines = [
            '--- Diagnostics ---',
            `Quota Nexus ${this.context.extension.packageJSON.version} on ${process.platform}, VS Code ${vscode.version}`,
            `Antigravity: ${this.connected && srv ? `connected (pid ${srv.pid}, port ${srv.port})` : 'not connected'}`,
            `  processes found: ${d.processes}, ports probed: ${d.probed}, last discovery: ${formatAgo(d.lastDiscoveryAt)}`,
            `  last success: ${formatAgo(d.lastOkAt)}${d.lastError ? `, last problem: ${d.lastError}` : ''}`,
            `  agy CLI in ~/.gemini/bin: ${this.agyPath() ? 'found' : 'not found'}`,
            `Claude Code logs (~/.claude/projects): ${exists(['.claude', 'projects'])}, session: ${this.ccContext ? 'found' : 'none'}`,
            `Claude Code limits: ${cfg.get('claudeCode.fetchUsageLimits', false) ? (this.ccUsageError || (this.ccUsage ? 'ok' : 'pending')) : 'off (opt-in)'}${this.ccUsageUntil > Date.now() ? `, next try in ${formatCountdown(new Date(this.ccUsageUntil).toISOString())}` : ''}`,
            `Codex logs (~/.codex/sessions): ${exists(['.codex', 'sessions'])}, session: ${this.codexData && this.codexData.context ? 'found' : 'none'}, limits: ${this.codexData && this.codexData.limits ? 'found' : 'none'}`,
            `Last refresh: ${formatAgo(this.updatedAt)}, took ${this.lastRefreshMs} ms`,
            `Alerts: ${cfg.get('alerts.enabled', true) ? 'on' : 'off'}${snooze > Date.now() ? `, snoozed for ${formatCountdown(new Date(snooze).toISOString())}` : ''}`
        ];
        for (const l of lines) this.log.info(l);
        this.log.show(true);
    }

    watch() {
        // Throttle, not debounce: an active session writes nonstop, so a debounce never fired.
        const throttled = (fn, ms = WATCH_THROTTLE_MS) => {
            let t = null;
            return () => {
                if (!t) t = setTimeout(() => { t = null; fn(); }, ms);
            };
        };
        const add = (dir, opts, filter, fn) => {
            try {
                if (!fs.existsSync(dir)) return;
                const w = fs.watch(dir, opts, (_e, name) => { if (!name || filter(String(name))) fn(); });
                w.on('error', () => w.close());
                this.watchers.push(w);
            } catch (e) {
                this.log.info(`File watch unavailable for ${path.basename(dir)}; polling only`);
            }
        };
        add(path.join(this.home, '.claude', 'projects'), { recursive: true }, n => n.endsWith('.jsonl'), throttled(async () => {
            if (!cfg.get('claudeCode.enable', true)) return;
            this.ccContext = await this.claude.read(this.wsPaths()).catch(() => this.ccContext);
            this.render();
        }));
        add(path.join(this.home, '.codex', 'sessions'), { recursive: true }, n => n.endsWith('.jsonl'), throttled(async () => {
            if (!cfg.get('codex.enable', true)) return;
            this.codexData = await this.codexReader.read(this.wsPaths()).catch(() => this.codexData);
            this.runToolAlerts();
            this.render();
        }));
        // Activity here means agy is up: find it if new, and keep its quota fresh while in use.
        add(path.join(this.home, '.gemini', 'antigravity', 'conversations'), {}, n => !n.endsWith('-shm'), throttled(async () => {
            if (!this.agEnabled()) return;
            if (!this.connected || Date.now() - this.agStatusAt > AG_STATUS_MS) return this.refresh();
            if (!this.wantAgContext() || !this.status) return;
            this.agContext = await this.agy.getContext(this.wsPaths(), this.status.modelLabels).catch(() => this.agContext);
            this.render();
        }, AG_WATCH_MS));
    }

    dispose() {
        clearTimeout(this.startTimer);
        clearInterval(this.timer);
        clearInterval(this.tickTimer);
        clearTimeout(this.renderTimer);
        this.history.save(true);
        for (const w of this.watchers) {
            try { w.close(); } catch (e) { /* already closed */ }
        }
        this.watchers = [];
    }
}

function activate(context) {
    new Nexus(context).start();
}

function deactivate() {}

module.exports = { activate, deactivate };
