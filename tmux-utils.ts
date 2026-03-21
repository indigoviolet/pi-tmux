/**
 * Reusable tmux utility functions.
 *
 * These are pure helpers with no pi extension dependencies — safe to import
 * from other packages that need to interact with project tmux sessions.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// ── Shell helpers ──────────────────────────────────────────────────────

export function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
}

export function execSafe(cmd: string): string | null {
  try {
    return exec(cmd);
  } catch {
    return null;
  }
}

export function escapeForTmux(s: string): string {
  return s.replace(/"/g, '\\"');
}

// ── Git ────────────────────────────────────────────────────────────────

export function getGitRoot(cwd: string): string | null {
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

// ── Session helpers ────────────────────────────────────────────────────

export function sessionName(gitRoot: string): string {
  const slug = gitRoot.split("/").pop()!.slice(0, 16).toLowerCase();
  const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function sessionExists(name: string): boolean {
  return execSafe(`tmux has-session -t ${name} 2>/dev/null && echo yes`) === "yes";
}

/**
 * Ensure a tmux session exists for the given project.
 * Returns `true` if a new session was created, `false` if it already existed.
 */
export function ensureSession(session: string, gitRoot: string): boolean {
  if (sessionExists(session)) return false;
  exec(`tmux new-session -d -s ${session} -c "${escapeForTmux(gitRoot)}"`);
  return true;
}

// ── Window helpers ─────────────────────────────────────────────────────

export interface TmuxWindow {
  index: number;
  title: string;
  active: boolean;
}

export function getWindows(name: string): TmuxWindow[] {
  const raw = execSafe(
    `tmux list-windows -t ${name} -F "#{window_index}|||#{window_name}|||#{window_active}"`
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [index, title, active] = line.split("|||");
    return { index: parseInt(index), title, active: active === "1" };
  });
}

export function formatWindowLines(windows: TmuxWindow[]): string[] {
  return windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
}

export function capturePanes(name: string, window: number | "all"): string {
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

/**
 * Create a new tmux window running a command. No signal/completion tracking.
 * Returns the window index.
 */
export function runInWindow(
  session: string,
  gitRoot: string,
  cmd: string,
  name?: string,
): number {
  const winName = (name ?? cmd.split(/[|;&\s]/)[0].split("/").pop() ?? "shell").slice(0, 30);
  const raw = exec(
    `tmux new-window -t ${session} -n "${escapeForTmux(winName)}" -c "${escapeForTmux(gitRoot)}" -P -F "#{window_index}"`
  );
  const idx = parseInt(raw);
  exec(`tmux send-keys -t ${session}:${idx} "${escapeForTmux(cmd)}" C-m`);
  return idx;
}

// ── Terminal attach ────────────────────────────────────────────────────

export function openTerminalTab(session: string, window?: number): string {
  const target = window === undefined ? session : `${session}:${window}`;
  const term = process.env.TERM_PROGRAM ?? "";
  const attachCmd = `tmux attach -t ${target}`;

  // Already inside tmux — switch client instead of nesting
  if (process.env.TMUX) {
    exec(`tmux switch-client -t ${target}`);
    return `Switched tmux client to ${target}.`;
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
      return `Opened iTerm2 tab attached to ${target}.`;

    case "Apple_Terminal":
      exec(`osascript -e '
        tell application "Terminal"
          activate
          do script "${escapeForTmux(attachCmd)}"
        end tell'`);
      return `Opened Terminal.app window attached to ${target}.`;

    case "kitty":
      exec(`kitty @ launch --type=tab ${attachCmd}`);
      return `Opened kitty tab attached to ${target}.`;

    case "ghostty":
      exec(`ghostty -e ${attachCmd} &`);
      return `Opened ghostty window attached to ${target}.`;

    case "WezTerm":
      exec(`wezterm cli spawn -- ${attachCmd}`);
      return `Opened WezTerm tab attached to ${target}.`;

    default:
      return `No supported terminal detected. Run manually:\n  ${attachCmd}`;
  }
}

export function attachToSession(cwd: string, window?: number): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return "Not in a git repository.";

  const session = sessionName(gitRoot);
  const target = window === undefined ? session : `${session}:${window}`;
  if (!sessionExists(session)) return `No tmux session for this project.`;

  if (window !== undefined) {
    const windows = getWindows(session);
    const match = windows.find((w) => w.index === window);
    if (!match) {
      const available = formatWindowLines(windows);
      return available.length > 0
        ? `No tmux window :${window} in session ${session}.\nAvailable windows:\n${available.join("\n")}`
        : `No tmux window :${window} in session ${session}.`;
    }
  }

  try {
    return openTerminalTab(session, window);
  } catch (e: any) {
    return `Failed: ${e.message}\nRun manually:\n  tmux attach -t ${target}`;
  }
}
