'use strict';

const vscode = require('vscode');

const SECTION = 'quotaNexus';

function get(key, fallback) {
    const v = vscode.workspace.getConfiguration(SECTION).get(key);
    return v === undefined || v === null ? fallback : v;
}

function set(key, value) {
    return vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

// Old keys (1.2.0-1.2.4) moved to names that match across tools.
const RENAMED = [
    ['claudeCode.showInNavBar', 'claudeCode.showInStatusBar'],
    ['codex.showInNavBar', 'codex.showInStatusBar'],
    ['contextWindow.showAntigravity', 'antigravity.showContextWindow']
];

async function migrate(renamed = RENAMED) {
    const conf = vscode.workspace.getConfiguration(SECTION);
    const scopes = [['globalValue', vscode.ConfigurationTarget.Global], ['workspaceValue', vscode.ConfigurationTarget.Workspace]];
    const moved = [];
    for (const [from, to] of renamed) {
        const old = conf.inspect(from);
        if (!old) continue;
        for (const [scope, target] of scopes) {
            if (old[scope] === undefined) continue;
            const now = conf.inspect(to);
            if (!now || now[scope] === undefined) await conf.update(to, old[scope], target);
            await conf.update(from, undefined, target);
            moved.push(`${from} -> ${to}`);
        }
    }
    return moved;
}

function interval() {
    const n = Number(get('refresh.activeInterval', 60000));
    return Math.max(15000, isFinite(n) ? n : 60000);
}

module.exports = { SECTION, get, set, interval, migrate, RENAMED };
