'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const { AgyClient } = require('./agyClient');
const { ClaudeContextReader, fetchClaudeUsage } = require('./claudeCode');
const { CodexReader } = require('./codex');
const { Accounts } = require('./accounts');
const { evaluateAlerts } = require('./alerts');
const { History } = require('./history');
const { buildViewState, seriesId, claudeWindows, codexWindows } = require('./viewState');
const { StatusBar } = require('./statusBar');
const { DashboardProvider } = require('./webview');
const { maskEmail, formatCountdown, formatAgo } = require('./util');

const ALERTS_KEY = 'nexus.alerts.v1';
const SNOOZE_KEY = 'nexus.alertsSnooze';
const SNOOZE_MS = 3600e3;
const USAGE_MIN_GAP_MS = 5 * 60000;
const WATCH_DEBOUNCE_MS = 1500;

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
        this.ccUsageAt = 0;
        this.codexData = null;
        this.updatedAt = 0;
        this.lastRefreshMs = 0;
        this.inFlight = null;
        this.timer = null;
        this.startTimer = null;
        this.renderTimer = null;
        this.watchers = [];
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
                const refetch = ['claudeCode', 'codex', 'contextWindow'].some(k => e.affectsConfiguration(`${cfg.SECTION}.${k}`));
                if (refetch) this.refresh(true);
                else this.render();
            }),
            vscode.window.onDidChangeWindowState(s => {
                if (s.focused && Date.now() - this.updatedAt > cfg.interval()) this.refresh();
            }),
            cmd('quotaNexus.refresh', () =>
                vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Quota Nexus: refreshing' }, () => this.refresh(true))),
            cmd('quotaNexus.switchAccount', () => this.pickAccount()),
            cmd('quotaNexus.signIn', () => this.guidedSignIn(null)),
            cmd('quotaNexus.toggleMask', () => cfg.set('privacy.maskEmails', !cfg.get('privacy.maskEmails', true))),
            cmd('quotaNexus.snoozeAlerts', () => this.toggleSnooze()),
            cmd('quotaNexus.showDiagnostics', () => this.showDiagnostics()),
            cmd('quotaNexus.openSettings', () =>
                vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${c.extension.id}`)),
            { dispose: () => this.dispose() }
        );
        this.log.info(`Quota Nexus ${c.extension.packageJSON.version} started on ${process.platform}`);
        this.watch();
        this.schedule();
        this.render();
        this.startTimer = setTimeout(() => this.refresh(), 1000);
    }

    schedule() {
        clearInterval(this.timer);
        this.timer = setInterval(() => {
            if (cfg.get('refresh.pauseWhenUnfocused', true) && !vscode.window.state.focused) return;
            this.refresh();
        }, cfg.interval());
    }

    refresh(force) {
        if (force) this.ccUsageAt = 0;
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

    wantAgContext() {
        return cfg.get('contextWindow.showAntigravity', true) && cfg.get('contextWindow.display', 'auto') !== 'off';
    }

    async doRefresh() {
        const started = Date.now();
        const ws = this.wsPaths();
        const agyTask = (async () => {
            const s = await this.agy.getStatus();
            const ctx = s && this.wantAgContext() ? await this.agy.getContext(ws, s.modelLabels).catch(() => null) : null;
            return { s, ctx };
        })();
        const ccTask = cfg.get('claudeCode.enable', true) ? this.claude.read(ws) : Promise.resolve(null);
        const cxTask = cfg.get('codex.enable', true) ? this.codexReader.read(ws) : Promise.resolve(null);
        const [agy, cc, cx, usage] = await Promise.allSettled([agyTask, ccTask, cxTask, this.refreshUsage()]);
        for (const [name, r] of [['Antigravity', agy], ['Claude Code logs', cc], ['Codex logs', cx], ['Claude Code limits', usage]]) {
            if (r.status === 'rejected') this.log.warn(`${name}: ${r.reason && r.reason.message}`);
        }

        if (agy.status === 'fulfilled' && agy.value.s) {
            this.onStatus(agy.value.s);
            this.agContext = agy.value.ctx;
        } else {
            this.connected = false;
            this.agContext = null;
        }
        if (cc.status === 'fulfilled') this.ccContext = cc.value;
        if (cx.status === 'fulfilled') this.codexData = cx.value;
        this.runToolAlerts();
        this.updatedAt = Date.now();
        this.lastRefreshMs = this.updatedAt - started;
        this.render();
    }

    async refreshUsage() {
        if (!cfg.get('claudeCode.enable', true) || !cfg.get('claudeCode.fetchUsageLimits', false)) {
            this.ccUsage = null;
            this.ccUsageError = '';
            return;
        }
        if (Date.now() - this.ccUsageAt < Math.max(USAGE_MIN_GAP_MS, cfg.interval())) return;
        this.ccUsageAt = Date.now();
        const r = await fetchClaudeUsage(this.home);
        if (r.error) {
            if (r.error !== this.ccUsageError) this.log.warn(`Claude Code limits: ${r.error}`);
            this.ccUsageError = r.error;
        } else {
            this.ccUsage = r;
            this.ccUsageError = '';
        }
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
        if (lim) {
            const fresh = codexWindows(lim).filter(w => !(Date.parse(w.resetsAt || '') <= Date.now()));
            this.runAlerts('codex', usedToPools(fresh, 'Codex'), []);
        }
    }

    snoozedUntil() {
        return this.context.globalState.get(SNOOZE_KEY) || 0;
    }

    toggleSnooze() {
        const on = this.snoozedUntil() > Date.now();
        this.context.globalState.update(SNOOZE_KEY, on ? 0 : Date.now() + SNOOZE_MS);
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
                else if (pick === 'Snooze 1 Hour') this.context.globalState.update(SNOOZE_KEY, Date.now() + SNOOZE_MS);
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
            connected: this.connected,
            status: this.status,
            accounts: this.accounts.all(),
            agContext: this.agContext,
            claude: {
                enabled: ccEnabled,
                usageEnabled: ccEnabled && fetchUsage,
                context: this.ccContext,
                usage: this.ccUsage,
                usageError: this.ccUsageError
            },
            codex: { enabled: cxEnabled, data: this.codexData },
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
            showClaudeUsage: cfg.get('claudeCode.showInNavBar', true),
            showCodexUsage: cfg.get('codex.showInNavBar', true),
            showAgContext: cfg.get('contextWindow.showAntigravity', true),
            showCcContext: ccEnabled && cfg.get('claudeCode.showContextWindow', true),
            showCxContext: cxEnabled && cfg.get('codex.showContextWindow', true),
            contextDisplay: cfg.get('contextWindow.display', 'auto')
        });
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

    // Quota Nexus never stores or moves sign-in tokens; switching uses Antigravity's own sign-in.
    async guidedSignIn(targetEmail) {
        const who = targetEmail ? maskEmail(targetEmail, cfg.get('privacy.maskEmails', true)) : 'another Google account';
        const agy = this.agyPath();
        const detail = [
            `Sign out of Antigravity, then sign in again as ${who}.`,
            '',
            'agy CLI: type /logout in an agy session, then follow the sign-in prompt.',
            'Antigravity IDE: use the account menu in the IDE.',
            '',
            'Quota Nexus picks up the new account automatically.'
        ].join('\n');
        const pick = await vscode.window.showInformationMessage(`Switch to ${who}`, { modal: true, detail }, ...(agy ? ['Open agy Terminal'] : []));
        if (pick === 'Open agy Terminal') {
            const t = vscode.window.createTerminal({ name: 'Antigravity sign-in', shellPath: agy });
            t.show();
        }
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
            `Claude Code limits: ${cfg.get('claudeCode.fetchUsageLimits', false) ? (this.ccUsageError || (this.ccUsage ? 'ok' : 'pending')) : 'off (opt-in)'}`,
            `Codex logs (~/.codex/sessions): ${exists(['.codex', 'sessions'])}, session: ${this.codexData && this.codexData.context ? 'found' : 'none'}, limits: ${this.codexData && this.codexData.limits ? 'found' : 'none'}`,
            `Last refresh: ${formatAgo(this.updatedAt)}, took ${this.lastRefreshMs} ms`,
            `Alerts: ${cfg.get('alerts.enabled', true) ? 'on' : 'off'}${snooze > Date.now() ? `, snoozed for ${formatCountdown(new Date(snooze).toISOString())}` : ''}`
        ];
        for (const l of lines) this.log.info(l);
        this.log.show(true);
    }

    watch() {
        const debounced = (fn) => {
            let t = null;
            return () => { clearTimeout(t); t = setTimeout(fn, WATCH_DEBOUNCE_MS); };
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
        add(path.join(this.home, '.claude', 'projects'), { recursive: true }, n => n.endsWith('.jsonl'), debounced(async () => {
            if (!cfg.get('claudeCode.enable', true)) return;
            this.ccContext = await this.claude.read(this.wsPaths()).catch(() => this.ccContext);
            this.render();
        }));
        add(path.join(this.home, '.codex', 'sessions'), { recursive: true }, n => n.endsWith('.jsonl'), debounced(async () => {
            if (!cfg.get('codex.enable', true)) return;
            this.codexData = await this.codexReader.read(this.wsPaths()).catch(() => this.codexData);
            this.runToolAlerts();
            this.render();
        }));
        add(path.join(this.home, '.gemini', 'antigravity', 'conversations'), {}, () => true, debounced(async () => {
            if (!this.connected || !this.wantAgContext() || !this.status) return;
            this.agContext = await this.agy.getContext(this.wsPaths(), this.status.modelLabels).catch(() => this.agContext);
            this.render();
        }));
    }

    dispose() {
        clearTimeout(this.startTimer);
        clearInterval(this.timer);
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
