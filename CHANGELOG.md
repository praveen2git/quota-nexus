# Changelog

## [1.2.6] - 2026-10-15

### Fixed
- Clearer wording in `used` mode. A quota with nothing used says "Nothing used yet" instead of "Full", which read like "used up". A passed reset time says "likely back to 0% used" (or "100% left" in `left` mode). The hover's Resets column says "not used".

### Changed
- New README screenshots of the dashboard and the settings panel.

## [1.2.5] - 2026-10-14

### Added
- `quotaNexus.antigravity.enable`: turn Antigravity tracking off. Quota Nexus then stops looking for the Antigravity server, and its card, hover section, other accounts and alerts go away.
- `quotaNexus.antigravity.showInStatusBar`: hide Antigravity quota from the status bar but keep it in the hover and dashboard.
- **Toggle Used / Left** command. The "Show used instead" link in the hover now switches in one click instead of opening Settings.

- **Settings in the dashboard.** The gear opens every setting right in the panel, grouped like VS Code Settings, with readable labels. A tool's switches grey out while that tool is off. The title-bar gear opens it too (**Quota Nexus: Quick Settings**).

### Fixed
- **Claude Code limits no longer get rate-limited (HTTP 429).** Windows and reloads now share one result instead of each asking. After a 429, Nexus waits 5, 10, 20, then up to 30 minutes (or what Anthropic's `Retry-After` asks). Changing settings no longer forces a request, and the Refresh button asks at most once a minute.
- While limits cannot be fetched, the last values stay on screen, marked with their age.

### Changed
- **One row of dashboard icons.** The dashboard's own header (name, bell, eye, refresh, gear) is gone; those actions now sit once in the view's title bar. The bell and eye change to show when alerts are snoozed or emails are masked. Switch account, Toggle Used / Left, Diagnostics and All Settings are in the "..." menu.
- **Settings are grouped** into General, Status Bar, Alerts, Antigravity, Claude Code and Codex. Each tool has the same switches in the same order: Enable, Show In Status Bar, Show Context Window.
- Dropdowns show readable labels (for example "1 minute" instead of `60000`).
- Renamed for consistency: `claudeCode.showInNavBar` and `codex.showInNavBar` are now `showInStatusBar`, and `contextWindow.showAntigravity` is now `antigravity.showContextWindow`. Values you set move over automatically on first start.

## [1.2.4] - 2026-10-14

### Fixed
- The 24-hour chart in the dashboard follows Percent Mode: in `used` mode the line rises as you use quota, matching the bars.

### Changed
- New README screenshots of the hover, the context window and the dashboard.

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
