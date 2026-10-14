'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

function makeVscode(calls) {
    const disposable = () => ({ dispose() {} });
    const emitter = () => { const fns = []; const ev = fn => { fns.push(fn); return disposable(); }; ev.fire = x => fns.forEach(f => f(x)); return ev; };
    const item = () => ({ show() { calls.push('show'); }, hide() { calls.push('hide'); }, dispose() {} });
    class MarkdownString { constructor(v) { this.value = v || ''; } appendMarkdown(s) { this.value += s; return this; } }
    return {
        version: '1.99.0',
        StatusBarAlignment: { Right: 2 },
        ProgressLocation: { Window: 10 },
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        ThemeColor: class { constructor(id) { this.id = id; } },
        MarkdownString,
        Uri: { joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }),
            onDidChangeConfiguration: emitter()
        },
        window: {
            state: { focused: true },
            createStatusBarItem: () => item(),
            createOutputChannel: () => ({ info() {}, warn() {}, show() {}, dispose() {} }),
            registerWebviewViewProvider: (id, p) => { calls.push(`view:${id}`); calls.provider = p; return disposable(); },
            onDidChangeWindowState: emitter(),
            showInformationMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            withProgress: (_o, fn) => fn()
        },
        commands: {
            registerCommand: (id) => { calls.push(`cmd:${id}`); return disposable(); },
            executeCommand: async () => {}
        }
    };
}

test('activate wires commands, view and status bar without throwing', async () => {
    const calls = [];
    const vscode = makeVscode(calls);
    const origLoad = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
    try {
        const ext = require('../src/extension');
        const state = {};
        const context = {
            subscriptions: [],
            extensionUri: { fsPath: path.join(__dirname, '..') },
            extension: { id: 'quota-nexus.quota-nexus', packageJSON: { version: '1.2.0' } },
            globalState: { get: k => state[k], update: async (k, v) => { state[k] = v; } }
        };
        ext.activate(context);
        const pkg = require('../package.json');
        for (const c of pkg.contributes.commands) assert.ok(calls.includes(`cmd:${c.command}`), `missing ${c.command}`);
        assert.ok(calls.includes('view:quotaNexus.dashboard'));

        const posted = [];
        let onMsg = null;
        calls.provider.resolveWebviewView({
            visible: true,
            webview: {
                cspSource: 'vscode-resource:',
                asWebviewUri: u => u.fsPath,
                postMessage: m => posted.push(m),
                onDidReceiveMessage: fn => { onMsg = fn; }
            },
            onDidChangeVisibility: () => {},
            onDidDispose: () => {}
        });
        await new Promise(r => setTimeout(r, 80));
        onMsg({ type: 'ready' });
        onMsg({ type: 'evil' });
        assert.ok(posted.some(m => m.type === 'state' && m.state.connected === false));
        for (const d of context.subscriptions) d.dispose();
    } finally {
        Module._load = origLoad;
    }
});
