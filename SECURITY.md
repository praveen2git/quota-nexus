# Security Policy

## Supported versions

Only the latest release gets security fixes.

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| Older | No |

## Reporting a problem

Please **do not open a public issue** for security problems.

Report it privately instead: open this repository's **Security** tab and click **Report a vulnerability**. Include:

- what you found and how to reproduce it;
- the Quota Nexus version, VS Code version and operating system;
- what an attacker could do with it.

We aim to reply within 3 working days and to ship a fix for confirmed issues within 14 days. We will credit you in the changelog unless you ask us not to.

## What Quota Nexus touches

These are the parts most worth testing:

- **Local Antigravity server.** Nexus reads the port and local session token from the `agy` or language-server command line. It sends the token only to `127.0.0.1`, and only to ports that process is confirmed to listen on.
- **Claude Code token (opt-in, off by default).** Nexus reads `~/.claude/.credentials.json`, sends the token only to `api.anthropic.com` over HTTPS, and never stores, refreshes, logs or rewrites it.
- **Local logs.** Nexus reads `~/.claude/projects` and `~/.codex/sessions`. It only reads them.
- **Webview.** It has a strict Content Security Policy with a nonce, accepts only a fixed set of message types, and renders all data as plain text.

## Out of scope

- Problems in Antigravity, Claude Code or Codex themselves.
- Attacks that need an attacker already running code as your user account.
