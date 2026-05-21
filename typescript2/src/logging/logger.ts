// Structured key=value logger (Section 13).
//
// Stable, easy-to-grep format; never logs secrets.

const REDACT_KEYS = new Set([
  "github_token",
  "anthropic_api_key",
  "api_key",
  "token",
  "private_key",
  "password",
  "secret",
]);

function fmt(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    if (/[\s"=]/.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: LogLevel = (process.env.SYMPHONY_LOG_LEVEL as LogLevel) || "info";

export function setLogLevel(lvl: LogLevel) {
  minLevel = lvl;
}

type LogContext = Record<string, unknown>;
type LogSink = (line: string) => void;

const sinks: LogSink[] = [
  (line) => {
    try {
      process.stdout.write(line + "\n");
    } catch {
      // sink failure must not crash service
    }
  },
];

const recentLines: string[] = [];
const MAX_RECENT = 500;

sinks.push((line) => {
  recentLines.push(line);
  if (recentLines.length > MAX_RECENT) recentLines.splice(0, recentLines.length - MAX_RECENT);
});

export function getRecentLogLines(limit = 100): string[] {
  return recentLines.slice(-limit);
}

export function addLogSink(sink: LogSink) {
  sinks.push(sink);
}

function emit(level: LogLevel, msg: string, ctx?: LogContext) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const parts: string[] = [
    `ts=${new Date().toISOString()}`,
    `level=${level}`,
    `msg=${fmt(msg)}`,
  ];
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (REDACT_KEYS.has(k.toLowerCase())) continue;
      parts.push(`${k}=${fmt(v)}`);
    }
  }
  const line = parts.join(" ");
  for (const sink of sinks) {
    try {
      sink(line);
    } catch {
      // ignore sink failures
    }
  }
}

export const log = {
  debug: (msg: string, ctx?: LogContext) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit("error", msg, ctx),
};
