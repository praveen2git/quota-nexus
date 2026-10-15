'use strict';

const vscode = require('vscode');
const { textBar, escapeMarkdown: esc, formatTokens } = require('./util');

const FOCUS_CMD = 'quotaNexus.dashboard.focus';
const TOGGLE_CMD = 'quotaNexus.togglePercentMode';
const FOOTER = `[Open Quota Nexus](command:${FOCUS_CMD})`;
const MODE_LINK = `command:${TOGGLE_CMD}`;
// Short formats carry an arrow: down = left, up = used.
const MARK = { left: '↓', used: '↑' };
const OTHER = { left: 'used', used: 'left' };
// Auto shows every session used this recently, so parallel tools all stay visible.
const AUTO_RECENT_MS = 15 * 60000;
const SOURCE = {
    antigravity: { tag: 'AG', label: 'Antigravity' },
    claudeCode: { tag: 'CC', label: 'Claude Code' },
    codex: { tag: 'CX', label: 'Codex' }
};

function tooltip() {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: [FOCUS_CMD, TOGGLE_CMD] };
    return md;
}

function resetText(w, full) {
    if (full) return 'not used';
    if (w.estimated) return 'likely reset';
    return w.countdown ? `${w.countdown} (${w.wall})` : '';
}

function stripIcons(s) {
    return String(s || '').replace(/\$\(/g, '$ (');
}

function pctOf(x, mode) {
    return `${x.estimated ? '~' : ''}${x[mode]}%`;
}

function barPct(x, mode, format) {
    return pctOf(x, mode) + (format === 'descriptive' ? '' : MARK[mode]);
}

function poolsText(pools, format, mode) {
    const items = pools.map(p => `${format === 'descriptive' ? p.name : p.short} ${barPct(p, mode, format)}`);
    if (format === 'minimal') return items.join(' | ');
    if (format === 'compact') return 'AG: ' + items.join(' · ');
    return `Antigravity: ${items.join(' · ')} ${mode}`;
}

// Limit windows: first is the short window, the rest prefixed by name.
function limitText(tool, windows, format, mode) {
    const name = { CC: 'Claude Code', CX: 'Codex' }[tool];
    const pct = w => barPct(w, mode, format);
    const body = windows.map((w, i) => (i === 0 ? pct(w) : `${w.name === 'Weekly' ? 'wk' : w.name} ${pct(w)}`)).join(' · ');
    if (format === 'minimal') return `${tool} ${body}`;
    if (format === 'compact') return `${tool}: ${body}`;
    return `${name}: ${body} ${mode}`;
}

function heading(mode) {
    return mode === 'used' ? 'Used' : 'Left';
}

// e.g. "43% (57% used)"
function bothCell(x, mode) {
    return `${pctOf(x, mode)} (${x[OTHER[mode]]}% ${OTHER[mode]})`;
}

function forecastLines(md, items) {
    const lines = items.filter(x => x.forecast).map(x => `- **${esc(x.name)}**: ${esc(x.forecast)}`);
    if (lines.length) md.appendMarkdown(lines.join('\n') + '\n\n');
}

function limitTable(md, title, windows, note, mode, first) {
    md.appendMarkdown(`${first ? '' : '---\n\n'}### ${title}\n\n`);
    if (note) md.appendMarkdown(`${esc(note)}\n\n`);
    md.appendMarkdown(`| Window | | ${heading(mode)} | Resets |\n|:--|:--|--:|--:|\n`);
    for (const w of windows) {
        md.appendMarkdown(`| **${esc(w.name)}** | ${textBar(w[mode])} | ${bothCell(w, mode)} | ${esc(resetText(w, w.left >= 100 && !w.estimated))} |\n`);
    }
    md.appendMarkdown('\n');
    forecastLines(md, windows);
}

// Context pct is "used"; derive both so it follows Percent Mode like quotas.
function ctxPct(c) {
    const used = Math.round(c.pct * 10) / 10;
    return { used, left: Math.round((100 - used) * 10) / 10 };
}

function contextRows(md, c, mode) {
    const src = SOURCE[c.source] || { label: c.source };
    const n = ctxPct(c);
    const o = OTHER[mode];
    md.appendMarkdown(`**Context window** - ${esc(c.model)} (${src.label})\n\n`);
    md.appendMarkdown('| | |\n|:--|--:|\n');
    md.appendMarkdown(`| ${textBar(n[mode], 16)} | **${n[mode].toFixed(1)}%** ${mode} (${n[o].toFixed(1)}% ${o}) |\n`);
    md.appendMarkdown(`| Used | ${formatTokens(c.usedTokens)} |\n`);
    if (c.inputTokens) md.appendMarkdown(`| Input | ${formatTokens(c.inputTokens)} |\n`);
    if (c.cacheReadTokens) md.appendMarkdown(`| From cache | ${formatTokens(c.cacheReadTokens)} |\n`);
    if (c.thinkingTokens) md.appendMarkdown(`| Thinking | ${formatTokens(c.thinkingTokens)} |\n`);
    if (c.outputTokens) md.appendMarkdown(`| Output | ${formatTokens(c.outputTokens)} |\n`);
    md.appendMarkdown(`| Left${c.windowExact ? '' : ' (est.)'} | ${esc(c.left)} |\n\n`);
    if (c.pct >= 80) {
        md.appendMarkdown(c.source === 'codex'
            ? '*Nearly full: start a new session or run `/compact`.*\n\n'
            : '*Nearly full: `/compact` to keep going, `/clear` for a new task.*\n\n');
    }
}

class StatusBar {
    constructor() {
        this.quota = vscode.window.createStatusBarItem('quotaNexus.quota', vscode.StatusBarAlignment.Right, 95);
        this.quota.name = 'Quota Nexus';
        this.quota.command = FOCUS_CMD;
        this.ctx = vscode.window.createStatusBarItem('quotaNexus.context', vscode.StatusBarAlignment.Right, 94);
        this.ctx.name = 'Quota Nexus Context Window';
        this.ctx.command = FOCUS_CMD;
    }

    update(v, opt) {
        this.updateQuota(v, opt);
        this.updateContext(v, opt);
    }

    updateQuota(v, opt) {
        const item = this.quota;
        if (!opt.show) return item.hide();
        const mode = v.percentMode === 'left' ? 'left' : 'used';
        const parts = [];
        if (opt.showAgUsage !== false && v.active && v.active.pools.length) parts.push(poolsText(v.active.pools, opt.format, mode));
        if (opt.showClaudeUsage && v.claude.windows.length) parts.push(limitText('CC', v.claude.windows, opt.format, mode));
        if (opt.showCodexUsage && v.codex.windows.length && !v.codex.idle) parts.push(limitText('CX', v.codex.windows, opt.format, mode));
        const prefix = opt.showEmail && v.active ? `${stripIcons(v.active.display)} | ` : '';
        const icon = v.connecting && !parts.length ? '$(sync~spin)' : '$(dashboard)';
        item.text = parts.length ? `${icon} ${prefix}${stripIcons(parts.join(' | '))}` : `${icon} Quota Nexus`;

        const low = Math.min(...opt.thresholds, 100);
        const warn = Math.max(...opt.thresholds, 0);
        item.backgroundColor = v.minPct === null ? undefined
            : v.minPct <= low ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : v.minPct <= warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

        const md = tooltip();
        if (v.active) {
            md.appendMarkdown(`### Antigravity quota\n\n${esc(v.active.display)} · **${esc(v.active.planName)}**\n\n`);
            md.appendMarkdown(`| Pool | | ${heading(mode)} | Resets |\n|:--|:--|--:|--:|\n`);
            for (const p of v.active.pools) {
                md.appendMarkdown(`| **${esc(p.name)}** | ${textBar(p[mode])} | ${bothCell(p, mode)} | ${esc(resetText(p, p.pct >= 100))} |\n`);
            }
            md.appendMarkdown('\n');
            forecastLines(md, v.active.pools);
        }
        // Tools with data first; anything missing or idle goes in the notes at the bottom.
        let first = !v.active;
        const section = (title, wins, note) => {
            limitTable(md, title, wins, note, mode, first);
            first = false;
        };
        if (v.claude.windows.length) section('Claude Code limits', v.claude.windows, v.claude.usageError ? `${v.claude.usageError} · as of ${v.claude.usageAgo}` : '');
        if (v.codex.windows.length && !v.codex.idle) {
            section('Codex limits', v.codex.windows, [v.codex.plan && `Plan: ${v.codex.plan}`, v.codex.credits, `as of ${v.codex.asOfAgo}`].filter(Boolean).join(' · '));
        }
        const missing = [];
        if (!v.active && v.antigravityEnabled !== false) missing.push(v.connecting ? '*Looking for Antigravity...*' : '*Antigravity not detected - start `agy` or the Antigravity IDE.*');
        if (v.claude.usageError && !v.claude.windows.length) missing.push(`*Claude Code limits: ${esc(v.claude.usageError)}*`);
        if (v.codex.idle) missing.push(`*Codex not used for ${esc(v.codex.lastUsedAgo.replace(/ ago$/, ''))} - hidden until it runs again.*`);
        if (first && !missing.length) md.appendMarkdown('### Quota Nexus\n\nNo quota data yet.\n\n');
        if (missing.length) md.appendMarkdown(`${first ? '' : '---\n\n'}${missing.join('\n\n')}\n\n`);
        md.appendMarkdown(`*Percentages show what is ${mode} (${MARK[mode]}). Updated ${esc(v.updatedAgo)}.* · [Show ${OTHER[mode]} instead](${MODE_LINK}) · ${FOOTER}`);
        item.tooltip = md;
        item.show();
    }

    updateContext(v, opt) {
        const item = this.ctx;
        const all = {
            antigravity: opt.showAgContext ? v.agContext : null,
            claudeCode: opt.showCcContext ? v.claude.context : null,
            codex: opt.showCxContext && !v.codex.idle ? v.codex.context : null
        };
        const display = opt.contextDisplay;
        const mode = v.percentMode === 'left' ? 'left' : 'used';
        const byRecency = Object.values(all).filter(Boolean).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        let shown;
        if (display === 'off') shown = [];
        else if (display === 'all') shown = byRecency;
        else if (display === 'auto') {
            const recent = byRecency.filter(c => Date.now() - (c.timestamp || 0) <= AUTO_RECENT_MS);
            shown = recent.length ? recent : byRecency.slice(0, 1);
        }
        else shown = all[display] ? [all[display]] : [];
        if (!shown.length) return item.hide();

        const tag = c => (SOURCE[c.source] || { tag: '?' }).tag;
        const pct = c => `${Math.round(ctxPct(c)[mode])}%${MARK[mode]}`;
        item.text = shown.length > 1
            ? `$(layers) ${shown.map(c => `${tag(c)} ${pct(c)}`).join(' · ')}`
            : opt.format === 'minimal' ? `$(layers) ${pct(shown[0])}` : `$(layers) ${tag(shown[0])} ${pct(shown[0])}`;

        const peak = Math.max(...shown.map(c => c.pct));
        item.backgroundColor = peak >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : peak >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

        const md = tooltip();
        for (const c of display === 'auto' ? byRecency : shown) contextRows(md, c, mode);
        md.appendMarkdown(`*Sizes marked est. are estimates.* · ${FOOTER}`);
        item.tooltip = md;
        item.show();
    }

    dispose() {
        this.quota.dispose();
        this.ctx.dispose();
    }
}

module.exports = { StatusBar };
