'use strict';

const vscode = require('vscode');
const crypto = require('crypto');

const ALLOWED = new Set(['ready', 'refresh', 'switch', 'signIn', 'rename', 'remove', 'toggleMask', 'openSettings', 'diagnostics', 'snooze', 'enableClaudeLimits']);

class DashboardProvider {
    constructor(extensionUri, onMessage) {
        this.extensionUri = extensionUri;
        this.onMessage = onMessage;
        this.view = null;
        this.state = null;
    }

    resolveWebviewView(view) {
        this.view = view;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        view.webview.html = this.html(view.webview, media);
        view.webview.onDidReceiveMessage((msg) => {
            if (!msg || !ALLOWED.has(msg.type)) return;
            if (msg.type === 'ready') return this.post();
            this.onMessage(msg);
        });
        view.onDidChangeVisibility(() => {
            if (view.visible) this.post();
        });
        view.onDidDispose(() => { this.view = null; });
    }

    setState(state) {
        this.state = state;
        this.post();
    }

    post() {
        if (this.view && this.view.visible && this.state) {
            this.view.webview.postMessage({ type: 'state', state: this.state });
        }
    }

    html(webview, media) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Quota Nexus</title>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}

module.exports = { DashboardProvider };
