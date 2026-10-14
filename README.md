# Quota Nexus

See how much AI quota you have left, when it resets and when you will run out, for **Antigravity**, **Claude Code** and **Codex**, right in your status bar.

> **Unofficial.** Not affiliated with, endorsed by or sponsored by Google, Anthropic or OpenAI. "Antigravity", "Gemini", "Claude" and "Codex" are trademarks of their owners.

## Features

- **One status bar for three tools.** For example: `Antigravity: Gemini 100% · Claude / GPT-OSS 22% | Claude Code: 3% · wk 76% | Codex: 34%`. It turns yellow, then red, as anything runs low.
- **Run-out forecast.** Nexus tracks your burn rate and tells you "At this pace it runs out in 2h 10m (3:40 PM)" or "lasts until the reset".
- **24-hour history.** A small chart per quota shows how fast you used it.
- **Smart alerts.** You get a notification at 20% and 5% left (you can change the levels), and another when a quota resets. When one Antigravity pool is low, it suggests a pool that still has room. Snooze alerts for an hour with one click.
- **Context window meter.** Shows how full the active Antigravity conversation, Claude Code session or Codex session is, with a `/compact` tip when it gets full.
- **Real quota pools.** Antigravity models that share a quota are grouped, and each pool lists its models.
- **Several Antigravity accounts.** Nexus remembers each account you sign in with, shows its last-seen quota and when it resets, and lets you label it (Work, Personal).
- **Diagnostics.** If something isn't detected, **Quota Nexus: Show Diagnostics** tells you why.
- **Privacy first.** Emails are masked by default and hidden from the status bar.
- **Follows your theme.** Works in light, dark and high-contrast themes.

## How it works

Quota Nexus reads data that is already on your machine:

| Tool | Data | Source | Network |
|---|---|---|---|
| Antigravity | Quota, plan, credits, context window | The local Antigravity server (`agy` or the IDE) on `127.0.0.1` | None |
| Claude Code | Context window | Session logs in `~/.claude/projects` | None |
| Claude Code | 5-hour and weekly limits (opt-in, off by default) | Your existing token in `~/.claude/.credentials.json` | `api.anthropic.com` only |
| Codex | Rate limits, plan, context window | Session logs in `~/.codex/sessions` | None |

To talk to the local Antigravity server, Quota Nexus reads that server's port and local session token from its process command line. This is the same way the IDE connects. Nothing leaves your machine.

Codex writes its rate limits into its logs each time it runs. Nexus shows them "as of" that moment. Once a window's reset time has passed, it shows "likely reset".

## Privacy and security

- Quota Nexus **stores no sign-in tokens** and never reads, decrypts, writes or deletes another app's credentials.
- No telemetry, analytics or third-party servers.
- Stored data (in VS Code's extension storage only):
  - each Antigravity account's email, display name, label, plan and last-seen quota;
  - 7 days of quota percentages for the charts.
- Claude Code limits are off by default. When you turn them on, the token is read-only and is never refreshed or rewritten.
- Diagnostics never log tokens or full email addresses.

## Switching Antigravity accounts

Quota Nexus does not switch accounts by itself. Run **Quota Nexus: Switch Antigravity Account** and pick an account:

1. Click **Open agy Terminal** (CLI users), type `/logout`, and sign in with the other account.
2. Antigravity IDE users can use the IDE's account menu instead.

Nexus detects the new account within one refresh.

## Commands

- `Quota Nexus: Refresh Quota`
- `Quota Nexus: Switch Antigravity Account`
- `Quota Nexus: Sign In With Another Antigravity Account`
- `Quota Nexus: Snooze or Resume Alerts`
- `Quota Nexus: Toggle Email Masking`
- `Quota Nexus: Show Diagnostics`
- `Quota Nexus: Open Settings`

## Settings

| Setting | Default | What it does |
|---|---|---|
| `quotaNexus.statusBar.show` | `true` | Show quota in the status bar |
| `quotaNexus.statusBar.format` | `descriptive` | `descriptive`, `compact` or `minimal` labels |
| `quotaNexus.statusBar.showEmail` | `false` | Show the Antigravity account in the status bar |
| `quotaNexus.privacy.maskEmails` | `true` | Mask emails |
| `quotaNexus.refresh.activeInterval` | `60000` | Refresh interval in ms (30 s to 5 min) |
| `quotaNexus.refresh.pauseWhenUnfocused` | `true` | Pause polling when the window is in the background |
| `quotaNexus.alerts.enabled` | `true` | Low-quota notifications for all three tools |
| `quotaNexus.alerts.thresholds` | `[20, 5]` | Percent-left levels for alerts and status bar colors |
| `quotaNexus.alerts.notifyOnReset` | `true` | Notify when a quota is full again |
| `quotaNexus.contextWindow.display` | `auto` | `auto`, `antigravity`, `claudeCode`, `codex`, `all` or `off` |
| `quotaNexus.contextWindow.showAntigravity` | `true` | Track the Antigravity context window |
| `quotaNexus.claudeCode.enable` | `true` | Track Claude Code sessions from local logs |
| `quotaNexus.claudeCode.showContextWindow` | `true` | Include Claude Code context in the status bar |
| `quotaNexus.claudeCode.fetchUsageLimits` | `false` | Opt-in Claude Code 5-hour and weekly limits |
| `quotaNexus.claudeCode.showInNavBar` | `true` | Include Claude Code limits in the status bar |
| `quotaNexus.codex.enable` | `true` | Track Codex sessions and rate limits from local logs |
| `quotaNexus.codex.showInNavBar` | `true` | Include Codex limits in the status bar |
| `quotaNexus.codex.showContextWindow` | `true` | Include Codex context in the status bar |

## Requirements

- VS Code 1.80 or later.
- At least one of: Antigravity (`agy` CLI or IDE), Claude Code, or Codex on the same machine.
- Windows, macOS or Linux. On macOS and Linux, `lsof` is used as a fallback to find the Antigravity server port.

## Known limits

- Antigravity and Claude Code context window sizes are estimates. Codex reports its own.
- Inactive Antigravity accounts are not polled. Their numbers are the last values seen while they were active.
- Codex limits update only when Codex runs.
- Claude Code limits use an undocumented endpoint that may change.
- Forecasts need about 15 minutes of history before they appear.

## License

MIT
