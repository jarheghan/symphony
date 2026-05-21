import os from "node:os";
import path from "node:path";

export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// Resolve a config value of the form "$VAR_NAME" against process.env.
// Returns null for empty/missing. Non-$ values are returned unchanged.
export function resolveVar(value: string | undefined | null): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  if (trimmed.startsWith("$") && /^\$[A-Z_][A-Z0-9_]*$/i.test(trimmed)) {
    const name = trimmed.slice(1);
    const v = process.env[name];
    return v == null || v === "" ? null : v;
  }
  return trimmed === "" ? null : value;
}

// Sanitize an issue identifier to a workspace key per spec 4.2.
export function workspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function normalizeWorkspacePath(root: string, key: string): string {
  const abs = path.resolve(root);
  const candidate = path.resolve(abs, key);
  // Must remain inside root
  const rel = path.relative(abs, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`workspace path escapes root: ${candidate}`);
  }
  return candidate;
}
