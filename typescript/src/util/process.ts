// Cross-platform process-tree kill.
//
// On Windows, a parent SIGTERM/SIGKILL via Node's child_process kills only the
// immediate child — grandchildren survive and keep file/directory handles open
// (notably the worker's cwd, which then can't be deleted). We shell out to
// `taskkill /T /F` to tear down the whole tree.
//
// On POSIX, we walk descendants with `pgrep -P` and signal post-order so that
// children are signaled before their parents (which would otherwise reparent
// to PID 1 before we can reach them).

import { spawn, execFileSync } from "node:child_process";

export function treeKill(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  if (!Number.isFinite(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    // taskkill always force-kills with /F; /T includes the whole tree. The
    // POSIX signal name is ignored on Windows.
    try {
      const p = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      p.unref();
    } catch {}
    return;
  }

  const descendants: number[] = [];
  collectDescendants(pid, descendants);
  for (const child of descendants) {
    try { process.kill(child, signal); } catch {}
  }
  try { process.kill(pid, signal); } catch {}
}

function collectDescendants(pid: number, out: number[]): void {
  let raw: string;
  try {
    raw = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const child = Number(line.trim());
    if (!Number.isFinite(child) || child <= 0) continue;
    collectDescendants(child, out);
    out.push(child);
  }
}
