# Plan — Pause / Resume (interrupt) for Symphony sessions

Status: Draft v1
Scope: `typescript2/` (PowerShell edition)

A plan to let an operator **interrupt a running Claude Code session, hold it in a
`Paused` state, and resume it later** — driven from the dashboard.

## 1. The core constraint

Symphony does *not* hold a long-lived agent process. Per
[`src/agent/claude.ts`](../src/agent/claude.ts), each turn is a fresh `claude`
subprocess; continuity between turns is `--resume <session_id>`. That shapes
everything:

- **Between turns** — pausing is trivial: don't launch the next turn. The
  `session_id` is already known, so a later turn can `--resume` it.
- **Mid-turn** (a `claude` subprocess is streaming) — there is no "suspend" in
  the stream-json protocol. You can only kill the subprocess. The partial turn's
  reasoning is lost, but `--resume` recovers everything committed up to the last
  completed turn.

So "pause" has two flavors, and the plan supports both:

| Mode | Behavior | Cost |
| --- | --- | --- |
| **Graceful** (default) | Finish the in-flight turn, then stop before the next one | No lost work; pause isn't instant |
| **Interrupt** | Kill the `claude` subprocess immediately | Instant; current turn's partial work discarded |

Resume always re-enters the per-turn loop with `--resume <session_id>` — which
already exists in `runAttempt` as the continuation path (`sessionId != null`).

> **Scope choice.** The full design preserves `session_id` for true `--resume`
> continuity (**Approach B**). It naturally degrades to a fresh re-dispatch when
> no `session_id` was captured yet. A lighter MVP (**Approach A**) skips session
> preservation entirely — pause kills the worker and marks the issue "held";
> resume re-dispatches a fresh session into the same (preserved) workspace /
> branch. Recommendation: build **B**, with **A** as the natural fallback path.

## 2. New orchestration state: `Paused`

The spec's states are `Unclaimed → Claimed → Running → RetryQueued → Released`.
Add **`Paused`**: the issue stays `claimed` (so the poll loop won't re-dispatch
it), but has no worker, no retry timer, and no concurrency slot.

A paused session lives in a new `paused: Map<string, PausedEntry>` on the
orchestrator. `PausedEntry` is a frozen snapshot carrying everything resume
needs: `issue`, `session_id`, `workspace_path`, `turn_count`, `retry_attempt`,
token counters, `total_cost_usd`, `events`, `started_at`, `paused_at`,
`paused_reason`.

## 3. Backend changes

### `src/types.ts`

- `RunAttemptStatus` += `"Paused"`.
- New `PausedEntry` interface.
- `snapshot()` return type gains `paused: PausedRow[]` and `counts.paused`.

### `src/orchestrator/orchestrator.ts` — most of the work

- **State:** add the `paused` map; add a pause intent per running entry
  (`RunningInternal.pauseIntent: "graceful" | "immediate" | null`).
- **`pauseByIdentifier(ident, mode)`:**
  - Graceful → set `entry.pauseIntent = "graceful"`.
  - Interrupt → set `entry.pauseIntent = "immediate"` and
    `entry.workerAbort.abort("pause")`.
  - Idempotent; returns `{ ok, status }` or `{ error }`.
- **Per-turn loop in `runAttempt`:** check `pauseIntent === "graceful"` at each
  turn boundary (top of loop + after a successful `runTurn`) → exit with a new
  outcome `"paused"`. The existing `signal.aborted` check learns to recognize
  abort reason `"pause"` → also `"paused"` (not a failure).
- **`runAttempt` outcome:** `workerExitReason` gains `"paused"`; `entry.status`
  becomes `"Paused"`.
- **`afterWorkerExit`:** new branch — if `status === "Paused"`, move the entry
  into `paused`, **keep it in `claimed`**, add runtime seconds to totals, but
  **schedule no retry and do not clean the workspace**.
- **`resumeByIdentifier(ident)`:**
  - Look up `paused`; check `hasGlobalSlot()` / `hasStateSlot()` — if no slot,
    leave paused and return `{ error: "no_slot" }`.
  - Otherwise remove from `paused` and call a new `dispatchResume(pausedEntry)`.
- **`dispatchResume` / `runAttempt` resume context:** `runAttempt` gains an
  optional `resume?: { sessionId, startTurn, priorTokens, priorCost }`. When
  present: reuse the workspace (`createForIssue` returns `created_now=false` → no
  `after_create`), **skip `before_run`** (avoids re-running `git checkout -B …`,
  which would clobber in-progress branch state), start the loop at
  `turnNumber = startTurn` with `sessionId` pre-set, and seed token / cost
  counters from the paused entry.
- **Reconciliation:** extend the `fetchIssueStatesByIds` call to also include
  paused issue IDs. If a paused issue went terminal / closed → discard it, clean
  the workspace, drop from `claimed`. If non-active → discard without cleanup.
- **`snapshot()`:** emit the `paused` array + `counts.paused`. Emit
  `session_paused` / `session_resumed` events for the SSE feed and structured
  log.

### `src/agent/claude.ts`

Minimal — interrupt mode reuses the existing `cancelSignal` kill path. The
pause-vs-cancel distinction lives entirely in the abort *reason* string the
orchestrator inspects. (Optional: label the emitted event `turn_paused` vs
`turn_cancelled` for cleaner observability.)

### `src/http/server.ts`

Add mutation routes (siblings of the existing `POST /api/v1/refresh`):

- `POST /api/v1/sessions/<urlencoded-ident>/pause` — body
  `{ "mode": "graceful" | "interrupt" }`, default graceful.
- `POST /api/v1/sessions/<urlencoded-ident>/resume`.
- Responses: `{ ok, status }` or `{ error }` with `404` (not found) / `409`
  (no slot / bad state).
- Keep the default `127.0.0.1` bind; if `--host` is non-loopback, gate these
  behind a shared-secret header.

## 4. Frontend changes — `web/app.js` + `web/styles.css`

- **`SessionCard`** gains an action row: a **Pause** button (graceful) with a
  small caret for **Interrupt now**. `stopPropagation` so it doesn't toggle the
  card's expand.
- New **"Paused sessions"** section in the main column (below live sessions):
  renders `snapshot.paused` as cards with a `Paused` pill, the pause reason /
  time, and a **Resume** button. Resume surfaces a toast on `409 no_slot`.
- `App` reads `snapshot.paused`; the **Active sessions** metric footer shows
  `· N paused`.
- Buttons `fetch()` the new endpoints; SSE already pushes the resulting
  snapshot, so the UI updates with no extra polling.
- Styles: a `paused` pill (amber), a `.btn-sm` variant, and an `is-paused` card
  accent.

## 5. Edge cases & invariants

- **Paused before first turn** (`session_id` still null) → resume starts a
  *fresh* session (turn 1, full task prompt). Approach B degrading to A.
- **Stall detection** — paused entries aren't in `running`, so they're already
  excluded.
- **Issue closed while paused** — handled by the reconciliation sweep (§3).
- **Double pause / double resume** — idempotent no-ops.
- **`max_turns` reached at the same boundary as a pause** — completion wins (the
  session is effectively done).
- **Workspace deleted while paused** — resume recreates it (`after_create`
  re-clones); `--resume` may still work since Claude Code's session store is
  keyed by cwd. Document as a degraded case.

## 6. Optional — surviving a Symphony restart

Paused state is in-memory, so a Symphony restart loses it (spec §14.3). Because
Claude Code's own session store and the workspace both live on disk, `--resume`
*can* outlive a Symphony restart if we persist the paused metadata. Add a small
JSON file (e.g. `<workspace.root>/.symphony/paused.json`) written on pause and
read on startup. This directly satisfies the spec §18.2 TODO ("persist … the
last Claude Code `session_id` for `--resume` carryover"). Recommended as a
separate, later phase.

## 7. Phasing

1. **Backend pause/resume (graceful) + reconcile sweep** — types, orchestrator,
   HTTP. Functionally complete headless.
2. **Interrupt mode** — abort-reason wiring.
3. **Dashboard UI** — buttons + Paused section.
4. **Persistence across restart** *(optional)*.

## 8. Testing

- **Unit:** paused entry created on graceful exit; `afterWorkerExit` schedules
  no retry for `Paused`; resume rebuilds the loop at `startTurn`.
- **Integration** (against a fixture issue): pause graceful → verify it lands in
  `paused` after the current turn; resume → verify the next `runTurn` carries
  `--resume <session_id>`; interrupt → verify the subprocess dies fast and the
  entry is still `Paused`, not `Failed`.
- **Reconcile:** close the issue while paused → workspace cleaned, entry
  dropped.

## 9. Open decisions

1. **Default pause = graceful**, with "Interrupt now" as the explicit hard-kill.
2. On resume, **skip `before_run`** (so it doesn't `git checkout -B` over
   in-progress work). Alternative: a `hooks.run_before_resume` config flag.
3. Build **Approach B** (true `--resume` continuity) now, or ship the lighter
   **Approach A** MVP first.
4. Include **restart persistence** (§6) in this effort, or defer it.
