# Symphony Service Specification — Claude Code + GitHub Profile

Status: Draft v1 (language-agnostic)

Purpose: Define a Symphony-conformant service that orchestrates **Claude Code** sessions to get
project work done, using **GitHub Issues** as the issue tracker.

This document is a self-contained re-targeting of the language-agnostic Symphony specification
(`SPEC.md`). Where this profile differs from the canonical Symphony spec, this profile controls for
implementations that target Claude Code + GitHub. Where this profile is silent, the canonical
Symphony spec applies.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Symphony (Claude+GitHub profile) is a long-running automation service that continuously reads work
from GitHub Issues, creates an isolated workspace for each issue, and runs a Claude Code session
inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so Claude Code commands run only inside
  per-issue workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent Claude Code runs.

Implementations are expected to document their trust and safety posture explicitly. This profile
does not require a single approval, permission-mode, or operator-confirmation policy; some
implementations target trusted environments with `bypassPermissions`, while others enforce stricter
allow-listing or operator-in-the-loop approvals.

Important boundary:

- Symphony is a scheduler/runner and tracker reader.
- Ticket writes (state transitions, comments, PR links, label changes) are typically performed by
  the Claude Code session using the `gh` CLI through the Bash tool, an MCP GitHub server, or the
  OPTIONAL `github_graphql` client-side tool extension.
- A successful run can end at a workflow-defined handoff state (for example a `Human Review` label
  or `awaiting-review` project column), not necessarily a closed/merged issue.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll GitHub on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible (issue closed, label removed,
  re-assigned out of scope, etc.).
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support tracker/filesystem-driven restart recovery without requiring a persistent database; exact
  in-memory scheduler state is not restored.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit issues, PRs, or comments. (That logic lives in the
  workflow prompt and the agent's tool access — typically `gh` CLI.)
- Mandating strong sandbox controls beyond what Claude Code's permission model and the host OS
  provide.
- Mandating a single default permission-mode, allowed-tool set, or operator-confirmation posture
  for all implementations.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Client` (GitHub adapter)
   - Fetches candidate issues in active states for the configured repository or Project.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes GitHub REST/GraphQL payloads into the stable issue model in Section 4.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

6. `Agent Runner` (Claude Code)
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Launches the `claude` CLI in headless streaming mode.
   - Streams Claude Code events back to the orchestrator.
   - Manages session resumption across continuation turns.

7. `Status Surface` (OPTIONAL)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for issue handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + Claude Code subprocess)
   - Filesystem lifecycle, workspace preparation, Claude Code streaming protocol.

5. `Integration Layer` (GitHub adapter)
   - REST/GraphQL calls and normalization for tracker data.

6. `Observability Layer` (logs + OPTIONAL status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- GitHub REST API and/or GraphQL API (`https://api.github.com` and
  `https://api.github.com/graphql`).
- Local filesystem for workspaces and logs.
- OPTIONAL workspace population tooling (typically Git CLI for clone/checkout).
- `claude` CLI executable (Claude Code), version compatible with `--output-format stream-json`.
- OPTIONAL `gh` CLI for tracker writes from inside Claude Code sessions.
- Host environment authentication for GitHub (`GITHUB_TOKEN` or GitHub App credentials) and Claude
  Code (`ANTHROPIC_API_KEY`, OAuth login, or Bedrock/Vertex provider credentials).

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable GitHub node ID (GraphQL global ID, e.g. `I_kwDOA...`).
- `identifier` (string)
  - Human-readable issue key.
  - Canonical form: `<owner>/<repo>#<number>` (example: `acme/api#142`).
  - Single-repo deployments MAY shorten to `#<number>` when only one repo is configured.
- `number` (integer)
  - The GitHub issue number within its repository.
- `repository` (string)
  - `<owner>/<repo>` slug that owns the issue.
- `title` (string)
- `description` (string or null)
  - The issue body (markdown).
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
  - GitHub has no native priority field; see Section 11.3 for derivation rules.
- `state` (string)
  - Effective workflow state (see Section 11.3 for derivation from labels/Project fields/`state`).
- `branch_name` (string or null)
  - GitHub's suggested development branch name when available, otherwise computed as
    `<number>-<slug(title)>`.
- `url` (string or null)
  - HTML URL of the issue.
- `labels` (list of strings)
  - Normalized to lowercase.
- `assignees` (list of strings)
  - GitHub login names, lowercased.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null) — GitHub node ID of the blocking issue if resolvable
    - `identifier` (string or null) — `<owner>/<repo>#<number>`
    - `state` (string or null) — effective workflow state of the blocker
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map) — YAML front matter root object.
- `prompt_template` (string) — Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- Claude Code executable/args/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one issue identifier.

Fields (logical):

- `path` (absolute workspace path)
- `workspace_key` (sanitized issue identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (OPTIONAL)

#### 4.1.6 Live Session (Claude Code Session Metadata)

State tracked while a Claude Code subprocess is running.

Fields:

- `session_id` (string, Claude Code's reported session UUID)
- `thread_id` (string) — alias for `session_id`; Claude Code does not distinguish thread from
  session in headless mode.
- `turn_id` (string) — synthesized as `<session_id>-<turn_number>` because Claude Code does not
  expose stable per-turn identifiers in stream-json.
- `claude_pid` (string or null)
- `last_event` (string/enum or null)
- `last_event_timestamp` (timestamp or null)
- `last_message` (summarized payload — text snippet, tool name, or event type)
- `input_tokens` (integer)
- `output_tokens` (integer)
- `cache_creation_input_tokens` (integer)
- `cache_read_input_tokens` (integer)
- `total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - Number of Claude Code turns started within the current worker lifetime.
- `total_cost_usd` (number) — accumulated reported cost across turns, when available.

#### 4.1.7 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.8 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved/running/retrying)
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `claude_totals` (aggregate tokens + runtime seconds + cumulative USD cost)
- `claude_rate_limits` (latest rate-limit snapshot from Claude Code events / response headers)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - GraphQL node ID. Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - `<owner>/<repo>#<number>`. Use for human-readable logs and workspace naming.
- `Workspace Key`
  - Derive from `issue.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - For example, `acme/api#142` becomes `acme_api_142`.
- `Normalized Issue State`
  - Compare states after `lowercase`.
- `Session ID`
  - Use Claude Code's session UUID directly. Compose `turn_id` and `session_id-turn_id` triples
    where the spec calls for `<thread_id>-<turn_id>` semantics.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with OPTIONAL YAML front matter.

Design note:

- `WORKFLOW.md` SHOULD be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and tracker selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter MUST decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `claude`

Unknown keys SHOULD be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Extensions MAY define additional top-level keys without
  changing the core schema above.
- Extensions SHOULD document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - REQUIRED for dispatch.
  - This profile defines value: `github`.

- `endpoint` (string)
  - Default for `tracker.kind == "github"`: `https://api.github.com`
  - For GitHub Enterprise Server, set to the enterprise API root (e.g.
    `https://ghe.example.com/api/v3`).
  - The GraphQL endpoint is derived as `<endpoint>/graphql` for `api.github.com`, or
    `<endpoint>/graphql` for GHES (which serves it at `/api/graphql` on the host root —
    implementations SHOULD handle both).

- `api_key` (string)
  - MAY be a literal token or `$VAR_NAME`.
  - Canonical environment variable: `GITHUB_TOKEN`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
  - The token MUST have at minimum: `issues:read`, `pull_requests:read`, and
    (if agent tools write) `issues:write`, `pull_requests:write`, `contents:write`.

- `app_credentials` (object, OPTIONAL)
  - Alternative to `api_key` for GitHub App-based auth.
  - Subfields:
    - `app_id` (integer or `$VAR`)
    - `installation_id` (integer or `$VAR`)
    - `private_key` (multiline PEM string or `$VAR` pointing at a file path)
  - When `app_credentials` is present, `api_key` is ignored.
  - Implementations MAY mint short-lived installation tokens on demand.

- `repository` (string)
  - `<owner>/<repo>` slug.
  - REQUIRED when `project_id` is not configured.
  - When both `repository` and `project_id` are configured, `project_id` defines the candidate
    surface and `repository` is used only as a default for branch-name suggestions and
    issue-creation contexts.

- `project_id` (string, OPTIONAL)
  - GitHub Projects (v2) global node ID, used for cross-repo or board-driven workflows.
  - When present, candidate issues come from the Project's items, and `state` is derived from the
    Project's `Status` single-select field unless overridden by `tracker.state_field`.

- `state_source` (string)
  - One of: `labels`, `project`, `closed_flag`.
  - Default: `labels` when `project_id` is unset; `project` when `project_id` is set.
  - `labels`: state derived from labels matching `tracker.state_label_prefix`.
  - `project`: state derived from the Project's `Status` field (or `tracker.state_field`).
  - `closed_flag`: only two states, `Open` and `Closed`; useful for simple repos.

- `state_label_prefix` (string)
  - Default: `status:`
  - When `state_source == "labels"`, the workflow state is the suffix of the first label that
    starts with this prefix (case-insensitive). The matched label is normalized: prefix stripped,
    trimmed, original casing preserved for display but lowercased for comparison.

- `state_field` (string)
  - Default: `Status`
  - When `state_source == "project"`, name of the Project v2 single-select field whose option
    represents the workflow state.

- `priority_source` (string)
  - One of: `labels`, `project`, `none`.
  - Default: `labels`.

- `priority_label_pattern` (string, regex)
  - Default: `^p(\d)$` (case-insensitive). Matches labels like `P0`, `P1`, `p2`.
  - The first capture group is parsed as an integer priority. Lower is higher priority.

- `priority_field` (string)
  - Default: `Priority`
  - When `priority_source == "project"`, name of the Project v2 single-select/number field. When
    single-select, options SHOULD be parsable to integers; otherwise priority is `null`.

- `assignee_filter` (list of strings, OPTIONAL)
  - When set, only issues assigned to at least one of the listed logins are candidate-eligible.
  - Comparison is case-insensitive.
  - A special value `@me` resolves to the GitHub login that owns `api_key` (or the App's bot
    account) at startup.

- `label_filters` (object, OPTIONAL)
  - `include` (list of strings) — issue MUST have at least one of these labels to be eligible.
  - `exclude` (list of strings) — issue MUST NOT have any of these labels.
  - Comparison is case-insensitive after normalization.

- `active_states` (list of strings)
  - Default when `state_source == "labels"`: `["Todo", "In Progress"]`
  - Default when `state_source == "project"`: `["Todo", "In Progress"]`
  - Default when `state_source == "closed_flag"`: `["Open"]`

- `terminal_states` (list of strings)
  - Default when `state_source == "labels"`:
    `["Done", "Closed", "Cancelled", "Canceled", "Duplicate", "Wont Fix", "Won't Fix"]`
  - Default when `state_source == "project"`:
    `["Done", "Closed", "Cancelled", "Canceled", "Duplicate", "Wont Fix"]`
  - Default when `state_source == "closed_flag"`: `["Closed"]`
  - In all modes, issues whose GitHub `state` is `closed` are treated as terminal regardless of
    label/Project values.

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer)
  - Default: `30000`
  - Changes SHOULD be re-applied at runtime and affect future tick scheduling without restart.

- `use_etag` (boolean, OPTIONAL)
  - Default: `true`
  - When `true`, the GitHub adapter SHOULD use conditional requests (`If-None-Match` headers) for
    REST polling to reduce rate-limit consumption.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` is expanded.
  - Relative paths are resolved relative to the directory containing `WORKFLOW.md`.
  - The effective workspace root is normalized to an absolute path before use.

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, OPTIONAL)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
  - Typical use: clone the repository, install dependencies, copy `.claude/` settings.

- `before_run` (multiline shell script string, OPTIONAL)
  - Runs before each Claude Code attempt after workspace preparation and before launching the
    agent.
  - Failure aborts the current attempt.
  - Typical use: `git fetch && git checkout main && git pull`.

- `after_run` (multiline shell script string, OPTIONAL)
  - Runs after each Claude Code attempt (success, failure, timeout, or cancellation) once the
    workspace exists.
  - Failure is logged but ignored.

- `before_remove` (multiline shell script string, OPTIONAL)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.

- `timeout_ms` (integer, OPTIONAL)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Invalid values fail configuration validation.
  - Changes SHOULD be re-applied at runtime for future hook executions.

Hook environment variables provided by the runtime (in addition to inherited env):

- `SYMPHONY_ISSUE_ID`
- `SYMPHONY_ISSUE_IDENTIFIER`
- `SYMPHONY_ISSUE_NUMBER`
- `SYMPHONY_ISSUE_REPOSITORY`
- `SYMPHONY_ISSUE_TITLE`
- `SYMPHONY_ISSUE_BRANCH_NAME`
- `SYMPHONY_ISSUE_STATE`
- `SYMPHONY_ATTEMPT` (string, empty for first attempt)
- `SYMPHONY_WORKSPACE_PATH`

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer)
  - Default: `10`
  - Changes SHOULD be re-applied at runtime and affect subsequent dispatch decisions.

- `max_turns` (positive integer)
  - Default: `20`
  - Limits the number of Claude Code turns within one worker session. This is the orchestrator's
    outer turn loop and is separate from any per-invocation `--max-turns` Claude Code may apply
    internally; see Section 10.

- `max_retry_backoff_ms` (integer)
  - Default: `300000` (5 minutes)
  - Changes SHOULD be re-applied at runtime and affect future retry scheduling.

- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.3.6 `claude` (object)

Configuration for the Claude Code subprocess. For Claude-owned config such as `permission_mode`,
`model`, and `allowed_tools`, supported values are defined by the installed Claude Code CLI version.
To inspect the installed CLI's capabilities, run `claude --help` and consult the Claude Code
documentation. Implementations MAY validate these fields locally for stricter startup checks.

- `command` (string shell command)
  - Default: `claude`
  - The runtime launches this command via `bash -lc` in the workspace directory.
  - The launched process MUST accept `-p <prompt>`, `--output-format stream-json`, and
    `--verbose`. Implementations targeting newer Claude Code versions MAY override `command` to
    pass additional flags (for example to pin a Claude Code version path).

- `model` (string)
  - Default: implementation-defined (typically the latest Sonnet model — `claude-sonnet-4-6` or
    newer at the time of implementation).
  - Passed as `--model <value>` to the CLI.

- `permission_mode` (string)
  - One of: `default`, `acceptEdits`, `plan`, `bypassPermissions`.
  - Default: implementation-defined. Trusted-environment implementations typically choose
    `bypassPermissions`; restricted environments typically choose `default` with a curated
    `allowed_tools` set.
  - Passed as `--permission-mode <value>` to the CLI.
  - When the implementation chooses `bypassPermissions`, it MAY equivalently pass
    `--dangerously-skip-permissions` depending on installed CLI flag naming; behavior is
    equivalent.

- `allowed_tools` (list of strings, OPTIONAL)
  - When set, passed as `--allowedTools <tool1>,<tool2>,...`.
  - Tool names follow Claude Code's syntax, for example `Bash(git:*)`, `Read`, `Edit`,
    `mcp__github__create_pull_request`.

- `disallowed_tools` (list of strings, OPTIONAL)
  - When set, passed as `--disallowedTools <tool1>,<tool2>,...`.

- `mcp_config` (path string, OPTIONAL)
  - Path (relative to `WORKFLOW.md` or absolute) to an `.mcp.json` file describing additional MCP
    servers to load into each Claude Code session.
  - When set, passed as `--mcp-config <path>`.

- `add_dir` (list of path strings, OPTIONAL)
  - Additional directories Claude Code MAY read outside the workspace path. Each entry is passed
    as `--add-dir <path>`.
  - RECOMMENDED to leave empty for the default safety posture.

- `claude_settings` (path string, OPTIONAL)
  - Path to a `.claude/settings.json` file copied or referenced into the workspace. When set,
    `after_create` SHOULD ensure the file is present inside the workspace before the first
    Claude Code launch.

- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
  - Wall-clock timeout for a single Claude Code subprocess invocation (one turn).

- `read_timeout_ms` (integer)
  - Default: `5000`
  - Timeout for receiving the first stream-json `system`/`init` event after launch.

- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.

- `extra_args` (list of strings, OPTIONAL)
  - Additional CLI flags appended verbatim to the `claude` invocation, after the spec-mandated
    flags. Useful for `--include-partial-messages`, `--input-format`, custom flags, etc.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels, assignees, and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime MAY use a minimal default prompt
  (`You are working on a GitHub issue.`).
- Workflow file read/parse failures are configuration/validation errors and SHOULD NOT silently
  fall back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Configuration Resolution Pipeline

Configuration is resolved in this order:

1. Select the workflow file path (explicit runtime setting, otherwise cwd default).
2. Parse YAML front matter into a raw config map.
3. Apply built-in defaults for missing OPTIONAL fields.
4. Resolve `$VAR_NAME` indirection only for config values that explicitly contain `$VAR_NAME`.
5. Coerce and validate typed values.

Environment variables do not globally override YAML values. They are used only when a config value
explicitly references them.

Value coercion semantics:

- Path/command fields support `~` home expansion and `$VAR` expansion as in the canonical spec.
- Relative `workspace.root` values resolve relative to the directory containing the selected
  `WORKFLOW.md`.

### 6.2 Dynamic Reload Semantics

Dynamic reload is REQUIRED. Semantics match the canonical Symphony spec:

- The software MUST detect `WORKFLOW.md` changes.
- On change, it MUST re-read and re-apply workflow config and prompt template without restart.
- The software MUST attempt to adjust live behavior to the new config (polling cadence, concurrency
  limits, active/terminal states, claude settings, workspace paths/hooks, prompt content for future
  runs).
- Implementations are not REQUIRED to restart in-flight Claude Code sessions on config change.
- Extensions managing their own listeners/resources MAY require restart.
- Invalid reloads MUST NOT crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

Validation checks before each dispatch tick:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and equal to `github`.
- Either `tracker.api_key` (after `$` resolution) or `tracker.app_credentials` is fully resolved.
- Either `tracker.repository` or `tracker.project_id` is present.
- `claude.command` is present and non-empty.
- `claude` executable resolves on `PATH` (RECOMMENDED preflight; failure is a soft warning, not a
  hard preflight error, because the workspace's `PATH` may differ — but persistent failure at
  launch time MUST surface as `claude_not_found`).

### 6.4 Core Config Fields Summary (Cheat Sheet)

- `tracker.kind`: string, REQUIRED, value `github`
- `tracker.endpoint`: string, default `https://api.github.com`
- `tracker.api_key`: string or `$VAR`, canonical env `GITHUB_TOKEN`
- `tracker.app_credentials`: object, alternative to `api_key`
- `tracker.repository`: string `<owner>/<repo>`, REQUIRED unless `project_id` is set
- `tracker.project_id`: string, Projects v2 node ID, OPTIONAL
- `tracker.state_source`: enum, default `labels` (or `project` when `project_id` is set)
- `tracker.state_label_prefix`: string, default `status:`
- `tracker.state_field`: string, default `Status`
- `tracker.priority_source`: enum, default `labels`
- `tracker.priority_label_pattern`: regex, default `^p(\d)$`
- `tracker.priority_field`: string, default `Priority`
- `tracker.assignee_filter`: list of strings, OPTIONAL
- `tracker.label_filters.include`: list of strings, OPTIONAL
- `tracker.label_filters.exclude`: list of strings, OPTIONAL
- `tracker.active_states`: list of strings, default `["Todo", "In Progress"]`
- `tracker.terminal_states`: list of strings, default per `state_source`
- `polling.interval_ms`: integer, default `30000`
- `polling.use_etag`: boolean, default `true`
- `workspace.root`: path resolved to absolute, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `claude.command`: shell command string, default `claude`
- `claude.model`: string, default implementation-defined
- `claude.permission_mode`: enum, default implementation-defined
- `claude.allowed_tools`: list, OPTIONAL
- `claude.disallowed_tools`: list, OPTIONAL
- `claude.mcp_config`: path, OPTIONAL
- `claude.add_dir`: list of paths, OPTIONAL
- `claude.claude_settings`: path, OPTIONAL
- `claude.turn_timeout_ms`: integer, default `3600000`
- `claude.read_timeout_ms`: integer, default `5000`
- `claude.stall_timeout_ms`: integer, default `300000`
- `claude.extra_args`: list, OPTIONAL

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

1. `Unclaimed`
2. `Claimed`
3. `Running`
4. `RetryQueued`
5. `Released`

Semantics match the canonical Symphony spec.

Important nuance:

- The worker MAY continue through multiple back-to-back Claude Code turns before it exits.
- The first turn SHOULD use the full rendered task prompt.
- Continuation turns SHOULD resume the same Claude Code session via `--resume <session_id>` and
  send only continuation guidance, not resend the original task prompt.
- After each normal turn, the worker re-checks the issue's tracker state. If still active and
  `agent.max_turns` not exhausted, it starts another turn on the same session.
- Once the worker exits normally, the orchestrator schedules a short continuation retry (about 1
  second) so it can re-check whether the issue remains active and needs another worker session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingClaude`
4. `InitializingSession` (awaiting `system` init event)
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

### 7.3 Transition Triggers

- `Poll Tick`
- `Worker Exit (normal)` — schedule continuation retry with attempt 1 after a `~1000 ms` delay.
- `Worker Exit (abnormal)` — schedule exponential-backoff retry.
- `Claude Event` — update live session fields, token counters, rate limits.
- `Retry Timer Fired` — re-fetch active candidates and attempt re-dispatch, or release.
- `Reconciliation State Refresh` — stop runs whose issue states are terminal or no longer active.
- `Stall Timeout` — kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority.
- `claimed` and `running` checks are REQUIRED before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven.
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from GitHub (active states, respecting `assignee_filter` and
   `label_filters`).
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `number`, `repository`, `title`, and `state`.
- Its GitHub `state` is `open`.
- Its effective workflow state is in `active_states` and not in `terminal_states`.
- It passes `tracker.assignee_filter` (when configured).
- It passes `tracker.label_filters.include` / `.exclude` (when configured).
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo`-equivalent state passes:
  - If the issue's normalized state is the first entry of `active_states` (typically `Todo`), do
    not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (lower number is higher priority; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Same semantics as canonical spec:

- `available_slots = max(max_concurrent_agents - running_count, 0)`
- Per-state limit from `max_concurrent_agents_by_state[state]` (normalized state key), otherwise
  global.

### 8.4 Retry and Backoff

- Continuation retries after a clean worker exit use a fixed delay of `1000 ms`.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Retry handling re-fetches active candidates, releases claim if missing/non-active, dispatches if
  slot available, otherwise requeues with `no available orchestrator slots`.

### 8.5 Active Run Reconciliation

Part A: Stall detection (using `claude.stall_timeout_ms`).

Part B: Tracker state refresh — issue current states for running issue IDs.

- Terminal: terminate worker + clean workspace.
- Active: update in-memory issue snapshot.
- Neither: terminate worker, no workspace cleanup.
- Fetch failure: keep workers running; retry next tick.

### 8.6 Startup Terminal Workspace Cleanup

On startup:

1. Query GitHub for issues in the configured terminal states (closed issues, plus label/Project
   matches for the configured terminal state names).
2. For each returned issue identifier, remove the corresponding workspace directory.
3. If the terminal-issues fetch fails, log a warning and continue startup.

Note on scoping: this query MUST be bounded (for example by the configured `repository` /
`project_id` and a reasonable lookback such as 30 days `updated:>=`) to avoid paging through
years of closed issues.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

- `workspace.root` (normalized absolute path)
- Per-issue workspace path: `<workspace.root>/<sanitized_issue_identifier>`
- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

1. Sanitize identifier to `workspace_key` (replacing characters outside `[A-Za-z0-9._-]` with `_`).
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this call.
5. If `created_now=true`, run `after_create` hook if configured.

A common `after_create` pattern for this profile:

```bash
git clone --depth=1 https://x-access-token:${GITHUB_TOKEN}@github.com/${SYMPHONY_ISSUE_REPOSITORY}.git .
git config user.email "symphony-bot@example.com"
git config user.name  "Symphony Bot"
git checkout -b "symphony/${SYMPHONY_ISSUE_BRANCH_NAME}"
```

### 9.3 OPTIONAL Workspace Population (Implementation-Defined)

Same as canonical spec. Implementations MAY populate via Git clone in `after_create` and update via
`before_run`.

### 9.4 Workspace Hooks

Supported hooks: `after_create`, `before_run`, `after_run`, `before_remove`. Execute via `bash -lc`
with workspace as `cwd`. Failure semantics match the canonical spec.

The runtime MUST inject the `SYMPHONY_ISSUE_*` env vars listed in Section 5.3.4.

### 9.5 Safety Invariants

Invariant 1: Claude Code is launched only inside the per-issue workspace.

- Validate `cwd == workspace_path` immediately before subprocess launch.

Invariant 2: Workspace path MUST stay inside workspace root.

- Normalize both paths to absolute.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.

Additional invariant for this profile:

Invariant 4: `claude.add_dir` paths SHOULD NOT include the workspace root, repository checkout
parent directories, or paths containing other issues' workspaces. Implementations SHOULD validate
that each `add_dir` entry is either absent or absolute and outside `workspace.root`.

## 10. Agent Runner Protocol (Claude Code Integration)

This section defines Symphony's responsibilities when integrating the Claude Code CLI. The
installed Claude Code version is the source of truth for the stream-json schema, flag names, and
session-resume semantics.

Protocol source of truth:

- Implementations MUST emit invocations valid for the installed Claude Code version.
- Implementations MUST consult `claude --help` / the Claude Code docs for the authoritative flag
  and event-shape contracts.
- If this specification appears to conflict with the installed Claude Code behavior, the CLI
  controls protocol shape and transport behavior.

### 10.1 Launch Contract

Each Claude Code turn is launched as a separate subprocess invocation:

- Command: `claude.command` (default: `claude`)
- Invocation: `bash -lc "<claude.command> <args>"`
- Working directory: workspace path
- Required base args:
  - `--output-format stream-json`
  - `--verbose`
  - `-p <prompt>`
- Recommended/conditional args:
  - `--model <claude.model>` when set
  - `--permission-mode <claude.permission_mode>` when set
  - `--allowedTools <csv>` when `claude.allowed_tools` is non-empty
  - `--disallowedTools <csv>` when `claude.disallowed_tools` is non-empty
  - `--mcp-config <path>` when `claude.mcp_config` is set
  - `--add-dir <path>` once per entry in `claude.add_dir`
  - `--resume <session_id>` on continuation turns within the same worker run
  - Items from `claude.extra_args` appended verbatim
- Transport: line-delimited JSON over stdout (`--output-format stream-json`)
- Stderr is captured separately for diagnostics and SHOULD NOT be parsed as protocol events.

RECOMMENDED additional process settings:

- Max line size: 10 MB (for safe buffering of large tool results)
- The runtime SHOULD set `CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC=1` (or equivalent) in trusted
  environments to suppress optional telemetry.

### 10.2 Session Startup Responsibilities

Reference: Claude Code CLI documentation for the installed version.

Startup MUST follow the installed CLI's contract. Symphony additionally requires the runner to:

- Start the subprocess in the per-issue workspace directory.
- Capture the first `system` event with `subtype: "init"` to record `session_id`, the resolved
  model, the resolved permission mode, and the available tool list.
- For the first turn, send the rendered task prompt via `-p`.
- For continuation turns within the same worker run, use `--resume <session_id>` and pass
  continuation guidance via `-p`, not the original task prompt.
- Apply the documented approval and permission mode using `--permission-mode`.
- When the installed CLI supports it, include an issue-identifying header in the prompt body (for
  example `# Issue {{issue.identifier}}: {{issue.title}}`) — Claude Code does not have a separate
  thread title field in headless mode.
- When `claude.mcp_config` is set, ensure the referenced file is readable before launch and abort
  the turn with `mcp_config_missing` otherwise.

Session identifiers:

- Extract `session_id` from the `system` init event.
- Synthesize `turn_id` as `<session_id>-<turn_number>` where `turn_number` is the orchestrator's
  1-based counter for this worker run.
- Emit `session_id` field as the Claude Code session UUID directly; emit `thread_id` equal to
  `session_id`.
- Reuse the same Claude Code `session_id` for all continuation turns inside one worker run.

### 10.3 Streaming Turn Processing

The runner reads stream-json lines until the turn terminates.

Stream-json message types (per current Claude Code CLI):

- `system` with `subtype: "init"` — emitted once at session start
- `assistant` — assistant turn content (text blocks, tool_use blocks)
- `user` — tool_result echo and orchestrator inputs
- `result` — terminal message for the invocation, with `subtype` indicating outcome:
  - `success`
  - `error_max_turns`
  - `error_during_execution`
  - implementations MUST treat any subtype starting with `error_` as a failure

Per-turn completion conditions:

- `result` with `subtype: "success"` -> turn success
- `result` with any `error_*` subtype -> turn failure
- subprocess exit before a `result` line -> turn failure (`subprocess_exit`)
- turn timeout (`turn_timeout_ms`) -> turn failure (`turn_timeout`)
- no event seen within `read_timeout_ms` after launch -> startup failure (`startup_timeout`)

Continuation processing:

- After a successful `result`, the runner re-fetches issue state. If still active and
  `max_turns` not exhausted, the runner launches a new Claude Code subprocess with
  `--resume <session_id>` for the next turn.
- Unlike a long-running app-server, Claude Code is invoked once per turn; there is no persistent
  child process held across turns. Session continuity comes from `--resume`, not from process
  persistence.

Transport handling requirements:

- Parse stdout line-by-line; each line is a complete JSON object.
- Tolerate non-JSON lines defensively (log as `malformed`, do not crash).
- Keep stdout (protocol stream) separate from stderr (diagnostics).

### 10.4 Emitted Runtime Events (Upstream to Orchestrator)

The Claude Code runner emits structured events to the orchestrator callback. Each event SHOULD
include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `claude_pid` (if available)
- OPTIONAL `usage` map (token counts and cost)
- payload fields as needed

Important emitted events include, for example:

- `session_started` — emitted on first `system`/`init` event with `session_id`, `model`, `tools`.
- `startup_failed` — subprocess exited before init, or init timed out.
- `assistant_text` — assistant emitted a text block (truncated payload for observability).
- `tool_use` — assistant invoked a tool (record tool name; redact full args by default).
- `tool_result` — tool finished (record success/error and short payload).
- `turn_completed` — `result` with `subtype: "success"`.
- `turn_failed` — `result` with any `error_*` subtype.
- `turn_ended_with_error` — subprocess exited without a `result`.
- `usage_updated` — token counters/cost updated from a `result` or `assistant` event.
- `permission_request` — only meaningful when `permission_mode` is `default` or `acceptEdits` and
  the runner has implemented an interactive permission channel; otherwise SHOULD NOT appear.
- `unsupported_tool_call` — the model requested a tool the runner has not implemented (rare in
  Claude Code because tools are negotiated by `--allowedTools`).
- `notification` — informational events from MCP servers or Claude Code itself.
- `malformed` — non-JSON or schema-violating stdout line.

### 10.5 Approval, Tool Calls, and User Input Policy

Approval, permission-mode, and user-input behavior is implementation-defined.

Policy requirements:

- Each implementation MUST document its chosen `permission_mode` and `allowed_tools` posture.
- Permission requests and "ask user" tool calls MUST NOT leave a run stalled indefinitely. An
  implementation MAY satisfy them, surface them to an operator, auto-resolve them, or fail the
  turn according to its documented policy.

Example high-trust behavior:

- `permission_mode: bypassPermissions`
- No `allowed_tools` filter (Claude Code defaults apply)
- Treat any `permission_request` event as a hard failure (should not occur under
  `bypassPermissions`).
- Allow tool calls to the Bash tool for `gh`, `git`, and project-specific commands.

Example restricted behavior:

- `permission_mode: default`
- `allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git:*)", "Bash(gh:*)", "Bash(npm:test*)"]`
- Implementations MAY auto-approve permission requests for the listed tool patterns and fail
  others.

Unsupported dynamic tool calls:

- Tools advertised via `--allowedTools` or MCP `--mcp-config` are handled by Claude Code itself; no
  runner action is needed except event observation.
- Implementations of client-side tool extensions (see below) MUST return a structured failure
  result when the agent invokes an unsupported tool, preventing session stalls.

OPTIONAL client-side tool extension: `github_graphql`

- Purpose: execute a raw GraphQL query or mutation against GitHub using Symphony's configured
  tracker auth for the current session.
- Implementation typically delivered through an MCP server registered via `claude.mcp_config`,
  exposing a tool such as `mcp__symphony_github__graphql`.
- Availability: only meaningful when `tracker.kind == "github"` and valid GitHub auth is
  configured.
- Preferred input shape:

  ```json
  {
    "query": "single GraphQL query or mutation document",
    "variables": { "optional": "graphql variables object" }
  }
  ```

- `query` MUST be a non-empty string containing exactly one GraphQL operation.
- `variables` is OPTIONAL and, when present, MUST be a JSON object.
- Reuse the configured GitHub endpoint and auth from the active Symphony runtime config; do not
  require the agent to read raw tokens from disk.
- Tool result semantics:
  - transport success + no top-level `errors` -> `success=true`
  - top-level `errors` present -> `success=false`, but preserve the response body for debugging
  - invalid input, missing auth, or transport failure -> `success=false` with an error payload
- Return the GraphQL response or error payload as structured tool output the model can inspect
  in-session.

`gh` CLI delegation (RECOMMENDED default)

- For most workflows, the simplest and most maintainable path is to expose the `gh` CLI to Claude
  Code via `Bash(gh:*)` in `allowed_tools` (or under `bypassPermissions`).
- The runner SHOULD ensure that the `gh` CLI in each workspace is authenticated:
  - Either by inheriting `GITHUB_TOKEN` from the runtime environment,
  - Or by running `gh auth status` / `gh auth setup-token` in `after_create`/`before_run`.
- Issue mutations (close, reopen, comment, label, assign), PR creation, and CI inspection are then
  performed by the agent using natural `gh` commands.

User-input-required policy:

- Implementations MUST document handling of in-prompt "ask user" requests.
- A run MUST NOT stall indefinitely.
- The example high-trust behavior above fails such requests by treating any non-tool-use prompt
  for user input as a hard turn failure.

### 10.6 Timeouts and Error Mapping

Timeouts:

- `claude.read_timeout_ms`: startup-event read timeout (first `system`/`init` line)
- `claude.turn_timeout_ms`: total per-turn subprocess wall-clock timeout
- `claude.stall_timeout_ms`: orchestrator-enforced inactivity timeout based on event freshness

Error mapping (RECOMMENDED normalized categories):

- `claude_not_found` — `claude` executable missing on `PATH`
- `claude_auth_missing` — Claude Code reports unauthenticated/unauthorized
- `invalid_workspace_cwd` — pre-launch cwd validation failed
- `mcp_config_missing` — `claude.mcp_config` path could not be read
- `startup_timeout` — no init event within `read_timeout_ms`
- `turn_timeout` — wall-clock turn timeout
- `subprocess_exit` — subprocess exited without a `result` line
- `turn_failed` — `result` with `error_*` subtype
- `turn_cancelled` — orchestrator terminated the subprocess due to reconciliation
- `permission_blocked` — `permission_mode` denied a tool the model required and the runner did
  not auto-approve
- `stalled` — orchestrator stall timeout fired

### 10.7 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + Claude Code session.

Behavior:

1. Create/reuse workspace for issue.
2. Build prompt from workflow template.
3. Launch the first Claude Code turn (no `--resume`).
4. Forward events to orchestrator.
5. After successful `result`, evaluate continuation:
   - Refresh issue state.
   - If still active and `turn_count < agent.max_turns`, launch next turn with `--resume`.
   - Otherwise exit normally.
6. On any non-recoverable error, fail the worker attempt (the orchestrator will retry).

Note:

- Workspaces are intentionally preserved after successful runs (the next worker session can resume
  the same Git branch).

## 11. Issue Tracker Integration Contract (GitHub)

### 11.1 REQUIRED Operations

An implementation MUST support these tracker adapter operations:

1. `fetch_candidate_issues()`
   - Return issues whose effective workflow state is in `active_states`, scoped to the configured
     repository or Project.

2. `fetch_issues_by_states(state_names)`
   - Used for startup terminal cleanup. SHOULD include a bounded `updated:>=` filter (default 30
     days back) to avoid unbounded paging.

3. `fetch_issue_states_by_ids(issue_ids)`
   - Used for active-run reconciliation.

### 11.2 Query Semantics (GitHub)

GitHub-specific requirements:

- Transport: GraphQL is REQUIRED for candidate fetching to allow rich field selection (labels,
  Project fields, blockers via `timelineItems`).
- REST MAY be used for ETag-conditional polling when `polling.use_etag` is true and when querying
  a single repository's `issues` endpoint.
- Auth header:
  - For PAT/fine-grained tokens: `Authorization: bearer <token>` (PAT) or `Authorization: token
    <token>` (classic). Implementations SHOULD send `Authorization: Bearer <token>` for both,
    matching current GitHub guidance.
  - For GitHub Apps: mint an installation token and send it the same way.
- `User-Agent` header REQUIRED by GitHub: send a stable identifier such as `symphony/<version>`.
- `X-GitHub-Api-Version`: set to a known supported version (e.g. `2022-11-28`) for REST endpoints.

Candidate query strategies:

- **Repository mode** (`tracker.repository` set, `tracker.project_id` unset):
  - GraphQL: `repository(owner, name) { issues(states: OPEN, first: 100, after: $cursor,
    orderBy:{field: UPDATED_AT, direction: DESC}) { ... } }`
  - Filter client-side by labels/assignees/state derivation rules.
- **Project mode** (`tracker.project_id` set):
  - GraphQL: `node(id: $projectId) { ... on ProjectV2 { items(first: 100, after: $cursor) {
    nodes { content { ... on Issue { ... } } fieldValues { ... } } } } }`
  - Filter client-side by Project `Status` field, `repository` scope (if `tracker.repository` is
    also set), labels, assignees.

Issue-state refresh by ID:

- GraphQL: `nodes(ids: $ids) { ... on Issue { id, number, state, labels, projectItems, ... } }`
- Variable type: `[ID!]!`.

Pagination:

- Cursor-based via GraphQL `pageInfo { hasNextPage, endCursor }`.
- Page size default: `50`.
- Pagination is REQUIRED for candidate issues.
- Network timeout: `30000 ms`.

Rate limiting and ETags:

- GitHub returns `X-RateLimit-*` headers and a GraphQL rate-limit cost. Track and surface in
  `claude_rate_limits` / observability output (this profile names the field
  `tracker_rate_limits` for symmetry; see Section 13).
- For REST conditional polling, store and replay `ETag` per query; treat `304 Not Modified` as
  "no changes, reuse previous payload".

### 11.3 Normalization Rules

Candidate issue normalization SHOULD produce fields listed in Section 4.1.1.

State derivation:

- When `state_source == "closed_flag"`:
  - `state = "Open"` for `open` issues
  - `state = "Closed"` for `closed` issues (further refined to `"Done"` when `stateReason ==
    COMPLETED` and `"Cancelled"` when `stateReason == NOT_PLANNED`, if the implementation
    surfaces those distinctions)
- When `state_source == "labels"`:
  - Find the first label (case-insensitive) starting with `tracker.state_label_prefix`.
  - State is the substring after the prefix, trimmed, with internal underscores/dashes mapped to
    spaces for display (e.g. `status:in-progress` -> `In Progress`).
  - If no such label exists, `state = "Open"` for open issues, `"Closed"` for closed issues.
- When `state_source == "project"`:
  - Find the Project item linked to this issue inside `tracker.project_id`.
  - Read the single-select option name from the field named `tracker.state_field`.
  - If the issue is not on the configured Project, treat it as ineligible (skip in candidate
    selection, normalize state to `"Open"`/`"Closed"`).

Priority derivation:

- When `priority_source == "labels"`:
  - Test each label (case-insensitive) against `tracker.priority_label_pattern`. The first match's
    integer capture is the priority. No match -> `null`.
- When `priority_source == "project"`:
  - Read the Project field named `tracker.priority_field`.
  - For a number field, parse directly. For single-select, parse the option name as an integer.
    Otherwise `null`.
- When `priority_source == "none"`: priority is always `null`.

Labels:

- Lowercased.

Assignees:

- GitHub login names, lowercased.

Blockers:

- Implementations MUST attempt to derive `blocked_by` from at least one of these sources, in order
  of preference:
  1. GraphQL `trackedInIssues` / `trackedIssues` (when the repository uses sub-issue / task list
     features) where the relationship indicates a blocking dependency.
  2. `timelineItems` of type `CrossReferencedEvent` combined with body parsing for the literal
     phrases (case-insensitive) `blocked by #<n>`, `blocked by <owner>/<repo>#<n>`, or
     `depends on <owner>/<repo>#<n>` in the issue body.
  3. Body parsing only, as a fallback.
- Each derived blocker reference SHOULD be resolved to its node ID and effective state via a
  follow-up GraphQL lookup. Unresolved references contribute a blocker entry with `id=null,
  state=null` and SHOULD be treated as `non-terminal` (i.e. blocking) by default.

Branch name:

- Preferred: GitHub-suggested development branch name (where the API exposes it through the
  Project/Issue development panel).
- Fallback: `<number>-<slug(title)>`, where `slug` lowercases, replaces runs of non-alphanumerics
  with `-`, and trims leading/trailing `-` to a maximum length of 60 characters.

Timestamps:

- `created_at`, `updated_at`: parse ISO-8601 timestamps from GitHub.

### 11.4 Error Handling Contract

RECOMMENDED error categories:

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_repository_or_project`
- `github_api_request` (transport failures)
- `github_api_status` (non-200 HTTP)
- `github_graphql_errors`
- `github_rate_limited` (HTTP 403/429 with rate-limit headers; back off and retry next tick)
- `github_secondary_rate_limit` (HTTP 403 with `Retry-After`; respect the header)
- `github_unknown_payload`
- `github_missing_end_cursor` (pagination integrity error)

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.
- `github_rate_limited` / `github_secondary_rate_limit`: log, skip dispatch, and SHOULD increase
  the next tick's effective interval to respect the `Retry-After` header or the reset time
  reported by `X-RateLimit-Reset`.

### 11.5 Tracker Writes (Important Boundary)

Symphony does not require first-class tracker write APIs in the orchestrator. For this profile:

- Issue mutations (state transitions via labels, comments, assignee changes, PR creation, PR
  linking, closing on merge) are typically handled by Claude Code using the `gh` CLI through the
  Bash tool, an MCP GitHub server, or the OPTIONAL `github_graphql` tool extension.
- The orchestrator remains a scheduler/runner and tracker reader.
- Workflow-specific success often means "reached the next handoff state" (for example a
  `needs-review` label or a Project `In Review` column) rather than GitHub's `closed` state.
- Implementations MAY provide a built-in convenience for writing a Symphony bookkeeping comment
  on the issue at session start/end (for example "Symphony session started" with the
  `session_id`); this is OPTIONAL and not REQUIRED for conformance.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

- `workflow.prompt_template`
- normalized `issue` object
- OPTIONAL `attempt` integer

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, assignees, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` SHOULD be passed to the template. Note that within a single worker run, continuation
turns (`--resume <session_id>`) do not re-render the original prompt; they send only continuation
guidance. The orchestrator MAY provide a short continuation prompt template such as
`Continue with the next step on issue {{issue.identifier}}.`, configurable in
`claude.continuation_prompt` (extension field, OPTIONAL).

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

REQUIRED context fields for issue-related logs:

- `issue_id`
- `issue_identifier`
- `repository`

REQUIRED context for session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads (especially full prompt bodies or full tool results).

### 13.2 Logging Outputs and Sinks

The spec does not prescribe sinks. Operators MUST be able to see startup/validation/dispatch
failures without attaching a debugger. Sink failures SHOULD NOT crash the service.

### 13.3 Runtime Snapshot / Monitoring Interface (OPTIONAL but RECOMMENDED)

If exposed, snapshot SHOULD return:

- `running` (list of running session rows, each including `turn_count`)
- `retrying` (list of retry queue rows)
- `claude_totals` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `total_tokens`, `seconds_running`, `total_cost_usd`.
- `tracker_rate_limits` (latest GitHub rate-limit headers/cost summary, if available)
- `claude_rate_limits` (latest Anthropic rate-limit payload, if available)

RECOMMENDED snapshot error modes: `timeout`, `unavailable`.

### 13.4 OPTIONAL Human-Readable Status Surface

Implementation-defined. If present, driven from orchestrator state only.

### 13.5 Session Metrics and Token Accounting

Token accounting rules for Claude Code stream-json:

- Prefer the cumulative `usage` block carried on the terminal `result` message of each turn.
- That block typically includes `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, and `total_cost_usd`.
- Within a single session, treat per-turn `result.usage` values as the per-turn delta; accumulate
  into orchestrator-level totals.
- `assistant` messages may also carry partial usage in some Claude Code versions; treat partials
  as advisory only and prefer the `result` totals.
- For absolute thread/session totals, sum per-turn `result.usage` values; do not double-count.

Runtime accounting:

- Reported as a live aggregate at snapshot/render time.
- Add run duration seconds to the cumulative ended-session runtime when a session ends.
- Continuous background ticking is not REQUIRED.

Cost accounting:

- Accumulate `total_cost_usd` from each `result`'s usage block.
- Implementations MAY also derive cost from token counts and a static price table if Claude Code
  does not report cost in its stream-json variant.

Rate-limit tracking:

- For GitHub: track `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and GraphQL `cost`/`remaining`
  from each tracker call.
- For Claude Code: track any rate-limit information surfaced in `system` or `result` events;
  Claude Code typically reports this in the `result` message or via stderr on throttling.

### 13.6 Humanized Agent Event Summaries (OPTIONAL)

OPTIONAL. Treat as observability-only output. Do not couple orchestrator logic to humanized text.

### 13.7 OPTIONAL HTTP Server Extension

Same as canonical spec. Suggested endpoint shapes for this profile:

- `GET /api/v1/state` — returns running, retrying, `claude_totals`, `tracker_rate_limits`,
  `claude_rate_limits`.

  Example:

  ```json
  {
    "generated_at": "2026-02-24T20:15:30Z",
    "counts": { "running": 2, "retrying": 1 },
    "running": [
      {
        "issue_id": "I_kwDOA...",
        "issue_identifier": "acme/api#142",
        "repository": "acme/api",
        "state": "In Progress",
        "session_id": "5bf2c1d4-...",
        "turn_count": 3,
        "last_event": "turn_completed",
        "last_message": "ran tests",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 12400,
          "output_tokens": 3100,
          "cache_creation_input_tokens": 8800,
          "cache_read_input_tokens": 41200,
          "total_tokens": 65500
        },
        "cost_usd": 0.184
      }
    ],
    "retrying": [
      {
        "issue_id": "I_kwDOA...",
        "issue_identifier": "acme/api#143",
        "attempt": 3,
        "due_at": "2026-02-24T20:16:00Z",
        "error": "no available orchestrator slots"
      }
    ],
    "claude_totals": {
      "input_tokens": 51000,
      "output_tokens": 9400,
      "cache_creation_input_tokens": 22000,
      "cache_read_input_tokens": 180000,
      "total_tokens": 262400,
      "seconds_running": 1834.2,
      "total_cost_usd": 0.732
    },
    "tracker_rate_limits": {
      "graphql_remaining": 4700,
      "graphql_reset_at": "2026-02-24T20:30:00Z"
    },
    "claude_rate_limits": null
  }
  ```

- `GET /api/v1/<issue_identifier>` — `issue_identifier` is URL-encoded `<owner>/<repo>#<number>`
  (or `<owner>__<repo>__<number>` when path-safe encoding is preferred). The dashboard SHOULD
  document its chosen encoding.

- `POST /api/v1/refresh` — same semantics as canonical spec.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind (anything other than `github` in this profile)
   - Missing GitHub credentials, repository, or project ID
   - Missing `claude` executable

2. `Workspace Failures`
   - Workspace directory creation failure
   - Workspace population/synchronization failure (often `git clone` failing in `after_create`)
   - Invalid workspace path configuration
   - Hook timeout/failure

3. `Agent Session Failures`
   - Startup failure (`claude_not_found`, `claude_auth_missing`, `startup_timeout`)
   - Turn failed/cancelled
   - Turn timeout
   - Subprocess exit without `result`
   - Stalled session (no activity)
   - `permission_blocked`

4. `Tracker Failures`
   - GitHub API transport errors
   - Non-200 status
   - GraphQL errors
   - Rate-limit / secondary rate-limit
   - Malformed payloads

5. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

### 14.2 Recovery Behavior

- Dispatch validation failures: skip new dispatches, keep service alive, continue reconciliation.
- Worker failures: convert to retries with exponential backoff.
- Tracker candidate-fetch failures: skip this tick, try again on next.
- Rate limiting: skip dispatch and increase next tick's effective interval up to
  `polling.interval_ms * 4`, capped by `agent.max_retry_backoff_ms`.
- Reconciliation state-refresh failures: keep current workers, retry on next tick.
- Dashboard/log failures: do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

Same in-memory design as the canonical spec. After restart:

- No retry timers are restored.
- No running sessions are assumed recoverable.
- Service recovers by: startup terminal workspace cleanup, fresh polling of active issues, and
  re-dispatching eligible work.

A nuance for this profile: because Claude Code session UUIDs are stored only in memory, a
worker restart MUST start a new Claude Code session (no `--resume` carryover across orchestrator
restarts). Workspaces, including any Git branches and uncommitted local changes, are preserved.

### 14.4 Operator Intervention Points

- Editing `WORKFLOW.md` (prompt and most runtime settings) — auto-applied.
- Changing issue state in GitHub:
  - Closing issue, removing active label, removing assignee filter match, or moving Project
    `Status` to a terminal value -> running session is stopped and workspace cleaned when
    reconciled.
  - Moving to a non-active, non-terminal state -> running session is stopped without cleanup.
- Restarting the service.

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary. Implementations SHOULD state clearly:

- Whether they run with `bypassPermissions` or with restricted `allowed_tools`.
- Whether they rely on auto-approved actions, operator approvals, additional sandboxing (e.g.
  containers, jails, separate OS users), or some combination.
- Whether the configured `GITHUB_TOKEN` has write scopes — and if so, to which repositories.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path MUST remain under configured workspace root.
- Claude Code cwd MUST be the per-issue workspace path for the current run.
- Workspace directory names MUST use sanitized identifiers.
- `claude.add_dir` entries MUST NOT include `workspace.root` or any path that contains another
  issue's workspace.

RECOMMENDED additional hardening for ports:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.
- Consider running each Claude Code invocation inside an ephemeral container (Docker, Firejail,
  Bubblewrap, macOS sandbox-exec, or equivalent) when `permission_mode == "bypassPermissions"`.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, GitHub App private keys, or other secret env
  values.
- Validate presence of secrets without printing them.
- When `tracker.app_credentials` is used and the runtime mints short-lived installation tokens,
  prefer per-workspace token issuance (so a compromised workspace does not leak a long-lived
  PAT).
- When passing `GITHUB_TOKEN` into the workspace for `gh` CLI use, prefer environment-variable
  injection over writing tokens to disk. If a disk file is required (e.g. `~/.config/gh/`),
  scope it to the per-issue workspace and remove it on `before_remove`.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md`.

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory with the env vars listed in Section 5.3.4.
- Hook output SHOULD be truncated in logs.
- Hook timeouts are REQUIRED to avoid hanging the orchestrator.
- Hook env variables include `SYMPHONY_ISSUE_*` and any operator-configured exports; implementers
  SHOULD avoid injecting raw `GITHUB_TOKEN` into hook env unless the hook script explicitly needs
  it (typical for `git clone https://x-access-token:${GITHUB_TOKEN}@github.com/...` patterns).

### 15.5 Harness Hardening Guidance

Running Claude Code against repositories, GitHub Issues, and other inputs that can contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to
execute harmful commands or use overly-powerful integrations.

Implementations SHOULD explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture,
but implementations SHOULD NOT assume that GitHub issue text, repository contents, prompt inputs,
or tool arguments are fully trustworthy just because they originate inside a normal workflow.

Possible hardening measures include:

- Tightening Claude Code `permission_mode` and `allowed_tools` instead of running with
  `bypassPermissions` by default.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond Claude Code's built-in permission controls.
- Filtering which GitHub issues are eligible for dispatch — by repository, project, labels,
  assignees, or author — so untrusted or out-of-scope issues do not automatically reach the
  agent. Prompt injection from issue authors is a real concern.
- Narrowing the `github_graphql` tool (when implemented) so it can only read or mutate data
  inside the intended repository/project scope, rather than exposing organization-wide GitHub
  access.
- Restricting the `gh` CLI's authentication scope (fine-grained PAT or GitHub App with minimal
  installation permissions) so the agent cannot mutate resources outside the configured
  repository or project.
- Reducing the set of client-side tools, credentials, filesystem paths (`--add-dir`), MCP
  servers, and network destinations available to the agent to the minimum needed for the
  workflow.

The correct controls are deployment-specific, but implementations SHOULD document them clearly
and treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    claude_totals: {input_tokens: 0, output_tokens: 0,
                    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
                    total_tokens: 0, seconds_running: 0, total_cost_usd: 0.0},
    tracker_rate_limits: null,
    claude_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = github.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break
    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = github.fetch_issue_states_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states or issue.github_state == "closed":
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if issue.state in active_states:
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle, monitor_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    claude_pid: null,
    last_message: null,
    last_event: null,
    last_event_timestamp: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    total_cost_usd: 0.0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + Claude Code)

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed: fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  max_turns = config.agent.max_turns
  turn_number = 1
  session_id = null

  while true:
    prompt = build_turn_prompt(workflow_template, issue, attempt,
                                turn_number, max_turns, is_continuation=(session_id != null))
    if prompt failed:
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = claude.run_turn(
      cwd=workspace.path,
      prompt=prompt,
      resume_session_id=session_id,        # null on first turn
      on_message=(msg) -> {
        if msg.type == "system" and msg.subtype == "init":
          session_id = msg.session_id
        send(orchestrator_channel, {claude_update, issue.id, msg})
      }
    )

    if turn_result failed:
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("claude turn error")

    refreshed_issue = github.fetch_issue_states_by_ids([issue.id])
    if refreshed_issue failed:
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    issue = refreshed_issue[0] or issue

    if issue.state is not active or issue.github_state == "closed":
      break
    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  run_hook_best_effort("after_run", workspace.path)
  exit_normal()
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing: return state

  candidates = github.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. Test and Validation Matrix

Validation profiles:

- `Core Conformance`: deterministic tests REQUIRED for all conforming implementations.
- `Extension Conformance`: REQUIRED only for OPTIONAL features that an implementation ships.
- `Real Integration Profile`: environment-dependent smoke/integration checks RECOMMENDED before
  production use.

Unless otherwise noted, Sections 17.1 through 17.7 are `Core Conformance`. Bullets beginning with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence: explicit runtime path is used when provided; cwd default is
  `WORKFLOW.md`.
- Workflow file changes are detected and trigger re-read/re-apply without restart.
- Invalid workflow reload keeps last known good effective configuration and emits an
  operator-visible error.
- Missing `WORKFLOW.md` returns typed error.
- Invalid YAML front matter returns typed error.
- Front matter non-map returns typed error.
- Config defaults apply when OPTIONAL values are missing.
- `tracker.kind == "github"` is accepted; other values fail validation.
- `tracker.api_key` works including `$VAR` indirection.
- `tracker.app_credentials` precedence over `api_key` is honored when both are present.
- `tracker.repository` is required when `project_id` is absent; either one passes validation.
- `$VAR` resolution works for tracker API key and path values.
- `~` path expansion works.
- `claude.command` is preserved as a shell command string.
- `claude.permission_mode`, `claude.allowed_tools`, `claude.model` are reflected in launch args.
- Per-state concurrency override map normalizes state names and ignores invalid values.
- Prompt template renders `issue` and `attempt`.
- Prompt rendering fails on unknown variables (strict mode).

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per issue identifier (e.g. `acme/api#142` →
  `<root>/acme_api_142`).
- Missing workspace directory is created.
- Existing workspace directory is reused.
- `after_create` hook runs only on new workspace creation.
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt.
- `after_run` hook runs after each attempt and failures/timeouts are logged and ignored.
- `before_remove` hook runs on cleanup and failures/timeouts are ignored.
- Workspace path sanitization and root containment invariants are enforced before agent launch.
- `claude.add_dir` containment check rejects paths inside `workspace.root`.
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths.

### 17.3 Issue Tracker Client (GitHub)

- Candidate issue fetch uses configured `repository` or `project_id` and active states.
- GraphQL query for repository mode filters on `states: OPEN`.
- GraphQL query for project mode uses `node(id: $projectId)` and reads the configured Status
  field.
- Empty `fetch_issues_by_states([])` returns empty without API call.
- Pagination preserves order across multiple pages.
- Blockers are derived from at least one supported source and resolved when possible.
- Labels are normalized to lowercase; assignees are normalized to lowercase.
- Issue state refresh by ID returns minimal normalized issues using `[ID!]!` variable typing.
- ETag-conditional REST polling (when `polling.use_etag` is true) handles `304 Not Modified`.
- Rate-limit handling: `403`/`429` with rate-limit headers maps to `github_rate_limited` and
  causes the next tick to back off.
- Error mapping for transport errors, non-200 statuses, GraphQL errors, malformed payloads.

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time.
- First-active-state issue with non-terminal blockers is not eligible.
- First-active-state issue with terminal blockers is eligible.
- Active-state issue refresh updates running entry state.
- Non-active state stops running agent without workspace cleanup.
- Terminal state (label, project, or `closed`) stops running agent and cleans workspace.
- Reconciliation with no running issues is a no-op.
- Normal worker exit schedules a short continuation retry (attempt 1).
- Abnormal worker exit increments retries with 10s-based exponential backoff.
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`.
- Retry queue entries include attempt, due time, identifier, and error.
- Stall detection kills stalled sessions and schedules retry.
- Slot exhaustion requeues retries with explicit error reason.
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, cost
  totals, and rate limits.

### 17.5 Claude Code Runner

- Launch invokes `bash -lc "<claude> -p <prompt> --output-format stream-json --verbose ..."` with
  workspace as cwd.
- First turn omits `--resume`; subsequent turns include `--resume <session_id>`.
- `session_id` is extracted from the first `system`/`init` event and reused for the worker run.
- `claude.model`, `claude.permission_mode`, `claude.allowed_tools`, `claude.disallowed_tools`,
  `claude.mcp_config`, `claude.add_dir`, and `claude.extra_args` are mapped to CLI flags as
  specified.
- Read timeout (`claude.read_timeout_ms`) fires if no init event is observed in time.
- Turn timeout (`claude.turn_timeout_ms`) terminates the subprocess.
- Stall timeout (`claude.stall_timeout_ms`) fires from the orchestrator based on event freshness.
- Stream-json `result.success` maps to `turn_completed`; any `result.error_*` subtype maps to
  `turn_failed`.
- Subprocess exit without a `result` line maps to `subprocess_exit` / `turn_ended_with_error`.
- Usage from each `result` is accumulated into orchestrator totals without double-counting.
- Non-JSON stdout lines are logged as `malformed` and do not crash the runner.
- Diagnostic stderr is captured separately from the protocol stream.
- If `permission_mode == "default"` and a `permission_request`-like event surfaces, the
  implementation's documented policy applies and no run stalls indefinitely.
- If the `github_graphql` client-side tool extension is implemented:
  - the tool is advertised via MCP config or equivalent mechanism
  - valid `query`/`variables` inputs execute against configured GitHub auth
  - top-level GraphQL `errors` produce `success=false` while preserving the body
  - invalid arguments, missing auth, and transport failures return structured failure payloads
  - unsupported tool names still fail without stalling the session

### 17.6 Observability

- Validation failures are operator-visible.
- Structured logging includes `issue_id`, `issue_identifier`, `repository`, and `session_id`
  context fields.
- Logging sink failures do not crash orchestration.
- Token/cost/rate-limit aggregation remains correct across repeated Claude Code updates.
- If a human-readable status surface is implemented, it is driven from orchestrator state and
  does not affect correctness.

### 17.7 CLI and Host Lifecycle

- CLI accepts a positional workflow path argument (`path-to-WORKFLOW.md`).
- CLI uses `./WORKFLOW.md` when no workflow path argument is provided.
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`.
- CLI surfaces startup failure cleanly.
- CLI exits with success when application starts and shuts down normally.
- CLI exits nonzero when startup fails or the host process exits abnormally.

### 17.8 Real Integration Profile (RECOMMENDED)

- A real GitHub smoke test can be run with valid credentials supplied by `GITHUB_TOKEN` or a
  documented local bootstrap mechanism (for example `gh auth status` succeeding).
- A real Claude Code smoke test runs against a fixture repository with a single open issue and
  verifies that a `result.success` is observed.
- Real integration tests SHOULD use isolated test repositories or scoped labels (e.g.
  `symphony-test`) and clean up tracker artifacts when practical.
- Skipped real-integration tests SHOULD be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures
  SHOULD fail that job.

## 18. Implementation Checklist (Definition of Done)

Same profile structure as the canonical spec.

### 18.1 REQUIRED for Conformance

- Workflow path selection supports explicit runtime path and cwd default.
- `WORKFLOW.md` loader with YAML front matter + prompt body split.
- Typed config layer with defaults and `$` resolution.
- Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt.
- Polling orchestrator with single-authority mutable state.
- GitHub tracker client with candidate fetch (repository or project mode), state refresh by ID,
  and bounded terminal fetch.
- Rate-limit-aware tracker behavior (back off on 403/429 with headers).
- Workspace manager with sanitized per-issue workspaces.
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`).
- Hook timeout config (`hooks.timeout_ms`, default `60000`).
- Claude Code runner that invokes `claude -p ... --output-format stream-json --verbose` per
  turn and uses `--resume <session_id>` for continuation turns.
- Claude Code launch config (`claude.command`, default `claude`).
- Strict prompt rendering with `issue` and `attempt` variables.
- Exponential retry queue with continuation retries after normal exit.
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m).
- Reconciliation that stops runs on terminal/non-active GitHub states (including `closed`).
- Workspace cleanup for terminal issues (startup sweep + active transition).
- Structured logs with `issue_id`, `issue_identifier`, `repository`, and `session_id`.
- Operator-visible observability (structured logs; OPTIONAL snapshot/status surface).

### 18.2 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- HTTP server extension honoring the canonical Section 13.7 contract, with the request/response
  field naming adjustments noted in Section 13.7 above.
- `github_graphql` client-side tool extension exposing scoped raw GitHub GraphQL access through
  Claude Code via an MCP server using configured Symphony auth.
- GitHub App credential support (`tracker.app_credentials`).
- Projects v2 mode (`tracker.project_id`).
- ETag-conditional REST polling (`polling.use_etag`).
- TODO: Persist retry queue and session metadata across process restarts, including the last
  Claude Code `session_id` for `--resume` carryover.
- TODO: First-class tracker write APIs (comments/state transitions) in the orchestrator instead
  of only via `gh` / MCP / GraphQL tools.
- TODO: Pluggable issue tracker adapters (matching the canonical Symphony spec's
  pluggable-tracker direction).

### 18.3 Operational Validation Before Production (RECOMMENDED)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials and network
  access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- Verify `claude` and `gh` CLIs are installed and authenticated in the workspace's effective
  PATH/environment.
- If the OPTIONAL HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.
- Verify the configured `GITHUB_TOKEN` scope is the minimum needed for the workflow (principle of
  least privilege).

## Appendix A. SSH Worker Extension (OPTIONAL)

Identical in intent to the canonical spec's Appendix A. Notes specific to this profile:

- The `claude` and `gh` CLIs MUST be present on each SSH host, with matching authentication
  available either via env vars (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) or per-host configuration
  (e.g. `gh auth login --with-token`, `claude` OAuth).
- Workspace locality means a continuation turn on a different host requires a cold restart and a
  new Claude Code `session_id` (no `--resume` works across hosts unless shared session state is
  arranged, which is out of scope for this profile).
- Per-host concurrency caps via `worker.max_concurrent_agents_per_host` apply as described in
  the canonical spec.

## Appendix B. Example `WORKFLOW.md`

```markdown
---
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  repository: acme/api
  state_source: labels
  state_label_prefix: "status:"
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Cancelled", "Wont Fix", "Duplicate"]
  priority_source: labels
  priority_label_pattern: "^p(\\d)$"
  assignee_filter: ["@me"]
  label_filters:
    include: ["symphony"]
    exclude: ["needs-human"]

polling:
  interval_ms: 30000
  use_etag: true

workspace:
  root: ~/symphony-workspaces

hooks:
  after_create: |
    git clone --depth=1 \
      https://x-access-token:${GITHUB_TOKEN}@github.com/${SYMPHONY_ISSUE_REPOSITORY}.git .
    git config user.email "symphony-bot@example.com"
    git config user.name  "Symphony Bot"
  before_run: |
    git fetch origin
    git checkout -B "symphony/${SYMPHONY_ISSUE_BRANCH_NAME}" "origin/main"
  after_run: |
    git status --short || true

agent:
  max_concurrent_agents: 4
  max_turns: 8
  max_retry_backoff_ms: 300000

claude:
  command: claude
  model: claude-sonnet-4-6
  permission_mode: bypassPermissions
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
  extra_args: ["--include-partial-messages"]
---

# Issue {{ issue.identifier }}: {{ issue.title }}

Repository: {{ issue.repository }}
Labels: {{ issue.labels | join: ", " }}
Assignees: {{ issue.assignees | join: ", " }}

{% if attempt %}
> This is retry/continuation attempt #{{ attempt }}.
{% endif %}

## Description

{{ issue.description }}

## Your task

1. Read the issue body and any linked references.
2. Make the required changes on the current branch.
3. Run the project's tests (e.g. `npm test`, `pytest`, `mix test`) and ensure they pass.
4. Use `gh` to:
   - open a pull request when the work is ready for review,
   - add the `needs-review` label to this issue,
   - and post a short summary comment linking the PR.
5. When the PR is open and the issue is labeled `needs-review`, your work is done — stop.

If you hit something you can't resolve (missing context, broken environment, ambiguous
requirements), add the `needs-human` label, comment with your blockers, and stop. Do not
fabricate solutions.
```

## Appendix C. Mapping to the Canonical Symphony Spec

This profile is intentionally a near-isomorphic re-target of the canonical Symphony spec
(`SPEC.md`). The substantive deltas are concentrated in:

- Section 4.1.1 / 4.2 — issue identifier shape and additional `repository`, `assignees`,
  `number` fields.
- Section 5.3.1 — `tracker.kind: github` schema replacing the Linear schema.
- Section 5.3.6 — `claude` config block replacing `codex`.
- Section 10 — Claude Code per-turn subprocess + `--resume` continuation model replacing the
  Codex app-server long-running stdio model. Notably, Claude Code is invoked once per turn,
  and session continuity comes from `--resume` rather than from a persistent subprocess.
- Section 11 — GitHub adapter (REST/GraphQL, Projects v2, ETag handling, rate-limit handling,
  blockers from `timelineItems`/body parsing).
- Section 13.5 — token accounting fields adapted to Claude Code's `usage` shape
  (`cache_creation_input_tokens`, `cache_read_input_tokens`, `total_cost_usd`).
- Section 15 — security posture explicitly references `permission_mode` and GitHub token
  scoping.

Everything else — the orchestration state machine, workspace safety invariants, retry/backoff
math, polling cadence, hook lifecycle, dynamic reload semantics, validation profiles, and the
in-memory recovery model — is preserved verbatim from the canonical spec, so an implementation
of this profile is also a faithful Symphony implementation.
