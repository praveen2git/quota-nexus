'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function loadStatusBar() {
    const items = [];
    const vscode = {
        StatusBarAlignment: { Right: 2 },
        ThemeColor: class { constructor(id) { this.id = id; } },
        MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } },
        window: {
            createStatusBarItem: () => {
                const it = { text: '', tooltip: null, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
                items.push(it);
                return it;
            }
        }
    };
    const orig = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
    try {
        delete require.cache[require.resolve('../src/statusBar')];
        const { StatusBar } = require('../src/statusBar');
        return { bar: new StatusBar(), items };
    } finally {
        Module._load = orig;
    }
}

const win = (name, used, extra) => Object.assign({ id: name, name, pct: used, left: 100 - used, used, estimated: false, countdown: '1h 0m', wall: '3:00 PM', forecast: '' }, extra);

function view(codexIdle, percentMode) {
    return {
        percentMode,
        active: { display: 'a****@x.com', planName: 'Pro', pools: [
            { id: 'gemini', name: 'Gemini', short: 'Gem', pct: 100, left: 100, used: 0, countdown: '', wall: '', forecast: '' },
            { id: 'claude-gpt-oss', name: 'Claude / GPT-OSS', short: 'Cl/GPT', pct: 22, left: 22, used: 78, countdown: '1d 23h', wall: 'Fri 3:58 PM', forecast: '' }
        ] },
        claude: { windows: [win('5-hour', 30), win('Weekly', 50)], context: null },
        codex: { windows: [win('30-day', 0, { estimated: true, countdown: '', wall: '' })], context: { source: 'codex', pct: 30, model: 'gpt', usedTokens: 1, inputTokens: 1, cacheReadTokens: 1, left: '1 / 2', timestamp: 2 }, idle: codexIdle, lastUsedAgo: '37d ago', plan: 'go', credits: null, asOfAgo: '37d ago' },
        agContext: null,
        updatedAgo: 'just now',
        minPct: 22
    };
}

const OPT = { show: true, showEmail: false, thresholds: [20, 5], showClaudeUsage: true, showCodexUsage: true, showAgContext: true, showCcContext: true, showCxContext: true, contextDisplay: 'auto' };

test('left mode shows percent LEFT for every tool', () => {
    const { bar, items } = loadStatusBar();
    bar.update(view(false, 'left'), { ...OPT, format: 'descriptive' });
    assert.strictEqual(items[0].text, '$(dashboard) Antigravity: Gemini 100% · Claude / GPT-OSS 22% left | Claude Code: 70% · wk 50% left | Codex: ~100% left');
    assert.match(items[0].tooltip.value, /\| Window \| \| Left \| Resets \|/);
    assert.match(items[0].tooltip.value, /\| 70% \(30% used\) \|/);
    assert.match(items[0].tooltip.value, /\| 22% \(78% used\) \|/);
    assert.match(items[0].tooltip.value, /Percentages show what is left \(↓\)/);
    assert.match(items[0].tooltip.value, /\[Show used instead\]\(command:quotaNexus\.togglePercentMode\)/);
    bar.update(view(false, 'left'), { ...OPT, format: 'compact' });
    assert.strictEqual(items[0].text, '$(dashboard) AG: Gem 100%↓ · Cl/GPT 22%↓ | CC: 70%↓ · wk 50%↓ | CX: ~100%↓');
});

test('used is the default and flips every number, column and arrow', () => {
    const { bar, items } = loadStatusBar();
    bar.update(view(false), { ...OPT, format: 'descriptive' });
    assert.strictEqual(items[0].text, '$(dashboard) Antigravity: Gemini 0% · Claude / GPT-OSS 78% used | Claude Code: 30% · wk 50% used | Codex: ~0% used');
    assert.match(items[0].tooltip.value, /\| Pool \| \| Used \| Resets \|/);
    assert.match(items[0].tooltip.value, /\| 30% \(70% left\) \|/);
    assert.match(items[0].tooltip.value, /\[Show left instead\]/);
    bar.update(view(false, 'used'), { ...OPT, format: 'minimal' });
    assert.strictEqual(items[0].text, '$(dashboard) Gem 0%↑ | Cl/GPT 78%↑ | CC 30%↑ · wk 50%↑ | CX ~0%↑');
    assert.strictEqual(items[0].backgroundColor, undefined, 'colour still follows what is left');
});

test('context window follows percent mode too', () => {
    const { bar, items } = loadStatusBar();
    const v = view(false, 'left');
    v.claude.context = { source: 'claudeCode', pct: 13.1, model: 'opus', usedTokens: 131300, inputTokens: 2, cacheReadTokens: 130900, left: '868.7K / 1M', timestamp: 9 };
    bar.update(v, { ...OPT, format: 'compact' });
    assert.strictEqual(items[1].text, '$(layers) CC 87%↓');
    assert.match(items[1].tooltip.value, /\*\*86\.9%\*\* left \(13\.1% used\)/);
    assert.match(items[1].tooltip.value, /\| Used \| 131\.3K \|/);
    assert.match(items[1].tooltip.value, /\| From cache \| 130\.9K \|/);
    assert.doesNotMatch(items[1].tooltip.value, /Input tokens/);
    bar.update({ ...v, percentMode: 'used' }, { ...OPT, format: 'minimal' });
    assert.strictEqual(items[1].text, '$(layers) 13%↑');
});

test('tools with data come first, missing ones are notes at the bottom', () => {
    const { bar, items } = loadStatusBar();
    bar.update({ ...view(true), active: null }, { ...OPT, format: 'minimal' });
    const md = items[0].tooltip.value;
    assert.ok(md.startsWith('### Claude Code limits'), md.slice(0, 40));
    const cc = md.indexOf('Claude Code limits');
    assert.ok(md.indexOf('Antigravity not detected') > cc);
    assert.ok(md.indexOf('Codex not used for 37d') > md.indexOf('Antigravity not detected'));
});

test('idle Codex stays off the status bar and the context item', () => {
    const { bar, items } = loadStatusBar();
    bar.update(view(true, 'left'), { ...OPT, format: 'minimal' });
    assert.strictEqual(items[0].text, '$(dashboard) Gem 100%↓ | Cl/GPT 22%↓ | CC 70%↓ · wk 50%↓');
    assert.match(items[0].tooltip.value, /Codex not used for 37d/);
    assert.strictEqual(items[1].visible, false, 'no Codex context item when idle');
});

test('auto shows every session active in the last 15 minutes, tagged', () => {
    const { bar, items } = loadStatusBar();
    const now = Date.now();
    const ctx = (source, pct, ago) => ({ source, pct, model: 'm', usedTokens: 1, cacheReadTokens: 0, left: '1 / 2', timestamp: now - ago });
    const v = view(false, 'used');
    v.claude.context = ctx('claudeCode', 18, 60e3);
    v.agContext = ctx('antigravity', 3, 10e3);
    v.codex.context = ctx('codex', 50, 3600e3);
    bar.update(v, { ...OPT, format: 'minimal' });
    assert.strictEqual(items[1].text, '$(layers) AG 3%↑ · CC 18%↑', 'newest first, old Codex left out');
    v.agContext = ctx('antigravity', 3, 20 * 60e3);
    bar.update(v, { ...OPT, format: 'minimal' });
    assert.strictEqual(items[1].text, '$(layers) 18%↑', 'one active session stays short');
});

test('while Antigravity is still being found, say so instead of "not detected"', () => {
    const { bar, items } = loadStatusBar();
    bar.update({ ...view(false), active: null, connecting: true }, { ...OPT, format: 'minimal' });
    assert.match(items[0].tooltip.value, /Looking for Antigravity/);
    assert.doesNotMatch(items[0].tooltip.value, /not detected/);
    assert.match(items[0].text, /^\$\(dashboard\) CC /, 'Claude shows without waiting');
    bar.update({ ...view(false), active: null, connecting: true, claude: { windows: [], context: null }, codex: { windows: [], context: null, idle: false } }, { ...OPT, format: 'minimal' });
    assert.strictEqual(items[0].text, '$(sync~spin) Quota Nexus');
});

test('Antigravity can be hidden from the status bar or turned off', () => {
    const { bar, items } = loadStatusBar();
    bar.update(view(false), { ...OPT, format: 'minimal', showAgUsage: false });
    assert.strictEqual(items[0].text, '$(dashboard) CC 30%↑ · wk 50%↑ | CX ~0%↑');
    assert.match(items[0].tooltip.value, /### Antigravity quota/, 'still in the hover');
    bar.update({ ...view(false), active: null, antigravityEnabled: false }, { ...OPT, format: 'minimal' });
    assert.doesNotMatch(items[0].tooltip.value, /Antigravity/, 'turned off: no "not detected" note');
});
