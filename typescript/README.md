# Symphony — TypeScript reference implementation

TypeScript implementation of the [Symphony (Claude Code + GitHub) spec](../SPEC-CLAUDE-GITHUB.md).

Symphony is a long-running automation service that continuously reads work from GitHub Issues,
creates an isolated workspace per issue, and runs a Claude Code session inside it. This
implementation ships with a beautiful, real-time web dashboard (`http://127.0.0.1:4747/`).

## Requirements

- Node.js ≥ 20
- [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI installed on `PATH`
- (Optional but recommended) [`gh`](https://cli.github.com/) CLI for tracker writes from inside
  Claude Code sessions
- A GitHub token exported as `GITHUB_TOKEN`, set in a `.env` file (see below), or referenced
  explicitly in your `WORKFLOW.md`
- Claude Code credentials (`ANTHROPIC_API_KEY`, OAuth login, or Bedrock/Vertex creds)

### Using a `.env` file

Symphony auto-loads environment variables from these files (first-match wins; shell exports
always override):

1. `<workflow-dir>/.env.local`
2. `<workflow-dir>/.env`
3. `<cwd>/.env.local`
4. `<cwd>/.env`

Copy [`.env.example`](./.env.example) to `.env` next to your `WORKFLOW.md` and drop your
`GITHUB_TOKEN` there. Skip auto-loading with `--no-env-file`, or point at custom files with
`--env-file path/to/file` (repeatable).

## Install & run

```bash
cd typescript
npm install
npm run build
npm start -- /path/to/your-repo/WORKFLOW.md
```

Or run from source via `tsx`:

```bash
npm run dev -- /path/to/your-repo/WORKFLOW.md
```

The dashboard becomes available at `http://127.0.0.1:4747/`.

### CLI options

```
symphony [path-to-WORKFLOW.md] [options]

  --host <addr>      HTTP/UI bind host (default 127.0.0.1)
  --port <num>       HTTP/UI bind port (default 4747)
  --no-ui            Don't serve the dashboard
  --log-level <lvl>  debug|info|warn|error (default info)
```

When the workflow argument is omitted, Symphony looks for `./WORKFLOW.md` in the current
working directory (per spec §5.1).

## Configuration

All runtime behavior lives in `WORKFLOW.md` at the root of your repository. See
[`WORKFLOW.example.md`](./WORKFLOW.example.md) for a fully-annotated example. Symphony
hot-reloads the file on change.

Minimum required fields:

```yaml
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  repository: owner/repo

claude:
  command: claude
```

## Architecture

The implementation follows the layering recommended by the spec:

| Layer             | Module                              |
| ----------------- | ------------------------------------ |
| Policy            | `WORKFLOW.md` (your repo)            |
| Configuration     | `src/workflow/{loader,config}.ts`    |
| Coordination      | `src/orchestrator/orchestrator.ts`   |
| Execution         | `src/agent/claude.ts`, `src/workspace/manager.ts` |
| Integration       | `src/tracker/github.ts`              |
| Observability     | `src/logging/logger.ts`, `src/http/server.ts`, `web/` |

The orchestrator is the single authority for scheduling state. Workers run as Promises
inside the main Node.js process and communicate state changes back to the orchestrator.
Each Claude Code turn is a fresh `bash -lc "claude -p … --output-format stream-json --verbose"`
subprocess; continuation turns within the same worker run use `--resume <session_id>`.

## HTTP API

| Endpoint                       | Description                              |
| ------------------------------- | ---------------------------------------- |
| `GET /api/v1/state`             | Snapshot (running, retrying, totals)     |
| `GET /api/v1/events`            | Server-Sent Events stream                |
| `GET /api/v1/issue/<ident>`     | URL-encoded `<owner>/<repo>#<number>`    |
| `GET /api/v1/logs?limit=200`    | Recent log lines                         |
| `POST /api/v1/refresh`          | Trigger an immediate poll tick           |

## Trust posture

This implementation defaults to `permission_mode: bypassPermissions` and does not filter
allowed tools, matching the "high-trust" example in spec §10.5. Run it only against
trusted repositories. To tighten the harness, set in your `WORKFLOW.md`:

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
    - Bash(npm:test*)
```

## Conformance notes (vs. spec §17/§18)

- **REQUIRED**: workflow loader, typed config, dynamic reload, single-authority orchestrator,
  GitHub candidate fetch / state refresh / terminal sweep, workspace manager + hooks,
  Claude Code stream-json runner, exponential retry queue, structured logging, snapshot API.
- **RECOMMENDED**: HTTP server + SSE dashboard, ETag-aware tracking (the GraphQL endpoint
  is always used for candidates per the spec; REST polling is not exercised).
- **Deferred**: GitHub App credential token minting (config plumbing is in place; minting
  is left for a follow-up), Projects v2 priority field reads beyond single-select/number,
  `github_graphql` MCP extension, restart-recovery of retry queue.

## License

Apache 2.0, same as the parent repository.
