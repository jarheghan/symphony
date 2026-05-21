// Minimal .env loader. No dependency. Lines like KEY=value (with optional
// quotes). Existing process.env values are NOT overwritten — so explicit
// shell exports always win.

import fs from "node:fs";
import path from "node:path";

export interface LoadEnvOptions {
  files: string[]; // absolute paths to try (in order)
  override?: boolean;
}

export interface LoadEnvResult {
  loaded: string[]; // paths actually read
  variables: string[]; // keys set
}

export function loadDotenv(opts: LoadEnvOptions): LoadEnvResult {
  const loaded: string[] = [];
  const variables: string[] = [];
  for (const file of opts.files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    loaded.push(file);
    for (const [k, v] of parse(raw)) {
      if (!opts.override && process.env[k] != null) continue;
      process.env[k] = v;
      variables.push(k);
    }
  }
  return { loaded, variables };
}

function parse(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // strip inline comment for unquoted values
    if (value && value[0] !== '"' && value[0] !== "'") {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    // strip surrounding quotes; expand \n inside double quotes
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
        if (first === '"') {
          value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
        }
      }
    }
    out.push([key, value]);
  }
  return out;
}

export function defaultEnvSearch(workflowPath: string): string[] {
  const wfDir = path.dirname(path.resolve(workflowPath));
  const cwd = process.cwd();
  // Dedup while preserving order: workflow dir first, then cwd
  const order = [
    path.join(wfDir, ".env.local"),
    path.join(wfDir, ".env"),
    path.join(cwd, ".env.local"),
    path.join(cwd, ".env"),
  ];
  return Array.from(new Set(order));
}
