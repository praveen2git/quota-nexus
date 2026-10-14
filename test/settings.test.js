'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const pkg = require('../package.json');

function loadConfig(store) {
    const vscode = {
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        workspace: {
            getConfiguration: () => ({
                get: k => store.global[k],
                inspect: k => ({ globalValue: store.global[k], workspaceValue: store.workspace[k] }),
                update: async (k, v, target) => {
                    const s = target === 1 ? store.global : store.workspace;
                    if (v === undefined) delete s[k]; else s[k] = v;
                }
            })
        }
    };
    const orig = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
    try {
        delete require.cache[require.resolve('../src/config')];
        return require('../src/config');
    } finally {
        Module._load = orig;
    }
}

test('old setting names move to the new ones without overwriting', async () => {
    const store = {
        global: { 'codex.showInNavBar': false, 'claudeCode.showInNavBar': false, 'claudeCode.showInStatusBar': true },
        workspace: { 'contextWindow.showAntigravity': false }
    };
    const cfg = loadConfig(store);
    const moved = await cfg.migrate();
    assert.strictEqual(store.global['codex.showInStatusBar'], false, 'value carried over');
    assert.strictEqual(store.global['claudeCode.showInStatusBar'], true, 'new value already set wins');
    assert.strictEqual(store.workspace['antigravity.showContextWindow'], false, 'workspace scope too');
    for (const [from] of cfg.RENAMED) {
        assert.ok(!(from in store.global) && !(from in store.workspace), `${from} cleared`);
    }
    assert.strictEqual(moved.length, 3);
    assert.deepStrictEqual(await cfg.migrate(), [], 'second run does nothing');
});

test('settings are grouped and every tool has the same switches in the same order', () => {
    const cats = pkg.contributes.configuration;
    assert.deepStrictEqual(cats.map(c => c.title), ['General', 'Status Bar', 'Alerts', 'Antigravity', 'Claude Code', 'Codex']);
    for (const [title, prefix] of [['Antigravity', 'antigravity'], ['Claude Code', 'claudeCode'], ['Codex', 'codex']]) {
        const props = cats.find(c => c.title === title).properties;
        const live = Object.entries(props).filter(([, v]) => !v.markdownDeprecationMessage).sort((a, b) => a[1].order - b[1].order).map(([k]) => k);
        assert.deepStrictEqual(live.slice(0, 3), ['enable', 'showInStatusBar', 'showContextWindow'].map(s => `quotaNexus.${prefix}.${s}`));
    }
    const all = cats.flatMap(c => Object.keys(c.properties));
    assert.strictEqual(new Set(all).size, all.length, 'no duplicate keys');
    const old = cats.flatMap(c => Object.entries(c.properties)).filter(([, v]) => v.markdownDeprecationMessage).map(([k]) => k.replace('quotaNexus.', ''));
    assert.deepStrictEqual(old.sort(), loadConfig({ global: {}, workspace: {} }).RENAMED.map(r => r[0]).sort(), 'every renamed key stays registered');
});

test('dashboard panel only accepts known settings with the right type', () => {
    const { isValidSetting } = require('../src/settingsUi');
    assert.strictEqual(isValidSetting('refresh.activeInterval', 300000), true);
    assert.strictEqual(isValidSetting('refresh.activeInterval', '300000'), false, 'string instead of number');
    assert.strictEqual(isValidSetting('refresh.activeInterval', 1), false, 'not one of the options');
    assert.strictEqual(isValidSetting('display.percentMode', 'left'), true);
    assert.strictEqual(isValidSetting('codex.enable', 'false'), false);
    assert.strictEqual(isValidSetting('codex.showInNavBar', true), false, 'old names are not offered');
    assert.strictEqual(isValidSetting('alerts.thresholds', [10]), false, 'lists are edited in VS Code Settings');
    assert.strictEqual(isValidSetting('workbench.colorTheme', 'x'), false, 'nothing outside Quota Nexus');
    assert.strictEqual(isValidSetting({ toString: () => 'codex.enable' }, true), false);
});

test('panel mirrors the setting groups and greys out switches that cannot apply', () => {
    const { settingsView } = require('../src/settingsUi');
    const v = settingsView(k => ({ 'antigravity.enable': false, 'statusBar.show': false })[k]);
    assert.deepStrictEqual(v.map(g => g.title), pkg.contributes.configuration.map(c => c.title));
    const item = k => v.flatMap(g => g.items).find(i => i.key === k);
    assert.strictEqual(item('antigravity.enable').disabled, false);
    assert.strictEqual(item('antigravity.showInStatusBar').disabled, true, 'tool off');
    assert.strictEqual(item('statusBar.format').disabled, true, 'quota item hidden');
    assert.strictEqual(item('claudeCode.showInStatusBar').disabled, true, 'limits are opt-in and off');
    assert.strictEqual(item('codex.showInStatusBar').disabled, false);
    assert.strictEqual(item('refresh.activeInterval').options[0].label, '30 seconds');
    assert.ok(v.flatMap(g => g.items).every(i => i.label && !i.label.includes('.')), 'every row has a readable label');
});

test('title bar shows each action once, whatever the snooze and mask state', () => {
    const menu = pkg.contributes.menus['view/title'];
    const ids = new Set(pkg.contributes.commands.map(c => c.command));
    for (const m of menu) assert.ok(ids.has(m.command), `${m.command} is declared`);
    for (const snoozed of [true, false]) {
        for (const masked of [true, false]) {
            const shown = menu.filter(m => m.group.startsWith('navigation')).filter(m => {
                if (/!quotaNexus\.snoozed/.test(m.when)) return !snoozed;
                if (/quotaNexus\.snoozed/.test(m.when)) return snoozed;
                if (/!quotaNexus\.masked/.test(m.when)) return !masked;
                if (/quotaNexus\.masked/.test(m.when)) return masked;
                return true;
            });
            const slots = shown.map(m => m.group);
            assert.strictEqual(new Set(slots).size, slots.length, `one icon per slot (snoozed=${snoozed}, masked=${masked})`);
            assert.strictEqual(shown.length, 4, 'refresh, bell, eye, gear');
        }
    }
});
