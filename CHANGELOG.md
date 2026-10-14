# Changelog

## [1.2.0] - 2026-10-14

### Changed
- Renamed to **Quota Nexus** (extension ID `quota-nexus.quota-nexus`). Settings moved from `antigravityNexus.*` to `quotaNexus.*`, and commands to `quotaNexus.*`.
- The context window setting `contextWindow.display` now takes `codex` and `all` (replaces `both`).
- A workspace's own session wins only if it was active in the last 12 hours. Otherwise the newest session is shown, so old sessions no longer show stale context.

### Added
- **Codex support.** Shows rate limits, plan and context window from the local Codex logs, with no token and no network.
- **Run-out forecast** per quota, from your recent burn rate.
- **24-hour history chart** per quota (7 days kept).
- **Alerts for Claude Code and Codex limits**, plus a hint toward an Antigravity pool that still has room.
- **Snooze alerts** for 1 hour (bell button, alert button or command).
- **Diagnostics** output channel and the "Show Diagnostics" command.
- Each Antigravity pool lists the models that share it.
- `/compact` tips when a context window passes 80%.

### Security
- Replies from the local Antigravity server and from `api.anthropic.com` are capped (5 MB and 1 MB).
- The Antigravity session token is sent only to ports its own process is confirmed to listen on.
- All numbers and text from servers and logs are type-checked and range-checked before use.
- Build tool pinned to `@vscode/vsce@4.0.0`. CI and CodeQL workflows pin every action to a commit.
- Added `SECURITY.md` with a private reporting process.

## [1.1.0] - 2026-10-14

### Changed
- Quota now comes only from the local Antigravity server. No Google tokens, no OAuth client secret, no remote Google API calls.
- Account switching is a guided flow through Antigravity's own sign-out and sign-in. The extension never reads, decrypts, writes or deletes any sign-in credential.
- Other accounts show their last-seen quota, marked "likely full" once their reset time has passed.
- Claude Code limits are opt-in, read-only, and never refresh or rewrite the token.
- Theme-aware dashboard that updates in place, with a strict Content Security Policy.
- Saved accounts from 1.0.0 are not carried over.

### Added
- Low-quota and reset notifications, status bar colors, account labels, macOS and Linux support, pause polling when unfocused.

### Removed
- Credential Manager helper, DPAPI decryption, Python and SQLite access, force-killing `agy.exe`, "Smart switch on low quota".

### Fixed
- Extension host freezes, overlapping refreshes, workspace matching, weekly values copied from 5-hour values, unescaped emails.

## [1.0.0] - 2026-10-09

- First release.
