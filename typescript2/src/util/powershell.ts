// PowerShell integration helpers.
//
// This implementation runs every workspace hook and every Claude Code turn
// through PowerShell instead of `bash -lc`. On Windows that means hooks and the
// agent launcher use native PowerShell syntax (`$env:NAME`, `Write-Error`,
// etc.). Symphony auto-detects PowerShell 7+ (`pwsh`) and falls back to Windows
// PowerShell 5.1 (`powershell.exe`).

import { spawnSync } from "node:child_process";

let cachedExe: string | null = null;

/**
 * Resolve the PowerShell executable to use.
 *
 * Precedence:
 *   1. `SYMPHONY_POWERSHELL` environment override.
 *   2. `pwsh` (PowerShell 7+, cross-platform) when available.
 *   3. `powershell.exe` / `powershell` (Windows PowerShell 5.1).
 */
export function powershellExecutable(): string {
  if (cachedExe) return cachedExe;

  const override = process.env.SYMPHONY_POWERSHELL?.trim();
  if (override) {
    cachedExe = override;
    return cachedExe;
  }

  for (const candidate of ["pwsh", "powershell.exe", "powershell"]) {
    try {
      const probe = spawnSync(
        candidate,
        ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
        { stdio: ["ignore", "ignore", "ignore"], timeout: 6000, windowsHide: true },
      );
      if (probe.status === 0) {
        cachedExe = candidate;
        return cachedExe;
      }
    } catch {
      // try next candidate
    }
  }

  // Last-resort default — launch failures will surface as a clear runtime error.
  cachedExe = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return cachedExe;
}

/** Base flags for non-interactive, profile-free PowerShell execution. */
export const PWSH_BASE_FLAGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
] as const;

/**
 * Quote a string as a PowerShell single-quoted literal.
 *
 * PowerShell's tokenizer treats the ASCII apostrophe (U+0027) *and* the
 * typographic single quotes U+2018 / U+2019 / U+201B as interchangeable
 * string delimiters. Every character in that class must therefore be doubled
 * — otherwise a smart quote inside the content silently terminates the string.
 */
export function psQuote(s: string): string {
  return "'" + String(s).replace(/['‘’‛]/g, (m) => m + m) + "'";
}

/**
 * Build a PowerShell command line: `<command> <quoted args...>`.
 *
 * `command` is treated as a raw command fragment (it may itself carry flags,
 * per `claude.command` in the spec); only the appended `args` are quoted.
 */
export function buildPsCommandLine(command: string, args: string[]): string {
  return [command, ...args.map(psQuote)].join(" ");
}

/**
 * Prologue prepended to every native PowerShell invocation so that UTF-8
 * stream-json output from the Claude Code subprocess survives the pipeline
 * regardless of the host console code page.
 */
export const PWSH_UTF8_PROLOGUE =
  "try { [Console]::OutputEncoding = [Console]::InputEncoding = " +
  "[System.Text.Encoding]::UTF8 } catch {}; " +
  "$OutputEncoding = [System.Text.Encoding]::UTF8;";
