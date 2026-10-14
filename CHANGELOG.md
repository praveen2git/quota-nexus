# Changelog

## [1.2.3] - 2026-10-14

### Added
- **Percent Mode setting** (`quotaNexus.display.percentMode`): show quota as `used` (default) or `left`. `used` matches the Claude Code and Codex screens. Alerts and colours still work on what is left.
- The hover and dashboard show both numbers, for example `57% (43% left)`, so they are easy to compare with each tool's own screen.
- Compact and minimal status bar formats mark each number with ↑ (used) or ↓ (left).
- A "Show left instead" link in the hover opens the setting.
- The context window follows Percent Mode too (for example `13% used (87% left)`), with an arrow in the status bar.

### Changed
- **Numbers show what is used by default again**, for all three tools. 1.2.2 showed what is left. Set Percent Mode to `left` to keep that.
- Tools with data are shown first. "Antigravity not detected" and idle Codex move to short notes at the bottom of the hover, and the Antigravity notice moves below the other cards in the dashboard.
- The context window hover shows **Used** tokens and **From cache**, instead of the confusing "Input tokens 2" (the new, uncached part).

### Fixed
- **Faster first view.** Each tool shows as soon as its own data is ready. Claude Code and Codex (read in milliseconds) no longer wait for the slower Antigravity server search or the Claude limits request. The first refresh starts right away instead of after 1 second.
- Antigravity started after VS Code is found within seconds, not at the next timed refresh.
- While you use Antigravity, its quota refreshes every 30 seconds (it used to wait for the full refresh interval).
- Countdowns and "Updated ..." redraw every minute between refreshes (no extra reads or network).
- While the first Antigravity search is running, the hover and dashboard say "Looking for Antigravity..." instead of "not detected".
- `auto` context mode shows every session used in the last 15 minutes, each tagged (for example `AG 3%↑ · CC 18%↑`), so using Claude Code and Antigravity side by side no longer flips between them. With one active session it stays short.
- In `auto` mode the status bar now switches to the session you are actually using. A session counts as active the moment its token count changes, because Antigravity reports its last-active time late.
- Coming back to VS Code after a minute away (for example from the Antigravity IDE) now refreshes right away, instead of waiting for the full refresh interval.
- The context window in the status bar now updates live while Claude Code, Codex or Antigravity is working. Before, nonstop log writes kept delaying the update until the next timed refresh (up to 5 minutes).
- README badges now use a working Marketplace badge service (the old one was retired).

## [1.2.2] - 2026-10-14

### Changed
- **Every percentage now shows what is left**, for all three tools. Claude Code and Codex used to show "used" while Antigravity showed "left". The status bar, hover table and dashboard now all count down, matching the yellow and red warnings. Descriptive labels say "left" after each tool.
- **Idle Codex is hidden.** If Codex has not run for 7 days, its limits and context leave the status bar, and its stale numbers no longer raise alerts or colour the status bar. The dashboard still shows the card, marked Idle, with when it was last used.

## [1.2.1] - 2026-10-14

### Fixed
- Antigravity pool names and order no longer flip between refreshes ("GPT-OSS / Claude" vs "Claude / GPT-OSS"). This also keeps each pool's history and alert state in one place.
- The 24-hour chart stays hidden until it has at least 2 hours of data, instead of drawing a stray dash.
- Claude Code and Codex colours no longer turn grey in themes that map chart colours to grey.
- Estimated Codex limits show `~` in the status bar too (for example `Codex: ~0%`).
- Antigravity model ids show as readable names (for example `gemini-3.8-flash-n` is now "Gemini 3.8 Flash").

### Changed
- The Claude Code card has a "Show 5-hour and weekly limits" button that turns the opt-in on after a consent dialog.
- README now has screenshots, install steps for VS Code and Open VSX, and badges.
- Clearer Marketplace description and more search keywords (usage limits, rate limits, token usage, AI usage).
- License holder is now "Quota Nexus" (was a leftover from 1.0).

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
