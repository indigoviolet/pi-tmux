/**
 * tmux extension - manages a tmux session per project (git root).
 *
 * Tool: tmux (run/attach/peek/list/kill)
 * Commands: /tmux (attach in iTerm2), /tmux:cat (capture window output into conversation)
 *
 * Completion notifications: commands are wrapped so that when they finish,
 * a signal file is written. A fs.watch picks it up and injects a message
 * into the conversation with the exit code and recent output.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";


const SIGNAL_DIR = "/tmp/pi-tmux";

const TmuxParams = Type.Object({
  action: StringEnum(["run", "attach", "peek", "kill", "list"] as const),
  commands: Type.Optional(
    Type.Array(Type.String(), {
      description: "Commands to run (for 'run' action). Each gets its own tmux window.",
    })
  ),
  names: Type.Optional(
    Type.Array(Type.String(), {
      description: "Short descriptive names for each window (for 'run' action). Must match length of commands. E.g. ['dev-server', 'tests', 'db'].",
    })
  ),
  window: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "Window index or 'all' (for 'peek' action). Defaults to 'all'.",
    })
  ),
});

type TmuxInput = Static<typeof TmuxParams>;

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
}

function execSafe(cmd: string): string | null {
  try {
    return exec(cmd);
  } catch {
    return null;
  }
}

function getGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd,
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function sessionName(gitRoot: string): string {
  const slug = gitRoot.split("/").pop()!.slice(0, 16).toLowerCase();
  const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function sessionExists(name: string): boolean {
  return execSafe(`tmux has-session -t ${name} 2>/dev/null && echo yes`) === "yes";
}

function getWindows(name: string): { index: number; title: string; active: boolean }[] {
  const raw = execSafe(
    `tmux list-windows -t ${name} -F "#{window_index}|||#{window_name}|||#{window_active}"`
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [index, title, active] = line.split("|||");
    return { index: parseInt(index), title, active: active === "1" };
  });
}

function capturePanes(name: string, window: number | "all"): string {
  const windows = getWindows(name);
  const targets =
    window === "all" ? windows : windows.filter((w) => w.index === window);

  if (targets.length === 0) return "No matching windows.";

  return targets
    .map((w) => {
      const output = execSafe(`tmux capture-pane -t ${name}:${w.index} -p -S -50`);
      return `── window ${w.index}: ${w.title} ──\n${output ?? "(empty)"}`;
    })
    .join("\n\n");
}

function openTerminalTab(session: string): string {
  const term = process.env.TERM_PROGRAM ?? "";
  const attachCmd = `tmux attach -t ${session}`;

  // Already inside tmux — switch client instead of nesting
  if (process.env.TMUX) {
    exec(`tmux switch-client -t ${session}`);
    return `Switched tmux client to session ${session}.`;
  }

  switch (term) {
    case "iTerm.app":
      exec(`osascript -e '
        tell application "iTerm2"
          tell current window
            set newTab to (create tab with default profile)
            tell current session of newTab
              write text "${escapeForTmux(attachCmd)}"
            end tell
          end tell
        end tell'`);
      return `Opened iTerm2 tab attached to ${session}.`;

    case "Apple_Terminal":
      exec(`osascript -e '
        tell application "Terminal"
          activate
          do script "${escapeForTmux(attachCmd)}"
        end tell'`);
      return `Opened Terminal.app window attached to ${session}.`;

    case "kitty":
      exec(`kitty @ launch --type=tab ${attachCmd}`);
      return `Opened kitty tab attached to ${session}.`;

    case "ghostty":
      exec(`ghostty -e ${attachCmd} &`);
      return `Opened ghostty window attached to ${session}.`;

    case "WezTerm":
      exec(`wezterm cli spawn -- ${attachCmd}`);
      return `Opened WezTerm tab attached to ${session}.`;

    default:
      return `No supported terminal detected. Run manually:\n  ${attachCmd}`;
  }
}

function attachToSession(cwd: string): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return "Not in a git repository.";

  const session = sessionName(gitRoot);
  if (!sessionExists(session)) return `No tmux session for this project.`;

  try {
    return openTerminalTab(session);
  } catch (e: any) {
    return `Failed: ${e.message}\nRun manually:\n  tmux attach -t ${session}`;
  }
}

const SCRIPT_DIR = join(SIGNAL_DIR, "s");

/**
 * Write a per-window script that echoes itself before executing.
 * cat "$0" prints the full script (including heredocs etc. that set -x misses),
 * then a separator, then the actual command runs.
 */
function sendCommandWithSignal(session: string, windowIndex: number, cmd: string): void {
  mkdirSync(SCRIPT_DIR, { recursive: true });
  const id = randomBytes(4).toString("hex");
  const signalFile = join(SIGNAL_DIR, `${session}.${windowIndex}.${id}`);
  const scriptPath = join(SCRIPT_DIR, `${session}.${windowIndex}.${id}.sh`);
  writeFileSync(scriptPath, `#!/usr/bin/env bash
cat "$0"
echo '---'
${cmd}
__rc=$?
echo $__rc > "${signalFile}"
`, { mode: 0o755 });
  exec(`tmux send-keys -t ${session}:${windowIndex} "${escapeForTmux(scriptPath)}" C-m`);
}

function addWindow(session: string, gitRoot: string, cmd: string, name?: string): number {
  const winName = (name ?? cmd.split(/[|;&\s]/)[0].split("/").pop() ?? "shell").slice(0, 30);
  const raw = exec(
    `tmux new-window -t ${session} -n "${escapeForTmux(winName)}" -c "${gitRoot}" -P -F "#{window_index}"`
  );
  const idx = parseInt(raw);
  sendCommandWithSignal(session, idx, cmd);
  return idx;
}

function escapeForTmux(s: string): string {
  return s.replace(/"/g, '\\"');
}

export default function (pi: ExtensionAPI) {
  // Ensure signal directory exists
  mkdirSync(SIGNAL_DIR, { recursive: true });

  // Track watcher for cleanup
  let watcher: FSWatcher | null = null;

  function startWatching() {
    if (watcher) return;

    watcher = chokidarWatch(SIGNAL_DIR, {
      ignoreInitial: true,
      depth: 0,
      // Ignore script subdirectory and .sh files
      ignored: [join(SIGNAL_DIR, "s"), /\.sh$/],
      // Small stabilization delay for atomic writes
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    watcher.on("add", (filepath) => {
      try {
        const filename = filepath.split("/").pop()!;
        const exitCode = readFileSync(filepath, "utf-8").trim();
        unlinkSync(filepath);

        // Parse session.windowIndex.id from filename
        const lastDot = filename.lastIndexOf(".");
        const secondLastDot = filename.lastIndexOf(".", lastDot - 1);
        if (secondLastDot === -1) return;
        const session = filename.slice(0, secondLastDot);
        const winStr = filename.slice(secondLastDot + 1, lastDot);
        const winIdx = parseInt(winStr);
        if (isNaN(winIdx)) return;

        // Get window name
        const windows = getWindows(session);
        const win = windows.find((w) => w.index === winIdx);
        const winName = win?.title ?? `window ${winIdx}`;

        // Capture recent output
        const output = execSafe(`tmux capture-pane -t ${session}:${winIdx} -p -S -30`);
        const trimmedOutput = (output ?? "").split("\n").filter(l => l.trim()).slice(-20).join("\n");

        const code = parseInt(exitCode);
        const status = code === 0 ? "completed successfully" : `exited with code ${code}`;

        pi.sendMessage({
          customType: "tmux-completion",
          content: `tmux window "${winName}" (:${winIdx}) ${status}.\n\n\`\`\`\n${trimmedOutput}\n\`\`\``,
          display: true,
        }, {
          triggerTurn: true,
          deliverAs: "followUp",
        });
      } catch {
        // Ignore errors from racing deletes etc.
      }
    });
  }

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
  });

  // /tmux — attach in terminal
  pi.registerCommand("tmux", {
    description: "Open a terminal tab attached to this project's tmux session",
    handler: async (_args, ctx) => {
      const msg = attachToSession(ctx.cwd);
      ctx.ui.notify(msg, msg.startsWith("Failed") || msg.startsWith("No") || msg.startsWith("Not") ? "error" : "info");
    },
  });

  // /tmux:cat — capture window output into conversation
  pi.registerCommand("tmux:cat", {
    description: "Capture tmux window output and bring it into the conversation",
    handler: async (_args, ctx) => {
      const gitRoot = getGitRoot(ctx.cwd);
      if (!gitRoot) { ctx.ui.notify("Not in a git repository.", "error"); return; }

      const session = sessionName(gitRoot);
      if (!sessionExists(session)) { ctx.ui.notify("No tmux session for this project.", "error"); return; }

      const windows = getWindows(session);
      if (windows.length === 0) { ctx.ui.notify("No windows in session.", "error"); return; }

      const options = [
        "all windows",
        ...windows.map((w) => `:${w.index}  ${w.title}${w.active ? "  (active)" : ""}`),
      ];

      const choice = await ctx.ui.select("Capture output from:", options);
      if (choice === undefined || choice === null) return;

      let target: number | "all";
      if (choice === 0 || choice === "all windows") {
        target = "all";
      } else {
        const idx = typeof choice === "number" ? choice - 1 : options.indexOf(String(choice)) - 1;
        const win = windows[idx];
        if (!win) { ctx.ui.notify("Invalid window selection.", "error"); return; }
        target = win.index;
      }
      const output = capturePanes(session, target);

      pi.sendUserMessage(`Here is the tmux output:\n\n\`\`\`\n${output}\n\`\`\``, {
        deliverAs: "followUp",
      });
    },
  });

  // tmux tool — for the agent
  pi.registerTool({
    name: "tmux",
    label: "tmux",
    description: `Manage a tmux session for the current project (one session per git root).

WHEN TO USE: Prefer this over bash for long-running or background commands: dev servers, file watchers, build processes, test suites, anything that runs continuously or takes more than a few seconds. Use bash for quick one-shot commands that complete immediately (ls, cat, grep, git status, etc.).

Actions:
- run: Run commands in new tmux windows. Each command gets its own window. If the session already exists, new windows are added to it. When a command finishes, the agent is automatically notified with the exit code and recent output.
- attach: Open a new terminal tab attached to the session (for the user to interact with). Supports iTerm2, Terminal.app, kitty, ghostty, WezTerm, and tmux nesting.
- peek: Capture recent output from tmux windows. Use window param to target a specific window, or omit for all. Use this to check on running processes.
- list: List all windows in the session.
- kill: Kill the entire session.

COMPLETION NOTIFICATIONS: After using 'run', you do not need to poll or wait to find out when a command finishes. The session will automatically notify you with the exit code and recent output when the command completes — just move on to other work. You can still peek at any time to check intermediate output from a running process.

The user can also type /tmux to attach in a new terminal tab, or /tmux:cat to select a window and bring its output into the conversation.`,
    parameters: TmuxParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const gitRoot = getGitRoot(ctx.cwd);
      if (!gitRoot) {
        return {
          content: [{ type: "text", text: "Error: not in a git repository." }],
          isError: true,
        };
      }

      const session = sessionName(gitRoot);

      switch (params.action) {
        case "run": {
          if (!params.commands || params.commands.length === 0) {
            return {
              content: [{ type: "text", text: "Error: 'commands' required for run action." }],
              isError: true,
            };
          }

          // Start watching for completions
          startWatching();

          const exists = sessionExists(session);
          const indices: number[] = [];
          const names = params.names ?? [];

          if (!exists) {
            const firstName = (names[0] ?? params.commands[0].split(/[|;&\s]/)[0].split("/").pop() ?? "shell").slice(0, 30);
            exec(`tmux new-session -d -s ${session} -n "${escapeForTmux(firstName)}" -c "${gitRoot}"`);
            sendCommandWithSignal(session, 0, params.commands[0]);
            indices.push(0);

            for (let i = 1; i < params.commands.length; i++) {
              const idx = addWindow(session, gitRoot, params.commands[i], names[i]);
              indices.push(idx);
            }
          } else {
            for (let i = 0; i < params.commands.length; i++) {
              const idx = addWindow(session, gitRoot, params.commands[i], names[i]);
              indices.push(idx);
            }
          }

          const lines = params.commands.map(
            (cmd, i) => `  :${indices[i]}  ${names[i] ? names[i] + ": " : ""}${cmd}`
          );
          return {
            content: [
              {
                type: "text",
                text: `${exists ? "Added to" : "Created"} session ${session}\n${lines.join("\n")}`,
              },
            ],
            details: { session, existed: exists, windowIndices: indices },
          };
        }

        case "attach": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}' to attach to.` }],
              isError: true,
            };
          }

          const msg = attachToSession(ctx.cwd);
          const failed = msg.startsWith("Failed");
          return {
            content: [{ type: "text", text: msg }],
            ...(failed && { isError: true }),
          };
        }

        case "peek": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}'.` }],
              isError: true,
            };
          }

          const win =
            params.window === undefined || params.window === "all"
              ? "all" as const
              : typeof params.window === "number"
                ? params.window
                : parseInt(params.window);

          const output = capturePanes(
            session,
            typeof win === "string" ? win : isNaN(win as number) ? "all" : win
          );
          return {
            content: [{ type: "text", text: output }],
            details: { session },
          };
        }

        case "list": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}'.` }],
              isError: true,
            };
          }

          const windows = getWindows(session);
          const lines = windows.map(
            (w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`
          );
          return {
            content: [
              {
                type: "text",
                text: `Session ${session} — ${windows.length} window(s)\n${lines.join("\n")}`,
              },
            ],
            details: { session, windows },
          };
        }

        case "kill": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}' to kill.` }],
            };
          }

          exec(`tmux kill-session -t ${session}`);
          return {
            content: [{ type: "text", text: `Killed session ${session}.` }],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${params.action}` }],
            isError: true,
          };
      }
    },

    renderCall(args, theme) {
      const action = args.action ?? "tmux";
      let text = theme.fg("toolTitle", theme.bold("tmux "));
      text += theme.fg("accent", action);

      if (action === "run" && Array.isArray(args.commands)) {
        const names = Array.isArray(args.names) ? args.names : [];
        for (let i = 0; i < args.commands.length; i++) {
          const label = names[i] ? theme.fg("text", names[i] + ": ") : "";
          text += "\n  " + label + theme.fg("muted", args.commands[i]);
        }
      } else if (action === "peek" && args.window !== undefined) {
        text += theme.fg("muted", ` :${args.window}`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";

      if (result.isError) {
        return new Text(theme.fg("error", raw), 0, 0);
      }

      // First line is the summary, rest is detail
      const lines = raw.split("\n");
      const summary = lines[0] ?? "";
      const detail = lines.slice(1).join("\n");

      let text = theme.fg("success", "✓ ") + summary;
      if (expanded && detail) {
        text += "\n" + theme.fg("dim", detail);
      }

      return new Text(text, 0, 0);
    },
  });

  // Custom renderer for completion notifications
  pi.registerMessageRenderer("tmux-completion", (message, { expanded }, theme) => {
    const lines = (message.content as string).split("\n");
    const summary = lines[0] ?? "";
    const detail = lines.slice(1).join("\n");

    const icon = summary.includes("successfully") ? theme.fg("success", "✓") : theme.fg("error", "✗");
    let text = `${icon} ${theme.fg("toolTitle", "tmux")} ${summary}`;
    if (expanded && detail) {
      text += "\n" + theme.fg("dim", detail);
    }

    return new Text(text, 0, 0);
  });
}
