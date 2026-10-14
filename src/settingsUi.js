'use strict';

const pkg = require('../package.json');

const PREFIX = 'quotaNexus.';
// Short labels for the dashboard panel; the full description shows on hover.
const LABELS = {
    'display.percentMode': 'Show percent as',
    'privacy.maskEmails': 'Mask emails',
    'refresh.activeInterval': 'Refresh every',
    'refresh.pauseWhenUnfocused': 'Pause in background',
    'statusBar.show': 'Show quota item',
    'statusBar.format': 'Format',
    'statusBar.showEmail': 'Show account email',
    'contextWindow.display': 'Context window item',
    'alerts.enabled': 'Low-quota alerts',
    'alerts.thresholds': 'Alert levels',
    'alerts.notifyOnReset': 'Notify on reset',
    'claudeCode.fetchUsageLimits': '5-hour and weekly limits'
};
const TOOL_LABELS = { enable: 'Track', showInStatusBar: 'In status bar', showContextWindow: 'Context window' };
// Greyed out while the setting they depend on is off.
const NEEDS = {
    'statusBar.format': 'statusBar.show',
    'statusBar.showEmail': 'statusBar.show',
    'alerts.thresholds': 'alerts.enabled',
    'alerts.notifyOnReset': 'alerts.enabled',
    'claudeCode.showInStatusBar': 'claudeCode.fetchUsageLimits'
};

function plain(s) {
    return String(s || '').replace(/`#quotaNexus\.([\w.]+)#`/g, '$1').replace(/[*`]/g, '');
}

function kindOf(p) {
    if (p.type === 'boolean') return 'bool';
    if (Array.isArray(p.enum)) return 'enum';
    return p.type === 'array' ? 'list' : null;
}

// Built from package.json so the panel and VS Code Settings never drift apart.
const MODEL = pkg.contributes.configuration.map(cat => ({
    title: cat.title,
    items: Object.entries(cat.properties)
        .filter(([, p]) => !p.markdownDeprecationMessage && kindOf(p))
        .sort((a, b) => a[1].order - b[1].order)
        .map(([full, p]) => {
            const key = full.slice(PREFIX.length);
            const item = { key, label: LABELS[key] || TOOL_LABELS[key.split('.').pop()] || key, help: plain(p.description || p.markdownDescription), kind: kindOf(p), def: p.default };
            if (item.kind === 'enum') item.options = p.enum.map((value, i) => ({ value, label: (p.enumItemLabels || [])[i] || String(value) }));
            return item;
        })
}));
const BY_KEY = new Map(MODEL.flatMap(g => g.items.map(i => [i.key, i])));

// Only known keys with a value of the right type; lists are edited in VS Code Settings.
function isValidSetting(key, value) {
    const item = typeof key === 'string' ? BY_KEY.get(key) : null;
    if (!item) return false;
    if (item.kind === 'bool') return typeof value === 'boolean';
    if (item.kind === 'enum') return item.options.some(o => o.value === value);
    return false;
}

function settingsView(get) {
    const val = k => {
        const v = get(k);
        return v === undefined ? BY_KEY.get(k).def : v;
    };
    return MODEL.map(g => ({
        title: g.title,
        items: g.items.map(i => {
            const toolSwitch = `${i.key.split('.')[0]}.enable`;
            const toolOff = i.key !== toolSwitch && BY_KEY.has(toolSwitch) && val(toolSwitch) === false;
            const needOff = NEEDS[i.key] ? val(NEEDS[i.key]) !== true : false;
            return { ...i, value: val(i.key), disabled: toolOff || needOff };
        })
    }));
}

module.exports = { settingsView, isValidSetting };
