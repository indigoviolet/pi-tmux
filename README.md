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

- **run** — Run commands in new tmux windows. Each command gets its own window. When a command finishes, the agent is automatically notified with the exit code and recent output, so it doesn't need to wait around.
- **attach** — Open a new terminal tab/window attached to the session. Supports iTerm2, Terminal.app, kitty, ghostty, WezTerm, and tmux nesting. Falls back to printing the attach command for unsupported terminals.
- **peek** — Capture recent output from tmux windows.
- **list** — List all windows in the session.
- **kill** — Kill the entire session.

Each command's script is echoed before execution (`cat "$0"`) so you can see exactly what's running — including heredocs and complex constructs that `set -x` would miss.

### Commands

- `/tmux` — Open a terminal tab attached to the project's tmux session
- `/tmux:cat` — Select a tmux window and bring its output into the conversation

## Credits

Inspired by [normful/picadillo's run-in-tmux skill](https://github.com/normful/picadillo/blob/main/skills/run-in-tmux/SKILL.md).

## License

Apache 2.0
