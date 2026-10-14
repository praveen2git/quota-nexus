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

function interval() {
    const n = Number(get('refresh.activeInterval', 60000));
    return Math.max(15000, isFinite(n) ? n : 60000);
}

module.exports = { SECTION, get, set, interval };
