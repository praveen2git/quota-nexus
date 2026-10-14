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

const win = (name, used, extra) => Object.assign({ id: name, name, pct: used, left: 100 - used, estimated: false, countdown: '1h 0m', wall: '3:00 PM', forecast: '' }, extra);

function view(codexIdle) {
    return {
        active: { display: 'a****@x.com', planName: 'Pro', pools: [
            { id: 'gemini', name: 'Gemini', short: 'Gem', pct: 100, countdown: '', wall: '', forecast: '' },
            { id: 'claude-gpt-oss', name: 'Claude / GPT-OSS', short: 'Cl/GPT', pct: 22, countdown: '1d 23h', wall: 'Fri 3:58 PM', forecast: '' }
        ] },
        claude: { windows: [win('5-hour', 30), win('Weekly', 50)], context: null },
        codex: { windows: [win('30-day', 0, { estimated: true, countdown: '', wall: '' })], context: { source: 'codex', pct: 30, model: 'gpt', inputTokens: 1, cacheReadTokens: 1, left: '1 / 2', timestamp: 2 }, idle: codexIdle, lastUsedAgo: '37d ago', plan: 'go', credits: null, asOfAgo: '37d ago' },
        agContext: null,
        updatedAgo: 'just now',
        minPct: 22
    };
}

const OPT = { show: true, showEmail: false, thresholds: [20, 5], showClaudeUsage: true, showCodexUsage: true, showAgContext: true, showCcContext: true, showCxContext: true, contextDisplay: 'auto' };

test('status bar shows percent LEFT for every tool', () => {
    const { bar, items } = loadStatusBar();
    bar.update(view(false), { ...OPT, format: 'descriptive' });
    assert.strictEqual(items[0].text, '$(dashboard) Antigravity: Gemini 100% · Claude / GPT-OSS 22% left | Claude Code: 70% · wk 50% left | Codex: ~100% left');
    assert.match(items[0].tooltip.value, /\| Window \| \| Left \| Resets \|/);
    assert.match(items[0].tooltip.value, /Percentages show what is left/);
    bar.update(view(false), { ...OPT, format: 'compact' });
    assert.strictEqual(items[0].text, '$(dashboard) AG: Gem 100% · Cl/GPT 22% | CC: 70% · wk 50% | CX: ~100%');
});

test('idle Codex stays off the status bar and the context item', () => {
    const { bar, items } = loadStatusBar();
    bar.update(view(true), { ...OPT, format: 'minimal' });
    assert.strictEqual(items[0].text, '$(dashboard) Gem 100% | Cl/GPT 22% | CC 70% · wk 50%');
    assert.match(items[0].tooltip.value, /Codex not used for 37d/);
    assert.strictEqual(items[1].visible, false, 'no Codex context item when idle');
});
