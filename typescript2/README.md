# Symphony — TypeScript reference implementation (PowerShell edition)

A TypeScript implementation of the
[Symphony — Claude Code + GitHub spec](../SPEC-CLAUDE-GITHUB.md), tuned for
Windows: **every workspace hook and every Claude Code turn runs through
PowerShell instead of `bash`.**

Symphony is a long-running automation service. It continuously reads work from
GitHub Issues, creates an isolated workspace per issue, and runs a Claude Code
session inside it. This build ships with a real-time, elegant web dashboard at
`http://127.0.0.1:4747/`.

```
┌── poll GitHub Issues ──┐      ┌── per-issue workspace ──┐      ┌── Claude Code ──┐
│  active-state filter   │ ───▶ │  PowerShell hooks       │ ───▶ │  stream-json     │
│  priority sort         │      │  (after_create/run/…)   │      │  --resume turns  │
└────────────────────────┘      └─────────────────────────┘      └──────────────────┘
                         │                                                │
                         └──────────── orchestrator state ────────────────┘
                                            │
                                   web dashboard (SSE)
```

## What's different in the PowerShell edition

| Spec convention                    | This implementation                                    |
| ---------------------------------- | ------------------------------------------------------ |
| Hooks run via `bash -lc`           | Hooks run as `.ps1` scripts via PowerShell             |
| Agent launched via `bash -lc`      | Agent launched via `powershell -Command`               |
| Hook syntax (`${VAR}`)             | PowerShell syntax (`$env:VAR`, `$($env:VAR)`)          |

PowerShell is auto-detected: `pwsh` (PowerShell 7+) is preferred, with a
fallback to `powershell.exe` (Windows PowerShell 5.1). Override it with the
`SYMPHONY_POWERSHELL` environment variable.

## Requirements

- Node.js ≥ 20
- PowerShell — `pwsh` 7+ or Windows PowerShell 5.1 (`powershell.exe`)
- [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI on `PATH`
- (Recommended) [`gh`](https://cli.github.com/) CLI for tracker writes from
  inside Claude Code sessions
- `git` on `PATH` (used by the example workspace hooks)
- A GitHub token in `GITHUB_TOKEN` (a `.env` file works — see below)
- Claude Code credentials (`ANTHROPIC_API_KEY`, OAuth login, or Bedrock/Vertex)

## Install & run

```powershell
cd typescript2
npm install
npm run build
npm start -- .\WORKFLOW.md
```

Or run straight from source with `tsx`:

```powershell
npm run dev -- .\WORKFLOW.md
```

Then open the dashboard at **http://127.0.0.1:4747/**.

When the workflow argument is omitted, Symphony looks for `./WORKFLOW.md` in the
current working directory (spec §5.1).

### CLI options

```
symphony [path-to-WORKFLOW.md] [options]

  --host <addr>        HTTP/UI bind host (default 127.0.0.1)
  --port <num>         HTTP/UI bind port (default 4747)
  --no-ui              Don't serve the dashboard
  --env-file <path>    Load environment variables from this file (repeatable)
  --no-env-file        Skip automatic .env loading
  --log-level <lvl>    debug|info|warn|error (default info)
  -h, --help           Show help
```

### Environment / `.env`

Symphony auto-loads environment variables from these files (first match wins;
shell exports always override):

1. `<workflow-dir>/.env.local`
2. `<workflow-dir>/.env`
3. `<cwd>/.env.local`
4. `<cwd>/.env`

Copy [`.env.example`](./.env.example) to `.env` and drop in your `GITHUB_TOKEN`.

## Configuration — `WORKFLOW.md`

All runtime behavior lives in [`WORKFLOW.md`](./WORKFLOW.md): the YAML front
matter is typed config, the Markdown body is the per-issue prompt template.
Symphony hot-reloads the file on change.

Workspace hooks are **PowerShell scripts**. The runtime injects these variables,
readable as `$env:NAME`:

`SYMPHONY_ISSUE_ID`, `SYMPHONY_ISSUE_IDENTIFIER`, `SYMPHONY_ISSUE_NUMBER`,
`SYMPHONY_ISSUE_REPOSITORY`, `SYMPHONY_ISSUE_TITLE`, `SYMPHONY_ISSUE_BRANCH_NAME`,
`SYMPHONY_ISSUE_STATE`, `SYMPHONY_ATTEMPT`, `SYMPHONY_WORKSPACE_PATH`.

```yaml
hooks:
  after_create: |
    git clone --depth=1 "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/$($env:SYMPHONY_ISSUE_REPOSITORY).git" .
    git config user.name "Symphony Bot"
```

Each hook is wrapped with `$ErrorActionPreference = 'Stop'`, so a failing
PowerShell cmdlet aborts the hook; the hook's exit code otherwise tracks the
last native command (mirroring `bash -lc` semantics).

## Dashboard

The bundled web UI (`web/`) is a real-time React app served by Symphony itself:

- **Metric strip** — active sessions, retry queue, tokens processed (with cache
  efficiency), cumulative cost.
- **Live sessions** — one card per running Claude Code session: turn-progress
  ring, token-composition bar, status, and an expandable stream-json event log.
- **Right rail** — retry queue with countdowns, workflow summary, and a live
  agent-activity feed.

It connects over Server-Sent Events and reconnects automatically.

## HTTP API

| Endpoint                      | Description                          |
| ----------------------------- | ------------------------------------ |
| `GET /api/v1/state`           | Snapshot (running, retrying, totals) |
| `GET /api/v1/events`          | Server-Sent Events stream            |
| `GET /api/v1/issue/<ident>`   | URL-encoded `<owner>/<repo>#<number>`|
| `GET /api/v1/logs?limit=200`  | Recent structured log lines          |
| `POST /api/v1/refresh`        | Trigger an immediate poll tick       |

## Architecture

| Layer         | Module                                                  |
| ------------- | ------------------------------------------------------- |
| Policy        | `WORKFLOW.md`                                           |
| Configuration | `src/workflow/{loader,config}.ts`                       |
| Coordination  | `src/orchestrator/orchestrator.ts`                      |
| Execution     | `src/agent/claude.ts`, `src/workspace/manager.ts`, `src/util/powershell.ts` |
| Integration   | `src/tracker/github.ts`                                 |
| Observability | `src/logging/logger.ts`, `src/http/server.ts`, `web/`   |

The orchestrator is the single authority for scheduling state. Workers run as
Promises in the main Node.js process. Each Claude Code turn is a fresh
`powershell -Command "claude -p … --output-format stream-json --verbose"`
subprocess; continuation turns within a worker run reuse `--resume <session_id>`.

## Trust posture

This implementation defaults to `permission_mode: bypassPermissions` with no
allowed-tools filter — the "high-trust" example from spec §10.5. Run it only
against trusted repositories. To tighten the harness, set in `WORKFLOW.md`:

```yaml
claude:
  permission_mode: default
  allowed_tools:
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - Bash(git:*)
    - Bash(gh:*)
```

## Conformance notes (vs. spec §17 / §18)

- **REQUIRED** — workflow loader, typed config, dynamic reload, single-authority
  orchestrator, GitHub candidate fetch / state refresh / terminal sweep,
  workspace manager + hooks, Claude Code stream-json runner, exponential retry
  queue, structured logging, snapshot API.
- **RECOMMENDED** — HTTP server + SSE dashboard.
- **Deferred** — GitHub App installation-token minting, `github_graphql` MCP
  extension, restart-recovery of the retry queue.

## License

Apache 2.0, same as the parent repository.
