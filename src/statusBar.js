'use strict';

const vscode = require('vscode');
const { textBar, escapeMarkdown: esc, formatTokens } = require('./util');

const FOCUS_CMD = 'quotaNexus.dashboard.focus';
const FOOTER = `[Open Quota Nexus](command:${FOCUS_CMD})`;
const SOURCE = {
    antigravity: { tag: 'AG', label: 'Antigravity' },
    claudeCode: { tag: 'CC', label: 'Claude Code' },
    codex: { tag: 'CX', label: 'Codex' }
};

function tooltip() {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: [FOCUS_CMD] };
    return md;
}

function resetText(w, full) {
    if (full) return 'full';
    if (w.estimated) return 'likely reset';
    return w.countdown ? `${w.countdown} (${w.wall})` : '';
}

function stripIcons(s) {
    return String(s || '').replace(/\$\(/g, '$ (');
}

// Every percentage in the status bar is what is LEFT, so colours and numbers agree.
function poolsText(pools, format) {
    if (format === 'minimal') return pools.map(p => `${p.short} ${p.pct}%`).join(' | ');
    if (format === 'compact') return 'AG: ' + pools.map(p => `${p.short} ${p.pct}%`).join(' · ');
    return 'Antigravity: ' + pools.map(p => `${p.name} ${p.pct}%`).join(' · ') + ' left';
}

// Limit windows: first is the short window, the rest prefixed by name.
function leftText(tool, windows, format) {
    const name = { CC: 'Claude Code', CX: 'Codex' }[tool];
    const pct = w => `${w.estimated ? '~' : ''}${w.left}%`;
    const body = windows.map((w, i) => (i === 0 ? pct(w) : `${w.name === 'Weekly' ? 'wk' : w.name} ${pct(w)}`)).join(' · ');
    if (format === 'minimal') return `${tool} ${body}`;
    if (format === 'compact') return `${tool}: ${body}`;
    return `${name}: ${body} left`;
}

function forecastLines(md, items) {
    const lines = items.filter(x => x.forecast).map(x => `- **${esc(x.name)}**: ${esc(x.forecast)}`);
    if (lines.length) md.appendMarkdown(lines.join('\n') + '\n\n');
}

function leftTable(md, title, windows, note) {
    md.appendMarkdown(`---\n\n### ${title}\n\n`);
    if (note) md.appendMarkdown(`${esc(note)}\n\n`);
    md.appendMarkdown('| Window | | Left | Resets |\n|:--|:--|--:|--:|\n');
    for (const w of windows) {
        md.appendMarkdown(`| **${esc(w.name)}** | ${textBar(w.left)} | ${w.estimated ? '~' : ''}${w.left}% | ${esc(resetText(w, w.left >= 100 && !w.estimated))} |\n`);
    }
    md.appendMarkdown('\n');
    forecastLines(md, windows);
}

function contextRows(md, c) {
    const src = SOURCE[c.source] || { label: c.source };
    md.appendMarkdown(`**Context window** - ${esc(c.model)} (${src.label})\n\n`);
    md.appendMarkdown('| | |\n|:--|--:|\n');
    md.appendMarkdown(`| ${textBar(c.pct, 16)} | **${c.pct.toFixed(1)}%** full |\n`);
    md.appendMarkdown(`| Input tokens | ${formatTokens(c.inputTokens)} |\n`);
    md.appendMarkdown(`| Cache read | ${formatTokens(c.cacheReadTokens)} |\n`);
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
        const parts = [];
        if (v.active && v.active.pools.length) parts.push(poolsText(v.active.pools, opt.format));
        if (opt.showClaudeUsage && v.claude.windows.length) parts.push(leftText('CC', v.claude.windows, opt.format));
        if (opt.showCodexUsage && v.codex.windows.length && !v.codex.idle) parts.push(leftText('CX', v.codex.windows, opt.format));
        const prefix = opt.showEmail && v.active ? `${stripIcons(v.active.display)} | ` : '';
        item.text = parts.length ? `$(dashboard) ${prefix}${stripIcons(parts.join(' | '))}` : '$(dashboard) Quota Nexus';

        const low = Math.min(...opt.thresholds, 100);
        const warn = Math.max(...opt.thresholds, 0);
        item.backgroundColor = v.minPct === null ? undefined
            : v.minPct <= low ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : v.minPct <= warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

        const md = tooltip();
        if (v.active) {
            md.appendMarkdown(`### Antigravity quota\n\n${esc(v.active.display)} · **${esc(v.active.planName)}**\n\n`);
            md.appendMarkdown('| Pool | | Left | Resets |\n|:--|:--|--:|--:|\n');
            for (const p of v.active.pools) {
                md.appendMarkdown(`| **${esc(p.name)}** | ${textBar(p.pct)} | ${p.pct}% | ${esc(resetText(p, p.pct >= 100))} |\n`);
            }
            md.appendMarkdown('\n');
            forecastLines(md, v.active.pools);
        } else {
            md.appendMarkdown('### Antigravity not detected\n\nStart `agy` or the Antigravity IDE and Quota Nexus will connect.\n\n');
        }
        if (v.claude.windows.length) leftTable(md, 'Claude Code limits', v.claude.windows, '');
        if (v.codex.windows.length && !v.codex.idle) {
            const note = [v.codex.plan && `Plan: ${v.codex.plan}`, v.codex.credits, `as of ${v.codex.asOfAgo}`].filter(Boolean).join(' · ');
            leftTable(md, 'Codex limits', v.codex.windows, note);
        } else if (v.codex.idle) {
            md.appendMarkdown(`---\n\n*Codex not used for ${esc(v.codex.lastUsedAgo.replace(/ ago$/, ''))} - hidden until it runs again.*\n\n`);
        }
        md.appendMarkdown(`*Percentages show what is left. Updated ${esc(v.updatedAgo)}.* · ${FOOTER}`);
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
        const mode = opt.contextDisplay;
        const byRecency = Object.values(all).filter(Boolean).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        let shown;
        if (mode === 'off') shown = [];
        else if (mode === 'all') shown = byRecency;
        else if (mode === 'auto') shown = byRecency.slice(0, 1);
        else shown = all[mode] ? [all[mode]] : [];
        if (!shown.length) return item.hide();

        const tag = c => (SOURCE[c.source] || { tag: '?' }).tag;
        item.text = shown.length > 1
            ? `$(layers) ${shown.map(c => `${tag(c)} ${Math.round(c.pct)}%`).join(' · ')}`
            : opt.format === 'minimal' ? `$(layers) ${Math.round(shown[0].pct)}%` : `$(layers) ${tag(shown[0])} ${Math.round(shown[0].pct)}%`;

        const peak = Math.max(...shown.map(c => c.pct));
        item.backgroundColor = peak >= 95 ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : peak >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

        const md = tooltip();
        for (const c of mode === 'auto' ? byRecency : shown) contextRows(md, c);
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
