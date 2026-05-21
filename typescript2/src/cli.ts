#!/usr/bin/env node
// Symphony CLI entry. Loads WORKFLOW.md, starts the orchestrator + HTTP UI, and
// watches the workflow file for hot-reload.

import path from "node:path";
import fs from "node:fs/promises";
import chokidar from "chokidar";
import { loadWorkflow, WorkflowError } from "./workflow/loader.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { SymphonyHttpServer } from "./http/server.js";
import { log, setLogLevel } from "./logging/logger.js";
import { defaultEnvSearch, loadDotenv } from "./util/dotenv.js";
import { powershellExecutable } from "./util/powershell.js";

interface CliOptions {
  workflowPath: string;
  host: string;
  port: number;
  noUi: boolean;
  envFiles: string[] | null; // explicit; null = use defaults
  noEnvFile: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    workflowPath: path.resolve(process.cwd(), "WORKFLOW.md"),
    host: process.env.SYMPHONY_HOST || "127.0.0.1",
    port: parseInt(process.env.SYMPHONY_PORT || "4747", 10),
    noUi: false,
    envFiles: null,
    noEnvFile: false,
  };
  const explicitEnv: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") {
      opts.host = argv[++i] ?? opts.host;
    } else if (a === "--port") {
      opts.port = parseInt(argv[++i] ?? String(opts.port), 10);
    } else if (a === "--no-ui") {
      opts.noUi = true;
    } else if (a === "--env-file") {
      const v = argv[++i];
      if (v) explicitEnv.push(path.resolve(v));
    } else if (a === "--no-env-file") {
      opts.noEnvFile = true;
    } else if (a === "--log-level") {
      setLogLevel(argv[++i] as any);
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 0) opts.workflowPath = path.resolve(positionals[0]);
  if (explicitEnv.length > 0) opts.envFiles = explicitEnv;
  return opts;
}

function printHelp() {
  console.log(`Symphony (TypeScript · PowerShell edition)

Usage: symphony [path-to-WORKFLOW.md] [options]

Options:
  --host <addr>      HTTP/UI bind host (default 127.0.0.1)
  --port <num>       HTTP/UI bind port (default 4747)
  --no-ui            Don't serve the dashboard
  --env-file <path>  Load environment variables from this file (repeatable)
  --no-env-file      Skip automatic .env loading
  --log-level <lvl>  debug|info|warn|error (default info)
  -h, --help         Show help

Environment:
  GITHUB_TOKEN         Default GitHub auth token (referenced via $GITHUB_TOKEN in WORKFLOW.md)
  ANTHROPIC_API_KEY    Claude Code auth (forwarded to the subprocess)
  SYMPHONY_POWERSHELL  Override the PowerShell executable (defaults: pwsh, then powershell.exe)

Automatic .env loading (highest priority first):
  <workflow-dir>/.env.local
  <workflow-dir>/.env
  <cwd>/.env.local
  <cwd>/.env
Existing process.env values are never overwritten — shell exports always win.

Workspace hooks and each Claude Code turn run through PowerShell, not bash.

When WORKFLOW.md is missing, the service refuses to start.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Load .env before any config resolution so $VAR references resolve.
  if (!opts.noEnvFile) {
    const files = opts.envFiles ?? defaultEnvSearch(opts.workflowPath);
    const result = loadDotenv({ files });
    if (result.loaded.length > 0) {
      log.info("dotenv_loaded", {
        files: result.loaded.join(","),
        vars: result.variables.length,
      });
    }
  }

  log.info("symphony_starting", {
    workflow: opts.workflowPath,
    host: opts.host,
    port: opts.port,
    ui: !opts.noUi,
    powershell: powershellExecutable(),
  });

  try {
    await fs.access(opts.workflowPath);
  } catch {
    log.error("workflow_not_found", { path: opts.workflowPath });
    console.error(`WORKFLOW.md not found at ${opts.workflowPath}`);
    process.exit(1);
  }

  let workflow;
  try {
    workflow = await loadWorkflow(opts.workflowPath);
  } catch (e: any) {
    if (e instanceof WorkflowError) {
      log.error("workflow_load_failed", { code: e.code, error: e.message });
    } else {
      log.error("workflow_load_failed", { error: e?.message });
    }
    process.exit(1);
  }

  const orchestrator = new Orchestrator(workflow);
  await orchestrator.start();

  let httpServer: SymphonyHttpServer | null = null;
  if (!opts.noUi) {
    httpServer = new SymphonyHttpServer(orchestrator, { host: opts.host, port: opts.port });
    try {
      await httpServer.start();
      log.info("symphony_dashboard_ready", { url: `http://${opts.host}:${opts.port}/` });
      console.log(`\n  ▶  Symphony dashboard:  http://${opts.host}:${opts.port}/\n`);
    } catch (e: any) {
      log.error("http_listen_failed", { error: e?.message });
    }
  }

  // Workflow hot-reload
  const watcher = chokidar.watch(opts.workflowPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  watcher.on("change", async () => {
    try {
      const next = await loadWorkflow(opts.workflowPath);
      orchestrator.applyWorkflow(next);
      log.info("workflow_reloaded");
    } catch (e: any) {
      log.error("workflow_reload_failed", { error: e?.message });
    }
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("symphony_shutdown", { signal });
    try {
      await watcher.close();
    } catch {}
    if (httpServer) {
      try {
        await httpServer.stop();
      } catch {}
    }
    try {
      await orchestrator.stop();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("symphony_fatal", { error: e?.message, stack: e?.stack });
  process.exit(1);
});
