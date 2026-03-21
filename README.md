# pi-tmux

A [pi](https://github.com/badlogic/pi) coding agent extension that manages a tmux session per project (one per git root).

## Install

```bash
pi install npm:@romansix/pi-tmux
```

Or try without installing:

```bash
pi -e npm:@romansix/pi-tmux
```

## Features

### `tmux` tool

Provides a `tmux` tool for the agent with these actions:

- **run** — Run a command in a new tmux window. When the command finishes, the agent is automatically notified with the exit code and recent output, so it doesn't need to wait around.
- **attach** — Open a new terminal tab/window attached to the session. Pass `window` to target a specific window. Supports iTerm2, Terminal.app, kitty, ghostty, WezTerm, and tmux nesting. Falls back to printing the attach command for unsupported terminals.
- **peek** — Capture recent output from tmux windows. Use `window` to target a specific window, or omit for all.
- **list** — List all windows in the session.
- **kill** — Kill the entire session.
- **mute** — Suppress silence notifications for a window. Use when a command is expected to have long silence periods, not waiting for input.

Each command's script is echoed before execution (`cat "$0"`) so you can see exactly what's running — including heredocs and complex constructs that `set -x` would miss.

### Silence detection

When running commands that might prompt for input (installers, interactive tools, confirmations), the agent can set `silenceTimeout` to be notified when the command goes quiet.

| Parameter | Description | Default |
|---|---|---|
| `silenceTimeout` | Initial seconds of silence before notifying. 0 or omitted to disable. | — |
| `silenceBackoffFactor` | Multiply the interval after each notification. | 1.5 |
| `silenceBackoffCap` | Max silence interval in seconds. | 300 (5 min) |

The notification includes a peek of the window output so the agent can decide whether to act or mute the window.

### Commands

- `/tmux` — Open a terminal tab attached to the project's tmux session
- `/tmux:cat` — Select a tmux window and bring its output into the conversation
- `/tmux:clear` — Kill idle tmux windows (shells with no running child processes)

## Credits

Inspired by [normful/picadillo's run-in-tmux skill](https://github.com/normful/picadillo/blob/main/skills/run-in-tmux/SKILL.md).

## License

Apache 2.0
