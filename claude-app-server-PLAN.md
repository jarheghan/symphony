# Claude Code App-Server — Implementation Plan

> Hand this file to a coding agent. It defines the goal, the architecture, the protocol
> mapping, the file layout, and a phased build order. Each phase is independently shippable.

## 1. Goal

Build a **Claude Code App-Server**: a long-running subprocess that speaks JSON-RPC 2.0 over
newline-delimited stdio, equivalent in shape to the [Codex
app-server](https://developers.openai.com/codex/app-server), but driving the
[`@anthropic-ai/claude-agent-sdk`](https://docs.anthropic.com/en/api/agent-sdk) underneath.

Why: Symphony (and other orchestrators) currently invoke `claude` once per turn and re-attach
via `--resume <session_id>`. That works but has per-turn process-spawn overhead, no mid-turn
approval channel, and no way to surface tool/hook events as structured JSON-RPC notifications.
An app-server fixes all three, and gives Symphony parity with the Codex integration path it
was originally designed around.

**Non-goal:** Re-implement everything Codex's app-server does (Windows sandbox, plugin
marketplace, ChatGPT device login, etc.). Ship the surface Symphony and similar orchestrators
actually need. Defer the rest.

## 2. Tech Stack

- **Language:** TypeScript on Node.js ≥ 20.
  - Rationale: the canonical Claude Agent SDK is `@anthropic-ai/claude-agent-sdk` (TS); the
    Python SDK is a near-mirror but TS is the lowest-friction integration today.
- **Runtime SDK:** `@anthropic-ai/claude-agent-sdk` — used for `query()` (turn loop) and the
  `canUseTool` permission callback.
- **JSON-RPC framing:** newline-delimited JSON (JSONL) on stdin/stdout.
- **Transport (M0):** stdio only. WebSocket / Unix socket land in M3 as optional.
- **Persistence:** JSONL thread logs under `${XDG_DATA_HOME:-~/.local/share}/claude-app-server/threads/<thread_id>.jsonl`.
- **Tests:** `vitest` for unit tests, plus an end-to-end harness that pipes JSONL fixtures
  through the server binary.
- **Distribution:** publishable `npm` package with a `bin` entry `claude-app-server`.
  Invocation pattern: `npx claude-app-server` or installed globally.

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        claude-app-server                            │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │ JSONL framer │──▶│ JSON-RPC mux │──▶│ Method router          │  │
│  │ (stdio)      │◀──│ (id ↔ promise)│◀──│  - thread/*            │  │
│  └──────────────┘   └──────────────┘   │  - turn/*              │  │
│                                         │  - skills/*            │  │
│                              ┌─────────│  - mcp*                │  │
│                              │          │  - account/*           │  │
│                              ▼          │  - fs/* (M3)           │  │
│                     ┌──────────────────┐│  - command/* (M3)      │  │
│                     │ Thread Registry  ││  - hooks/* (M2)        │  │
│                     │  - active map    │└────────────────────────┘  │
│                     │  - JSONL log     │           │                │
│                     └──────────────────┘           │                │
│                              │                     ▼                │
│                              │           ┌────────────────────────┐ │
│                              └──────────▶│ SDK driver per thread  │ │
│                                          │  - query() async iter  │ │
│                                          │  - canUseTool callback │ │
│                                          │  - hook bridge         │ │
│                                          └────────────────────────┘ │
│                                                    │                │
│                                                    ▼                │
│                                          ┌────────────────────────┐ │
│                                          │ Event translator       │ │
│                                          │  SDK msgs → JSON-RPC   │ │
│                                          │  notifications         │ │
│                                          └────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

Single Node process. Single owner of stdout (the JSON-RPC writer). All SDK message streams
funnel through one translator that emits typed `item/*`, `turn/*`, `thread/*` notifications.
All pending JSON-RPC requests live in one promise table keyed by id.

## 4. Protocol Mapping (Codex → Claude Code)

The wire shape MUST match Codex's spec where the concept exists. Field names are kept
identical so clients can be ported with minimal churn. Where Codex has no direct equivalent in
Claude Code, this plan substitutes the closest analog and documents the gap.

### 4.1 Identical (port verbatim from Codex)

- Transport, JSON-RPC 2.0 framing, error codes (`-32601` method-not-found, `-32700`
  not-initialized, `-32001` overloaded).
- `initialize` + `initialized` handshake. Response carries `userAgent`, `platformFamily`,
  `platformOs`. Capabilities object: `experimentalApi`, `optOutNotificationMethods`.
- Core primitives: thread, turn, item.
- Lifecycle notifications: `thread/started`, `thread/status/changed`, `turn/started`,
  `turn/completed`, `item/started`, `item/completed`, `item/*/delta`.
- `serverRequest/resolved` notification after the client answers a server-initiated request.
- Thread management methods: `thread/start`, `thread/resume`, `thread/read`, `thread/list`,
  `thread/turns/list`, `thread/unsubscribe`, `thread/archive`, `thread/unarchive`,
  `thread/rollback`, `thread/metadata/update`.
- Turn methods: `turn/start`, `turn/steer`, `turn/interrupt`, `thread/inject_items`.
- Token usage notification: `thread/tokenUsage/updated`.

### 4.2 Adapted (concept exists, shape changes)

| Codex                                       | Claude Code app-server                                     | Notes |
|---------------------------------------------|------------------------------------------------------------|-------|
| `approvalPolicy: never\|unlessTrusted\|onRequest` | `permissionMode: bypassPermissions\|acceptEdits\|default\|plan` | Pass-through to SDK `permissionMode` |
| `sandbox: dangerFullAccess\|readOnly\|workspaceWrite\|externalSandbox` | `permissionMode` + `allowedTools` / `disallowedTools` arrays | Claude has no native sandbox; rely on permission system + host-level isolation |
| `sandboxPolicy.writableRoots`               | `addDir: string[]` (maps to SDK `--add-dir`)              | Extra readable dirs only; writes still gated by permission_mode |
| `sandboxPolicy.networkAccess`               | (not modeled)                                              | Host-level concern; document as "use container/firejail/etc." |
| `model: "gpt-5.4"`                          | `model: "claude-sonnet-4-6"` etc.                          | Default to latest Sonnet at build time |
| `effort: low\|medium\|high`                 | `thinking: { type: "enabled", budget_tokens: N }`          | Map low/medium/high → 5k/15k/40k token budgets |
| `personality`                               | (not modeled in M1; add `systemPrompt: string` in M2)      | Claude has system prompts; not a discrete enum |
| `item/commandExecution/requestApproval`     | Same method name; payload is Claude's `Bash` tool input    | Triggered from SDK `canUseTool` callback when tool is `Bash` |
| `item/fileChange/requestApproval`           | Same method name; triggered for `Edit`/`Write`/`MultiEdit` | |
| `tool/requestUserInput`                     | Same — emitted when the model uses an "ask user" pattern   | |
| `command/exec` (sandboxed exec)             | (M3 only) maps to spawning under the server process; not the Bash tool | Optional convenience for clients that want exec without going through a turn |

### 4.3 Replaced (Claude-native concept)

- **Hooks**: Claude Code's hooks system (PreToolUse, PostToolUse, Stop, etc.) is exposed via:
  - `hooks/list` — enumerate configured hooks
  - `hooks/config/write` — enable/disable a hook
  - `hooks/event` notification — emitted whenever a hook fires, with the matcher and result
- **Skills**: Direct pass-through; Claude Code has skills with the same shape as Codex skills
  (`SKILL.md` with frontmatter). Methods: `skills/list`, `skills/config/write`, `skills/changed`.
- **MCP**: Direct pass-through. Methods: `mcpServerStatus/list`, `mcpServer/tool/call`,
  `mcpServer/resource/read`, `config/mcpServer/reload`. `mcpServer/oauth/login` lands in M2.

### 4.4 Deferred / not in scope

These exist in Codex but are out of scope unless explicitly added later. Document them as
`Method not found` errors:

- `windowsSandbox/setupStart` — host concern; Claude has no native sandbox bootstrap.
- `process/spawn` and `process/*` — unsandboxed subprocess plane; not needed for orchestrator
  use cases. Revisit if Symphony or another client asks.
- `plugin/*`, `marketplace/*` — defer to Claude Code's own plugin mechanism via the CLI.
- `externalAgentConfig/detect`/`import` — defer; clients can scan `AGENTS.md`/`CLAUDE.md`
  themselves.
- `feedback/upload` — out of scope.
- `account/login/start type=chatgpt*` — Anthropic auth only:
  - `type: "apiKey"` (env or explicit)
  - `type: "oauth"` (Claude.ai login — defer to M3; for M1 require API key)

### 4.5 Account & rate limits

```ts
// M1
account/read         → { account: { type: "apiKey"|null, identifier: string|null } }
account/login/start  → { type: "apiKey", apiKey: string } → success/failure
account/logout       → clears in-memory + emits account/updated
account/rateLimits/read → snapshot of last seen anthropic-ratelimit-* headers
account/rateLimits/updated (notification) → emitted after every Anthropic API response
```

Rate-limit snapshot fields (from `anthropic-ratelimit-*` headers):
- `requestsLimit`, `requestsRemaining`, `requestsResetAt`
- `tokensLimit`, `tokensRemaining`, `tokensResetAt`
- `inputTokensLimit`, `inputTokensRemaining`, `inputTokensResetAt`
- `outputTokensLimit`, `outputTokensRemaining`, `outputTokensResetAt`

## 5. Item-Type Mapping (SDK message → JSON-RPC item)

The translator converts Claude Agent SDK messages into Codex-shaped item notifications.

| SDK message                                  | Emitted JSON-RPC                                                         |
|----------------------------------------------|--------------------------------------------------------------------------|
| `SystemMessage` subtype `init`               | `thread/started` (first time) and capability cache; not echoed per turn  |
| `AssistantMessage` text block                | `item/started` `type=agentMessage` → `item/agentMessage/delta` × N → `item/completed` |
| `AssistantMessage` thinking block            | `item/started` `type=reasoning` → `item/reasoning/textDelta` × N → `item/completed` |
| `AssistantMessage` tool_use `Bash`           | `item/started` `type=commandExecution` (with `command`, `cwd`) → optional approval request → output deltas via subsequent `tool_result` echo → `item/completed` |
| `AssistantMessage` tool_use `Read`           | `item/started` `type=fileChange` (read-only flavor) → `item/completed`   |
| `AssistantMessage` tool_use `Edit`/`Write`/`MultiEdit` | `item/started` `type=fileChange` → optional approval request → `item/completed` with diff |
| `AssistantMessage` tool_use `WebFetch`/`WebSearch` | `item/started` `type=webSearch` → `item/completed`                  |
| `AssistantMessage` tool_use MCP tool         | `item/started` `type=mcpToolCall` (server, tool, args) → `item/completed` |
| `AssistantMessage` tool_use other native     | `item/started` `type=dynamicToolCall`                                    |
| `UserMessage` tool_result                    | Closes the matching item (`item/completed` with status/output)           |
| `ResultMessage`                              | `turn/completed` + final `thread/tokenUsage/updated`                     |

Approval flow:

```text
SDK calls canUseTool(toolName, toolInput) on tool execution
  │
  ├─ if permissionMode == "bypassPermissions" → return { behavior: "allow", updatedInput: toolInput }
  ├─ if tool is in allowedTools → allow
  ├─ if tool is in disallowedTools → deny
  └─ otherwise:
       ├─ emit JSON-RPC request item/commandExecution/requestApproval (or fileChange/requestApproval)
       │   with a fresh id; await client response
       ├─ on result "accept"|"acceptForSession" → allow; if acceptForSession, cache for thread lifetime
       ├─ on result "decline" → deny
       └─ on result "cancel" → interrupt the turn
```

## 6. Implementation Phases

Each phase produces a runnable binary that passes its own test suite.

### M0 — Walking skeleton (2-3 days)
- Empty Node project: `package.json`, `tsconfig.json`, `bin/claude-app-server.js`.
- JSONL framer on stdin/stdout with backpressure-safe writer.
- JSON-RPC 2.0 envelope: request/response/notification + error codes.
- `initialize` + `initialized` handshake with version/platform reporting.
- `method not found` error for unknown methods.
- One end-to-end test: spawn the binary, send `initialize`, read response, send `initialized`,
  send a bogus method, assert `-32601`.

### M1 — Single-thread happy path (1 week)
- Wire in `@anthropic-ai/claude-agent-sdk`.
- `thread/start` creates a new session (deterministic UUID), writes empty JSONL log.
- `turn/start` calls `query({ prompt, options: { model, permissionMode, allowedTools,
  disallowedTools, addDir, mcpServers, cwd } })`.
- Translator covers: `init`, assistant text, assistant tool_use (Bash/Read/Edit/Write/MultiEdit),
  user tool_result, result. Emits the item lifecycle described in §5.
- `thread/tokenUsage/updated` after each assistant message and on result.
- `turn/completed` with status `completed|failed|interrupted`.
- `turn/interrupt` aborts the active AsyncGenerator.
- `thread/resume` opens a session by id; SDK supports `resume`/`continue` flags.
- JSONL log gets one line per SDK message for replay/debugging.
- Tests: golden-file replay of recorded SDK message streams; assert exact JSON-RPC output.

### M2 — Multi-thread, approvals, hooks (1 week)
- Thread registry with concurrent live sessions, each with its own AsyncGenerator.
- Approval bridge via SDK `canUseTool` callback → `item/commandExecution/requestApproval` /
  `item/fileChange/requestApproval` server-initiated requests.
- `acceptForSession` cache scoped to a thread id.
- `permissionMode: default` is now genuinely useful (without bypass, the SDK calls
  `canUseTool` for each tool).
- Hook bridge: `hooks/list`, `hooks/config/write`, `hooks/event` notifications by tapping
  into the SDK's hook outputs (the SDK exposes hook results via the system init or via
  pre/post-tool events that the server forwards).
- `thread/list`, `thread/read`, `thread/turns/list`, `thread/archive`, `thread/unarchive`,
  `thread/metadata/update`, `thread/rollback`.
- `turn/steer` (append user input mid-stream — supported by the SDK's streaming input mode).
- `thread/inject_items` (write a synthetic message into the log + SDK input stream).
- Tests: concurrent threads, an approval flow that goes accept / decline / cancel /
  acceptForSession, a steer call.

### M3 — Skills, MCP, config, account (1 week)
- `skills/list`: read Claude Code's skill directories (`~/.claude/skills/`, `.claude/skills/`)
  and surface frontmatter.
- `skills/config/write`: toggle enablement by editing/persisting per-skill state.
- `mcpServerStatus/list`: introspect SDK-managed MCP servers + read `.mcp.json`.
- `mcpServer/tool/call`: direct invocation outside a turn.
- `mcpServer/resource/read`.
- `config/read`, `config/value/write`, `config/batchWrite` over the server's own config
  file (`~/.config/claude-app-server/config.json`). NOT Claude Code's settings.json — keep
  the two distinct to avoid stepping on user config.
- `account/read`, `account/login/start` (apiKey only), `account/logout`,
  `account/rateLimits/read`, `account/rateLimits/updated` notification.
- `model/list` returns the static list of currently supported Anthropic models. Update by
  hand at release time (cheap, low churn).
- Tests: skill listing against a fixture skills dir; MCP tool call against a fake MCP server;
  config round-trip.

### M4 — Filesystem + exec convenience plane (optional, 3-5 days)
- `fs/readFile`, `fs/writeFile`, `fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`,
  `fs/remove`, `fs/copy`, `fs/watch`/`fs/unwatch`.
  - These are pure Node `fs` wrappers, scoped to a configurable allowlist. **No** Claude in
    the loop.
  - Honor `permissionMode` for writes when called from a turn context; outside a turn, gated
    by an `allowedFilesystemRoots` config field.
- `command/exec` (sandbox-light): spawns under the server process, streams output. No
  bubblewrap/firejail wrapper in M4 — that's a host concern documented in the README.
- `command/exec/write`, `/resize`, `/terminate`.
- WebSocket transport with `--listen ws://...` (one flag, no auth in M4; auth in M5).

### M5+ — Stretch
- Unix-socket transport.
- WebSocket auth (capability-token / signed-bearer-token, matching Codex's flags).
- OAuth login flow (`account/login/start type=oauth`).
- Plugins (`plugin/*`) once Claude Code's plugin marketplace stabilizes.
- `externalAgentConfig/detect` over `AGENTS.md`/`CLAUDE.md`/skills/MCP/hook configs.

## 7. Repository Layout

```
claude-app-server/
├── package.json
├── tsconfig.json
├── README.md
├── bin/
│   └── claude-app-server.js          # entry point: requires dist/cli.js
├── src/
│   ├── cli.ts                        # argv parsing, transport selection, lifecycle
│   ├── server/
│   │   ├── jsonrpc.ts                # JSON-RPC 2.0 framing + pending-request table
│   │   ├── transport-stdio.ts
│   │   ├── transport-ws.ts           # M4
│   │   ├── router.ts                 # method dispatch
│   │   └── notifications.ts          # typed emitters
│   ├── threads/
│   │   ├── registry.ts               # active threads map
│   │   ├── thread.ts                 # one thread = one Claude session
│   │   ├── log.ts                    # JSONL persistence
│   │   └── status.ts                 # status state machine + change notifications
│   ├── sdk/
│   │   ├── driver.ts                 # wraps query() AsyncGenerator
│   │   ├── translate.ts              # SDK message → JSON-RPC items (the heart of M1)
│   │   ├── permission.ts             # canUseTool → approval request bridge
│   │   └── hooks.ts                  # hook event bridge (M2)
│   ├── methods/
│   │   ├── initialize.ts
│   │   ├── thread.ts                 # thread/start, thread/resume, thread/read, ...
│   │   ├── turn.ts                   # turn/start, turn/steer, turn/interrupt
│   │   ├── skills.ts
│   │   ├── mcp.ts
│   │   ├── config.ts
│   │   ├── account.ts
│   │   ├── hooks.ts
│   │   ├── fs.ts                     # M4
│   │   └── command.ts                # M4
│   ├── types/
│   │   ├── protocol.ts               # full JSON-RPC method/param/result types
│   │   ├── items.ts                  # item type discriminated union
│   │   └── sandbox.ts                # permission-mode / allowed-tools types
│   └── util/
│       ├── ids.ts                    # uuid + monotonic counters
│       ├── time.ts
│       └── errors.ts                 # typed error helpers
└── test/
    ├── unit/                         # vitest unit tests next to modules above
    ├── golden/                       # recorded SDK streams + expected JSON-RPC output
    └── e2e/
        ├── handshake.test.ts
        ├── single-turn.test.ts
        ├── approval-flow.test.ts
        └── concurrent-threads.test.ts
```

## 8. CLI Surface

```
claude-app-server [options]

Options:
  --listen <transport>     stdio (default) | ws://host:port | unix:///path
  --log-level <level>      error|warn|info|debug (default: info)
  --log-file <path>        write logs to file instead of stderr
  --data-dir <path>        override thread log dir (default: $XDG_DATA_HOME/claude-app-server)
  --config <path>          override config file path
  generate-json-schema --out <dir>    emit JSON Schema for all methods/params/results
  --help, -h
  --version, -V
```

`generate-json-schema` mirrors Codex's subcommand. Same output shape so client generators can
be re-used.

## 9. Configuration File

`~/.config/claude-app-server/config.json`:

```json
{
  "anthropic": {
    "apiKey": null,
    "baseUrl": null,
    "provider": "anthropic"
  },
  "defaults": {
    "model": "claude-sonnet-4-6",
    "permissionMode": "default",
    "addDir": [],
    "allowedTools": null,
    "disallowedTools": null,
    "thinking": null
  },
  "filesystem": {
    "allowedRoots": ["~"],
    "deniedPaths": []
  },
  "mcp": {
    "configPath": null
  },
  "skills": {
    "userRoots": ["~/.claude/skills"]
  }
}
```

`config/read`, `config/value/write`, `config/batchWrite` operate on this file with the same
shape Codex documents (`keyPath`, `value`, `mergeStrategy: replace|upsert`).

## 10. Open Decisions (resolve before M2)

1. **Default permission mode**: ship as `default` (every tool requires approval) or `acceptEdits`
   (file edits auto-approved, Bash still gated)? Lean: `default` — safer for an unattended
   service, and orchestrators that want bypass already pass it explicitly.

2. **Thread persistence format**: one JSONL per thread is simple but won't handle very long
   sessions efficiently. Decision: ship JSONL in M1. Add a sqlite-backed index in M3 only if
   `thread/list` performance becomes an issue.

3. **Token-budget mapping for `effort`**: confirm against the SDK's `maxThinkingTokens`. Best
   guess today: `low=4096`, `medium=16384`, `high=40960`. Adjust once we see real usage.

4. **`canUseTool` granularity**: the SDK calls `canUseTool` once per tool invocation. For
   `acceptForSession`, decide whether the cache key is `(threadId, toolName)` or
   `(threadId, toolName, normalized(args))`. Lean: `(threadId, toolName)` for symmetry with
   Codex's session-level approvals.

5. **Hook bridging shape**: hooks live in `~/.claude/settings.json` and matter to the user's
   normal Claude Code experience. The app-server SHOULD NOT silently overwrite that file.
   Decision: hooks managed via `hooks/config/write` go into a server-owned settings layer
   that's merged at SDK invocation time; user's `~/.claude/settings.json` is read-only from
   the server's perspective.

6. **Cancellation semantics**: `turn/interrupt` should call `AbortController.abort()` on the
   query iterator. Verify the SDK actually propagates this to the underlying HTTP call. Add
   an integration test that asserts the API request is canceled mid-stream.

## 11. Definition of Done (per phase)

For each phase, ship is gated on:

- All unit tests pass (`vitest run`).
- All e2e tests pass (`vitest run --config vitest.e2e.config.ts`).
- `npm run typecheck` clean (no `any` outside `src/types/sdk-bridge.ts`).
- `npm run lint` clean.
- README documents the methods that work in that phase and points to the section above.
- A demo script (`scripts/demo-<phase>.ts`) exercises the new surface so a human can `node
  scripts/demo-m1.ts` and watch output.

## 12. Symphony Integration (the original motivation)

Once M2 ships, update Symphony's Claude+GitHub profile (`SPEC-CLAUDE-GITHUB.md`) Section 10
to add an OPTIONAL agent runner mode: instead of `claude -p ... --resume <id>` per turn,
spawn `claude-app-server` once per worker and speak JSON-RPC over its stdio. The Symphony spec
already names this protocol pluggable; this just gives it a concrete second backend with the
same shape as the Codex one Symphony was originally written against.

Symphony changes required:
- Add `claude.runner: cli|app-server` config field (default `cli` for back-compat).
- When `app-server`, the worker spawns `claude-app-server`, sends `initialize` + `initialized`,
  `thread/start`, then `turn/start` per orchestrator turn, listening for `turn/completed` and
  approval requests.
- Session reuse becomes free (no `--resume`); turn boundaries are explicit JSON-RPC events.

## 13. References

- Codex app-server: https://developers.openai.com/codex/app-server
- Claude Agent SDK (TS): https://docs.anthropic.com/en/api/agent-sdk
- Symphony spec (canonical): `SPEC.md`
- Symphony spec (Claude+GitHub profile): `SPEC-CLAUDE-GITHUB.md`
- JSON-RPC 2.0: https://www.jsonrpc.org/specification

## 14. Suggested First Commit

After reading this plan, the implementing agent should:

1. `mkdir claude-app-server && cd claude-app-server`
2. `npm init -y` and set `"type": "module"`, `"bin": { "claude-app-server": "bin/claude-app-server.js" }`
3. Install: `@anthropic-ai/claude-agent-sdk`, `vitest`, `typescript`, `@types/node`, `tsx`
4. Land M0 in a single PR: framer + handshake + one test.
5. Open a tracking issue (or `TODO.md`) with one checkbox per item in §6 M1.

Stop at the end of M0 and report back before continuing — the M1 translator is the most
non-trivial piece and benefits from a checkpoint review before it's built.
