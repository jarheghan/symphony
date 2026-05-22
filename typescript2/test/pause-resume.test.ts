// §8 pause / resume tests — exercises the orchestrator with injected fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { setLogLevel } from "../src/logging/logger.js";
import {
  FakeAgent,
  FakeTracker,
  FakeWorkspace,
  makeIssue,
  makeWorkflow,
  waitFor,
} from "./helpers.js";

setLogLevel("error"); // keep test output quiet

/** Dispatch one issue and wait until its first turn is in flight. */
async function dispatchAndAwaitTurn1(
  orch: Orchestrator,
  tracker: FakeTracker,
  agent: FakeAgent,
  issue = makeIssue(),
) {
  tracker.candidates = [issue];
  tracker.statesById.set(issue.id, issue);
  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1, { label: "turn 1 dispatched" });
  return issue;
}

test("graceful pause lands in `paused` after the in-flight turn, with no retry", async () => {
  const tracker = new FakeTracker();
  const ws = new FakeWorkspace();
  const agent = new FakeAgent();
  const orch = new Orchestrator(makeWorkflow(), {
    tracker,
    workspaceManager: ws,
    runTurn: agent.runTurn,
  });

  const issue = await dispatchAndAwaitTurn1(orch, tracker, agent);

  // Graceful pause while turn 1 is still streaming.
  assert.deepEqual(orch.pauseByIdentifier(issue.identifier, "graceful"), {
    ok: true,
    status: "Pausing",
  });

  // Turn 1 finishes — the worker must stop at the boundary, not launch turn 2.
  agent.completeTurn(0, { session_id: "sess-1" });
  await waitFor(() => orch.snapshot().counts.paused === 1, {
    label: "session lands in paused",
  });

  const snap = orch.snapshot();
  assert.equal(snap.running.length, 0);
  assert.equal(snap.counts.paused, 1);
  assert.equal(snap.retrying.length, 0, "a paused session schedules no retry");
  assert.equal(agent.calls.length, 1, "turn 2 must not have launched");

  const p = snap.paused[0];
  assert.equal(p.issue_identifier, issue.identifier);
  assert.equal(p.session_id, "sess-1");
  assert.equal(p.resume_start_turn, 2, "resume continues from the next turn");
  assert.equal(p.paused_reason, "graceful");

  await orch.stop();
});

test("resume re-enters the per-turn loop at startTurn carrying the session id", async () => {
  const tracker = new FakeTracker();
  const ws = new FakeWorkspace();
  const agent = new FakeAgent();
  const orch = new Orchestrator(makeWorkflow(), {
    tracker,
    workspaceManager: ws,
    runTurn: agent.runTurn,
  });

  const issue = await dispatchAndAwaitTurn1(orch, tracker, agent);
  orch.pauseByIdentifier(issue.identifier, "graceful");
  agent.completeTurn(0);
  await waitFor(() => orch.snapshot().counts.paused === 1);

  assert.deepEqual(orch.resumeByIdentifier(issue.identifier), {
    ok: true,
    status: "Running",
  });
  await waitFor(() => agent.calls.length === 2, { label: "turn 2 launched" });

  // `runTurn`'s `--resume <id>` flag derives from `resumeSessionId`.
  const ctx = agent.calls[1];
  assert.equal(ctx.resumeSessionId, "sess-1", "resumed turn carries the session id");
  assert.equal(ctx.turnNumber, 2, "loop re-enters at the recorded start turn");

  const snap = orch.snapshot();
  assert.equal(snap.counts.paused, 0);
  assert.equal(snap.running.length, 1);
  assert.equal(ws.removed.length, 0, "resume reuses the preserved workspace");

  await orch.stop();
});

test("interrupt kills the turn fast; the entry is Paused, not Failed", async () => {
  const tracker = new FakeTracker();
  const ws = new FakeWorkspace();
  const agent = new FakeAgent();
  const orch = new Orchestrator(makeWorkflow(), {
    tracker,
    workspaceManager: ws,
    runTurn: agent.runTurn,
  });

  const issue = await dispatchAndAwaitTurn1(orch, tracker, agent);

  const before = Date.now();
  assert.deepEqual(orch.pauseByIdentifier(issue.identifier, "interrupt"), {
    ok: true,
    status: "Pausing",
  });

  await waitFor(() => orch.snapshot().counts.paused === 1, {
    label: "interrupt lands in paused",
  });
  assert.ok(Date.now() - before < 1000, "interrupt resolves promptly");

  const snap = orch.snapshot();
  assert.equal(snap.running.length, 0);
  assert.equal(snap.counts.paused, 1);
  assert.equal(snap.retrying.length, 0, "interrupt is not a failure — no retry");

  const p = snap.paused[0];
  assert.equal(p.status, "Paused");
  assert.equal(p.paused_reason, "interrupt");
  assert.equal(p.resume_start_turn, 1, "the interrupted turn is re-run on resume");

  await orch.stop();
});

test("reconcile discards a paused issue that closed and cleans its workspace", async () => {
  const tracker = new FakeTracker();
  const ws = new FakeWorkspace();
  const agent = new FakeAgent();
  const orch = new Orchestrator(makeWorkflow(), {
    tracker,
    workspaceManager: ws,
    runTurn: agent.runTurn,
  });

  const issue = await dispatchAndAwaitTurn1(orch, tracker, agent);
  orch.pauseByIdentifier(issue.identifier, "graceful");
  agent.completeTurn(0);
  await waitFor(() => orch.snapshot().counts.paused === 1);

  // The issue is closed on GitHub while the session is paused.
  tracker.statesById.set(
    issue.id,
    makeIssue({ github_state: "closed", state: "Done" }),
  );
  tracker.candidates = [];

  await orch.forceRefresh(); // runs the reconcile sweep

  const snap = orch.snapshot();
  assert.equal(snap.counts.paused, 0, "the paused entry is discarded");
  assert.deepEqual(ws.removed, [issue.identifier], "workspace cleaned exactly once");

  await orch.stop();
});

test("double pause and double resume are idempotent no-ops", async () => {
  const tracker = new FakeTracker();
  const ws = new FakeWorkspace();
  const agent = new FakeAgent();
  const orch = new Orchestrator(makeWorkflow(), {
    tracker,
    workspaceManager: ws,
    runTurn: agent.runTurn,
  });

  const issue = await dispatchAndAwaitTurn1(orch, tracker, agent);
  orch.pauseByIdentifier(issue.identifier, "graceful");
  agent.completeTurn(0);
  await waitFor(() => orch.snapshot().counts.paused === 1);

  // Re-pausing an already-paused session is a safe no-op.
  assert.deepEqual(orch.pauseByIdentifier(issue.identifier, "graceful"), {
    ok: true,
    status: "Paused",
  });
  assert.equal(orch.snapshot().counts.paused, 1);

  orch.resumeByIdentifier(issue.identifier);
  await waitFor(() => agent.calls.length === 2);

  // Re-resuming an already-running session is a safe no-op.
  assert.deepEqual(orch.resumeByIdentifier(issue.identifier), {
    ok: true,
    status: "Running",
  });
  assert.equal(orch.snapshot().running.length, 1);

  await orch.stop();
});

test("resume returns no_slot when no concurrency slot is free", async () => {
  const tracker = new FakeTracker();
  const ws = new FakeWorkspace();
  const agent = new FakeAgent();
  const orch = new Orchestrator(
    makeWorkflow({
      agent: {
        max_concurrent_agents: 1,
        max_turns: 10,
        max_retry_backoff_ms: 60_000,
        max_concurrent_agents_by_state: {},
      },
    }),
    { tracker, workspaceManager: ws, runTurn: agent.runTurn },
  );

  const issueA = makeIssue({ id: "A", identifier: "test/repo#1", number: 1 });
  const issueB = makeIssue({ id: "B", identifier: "test/repo#2", number: 2 });
  tracker.statesById.set("A", issueA);
  tracker.statesById.set("B", issueB);

  // Dispatch A, then pause it — its slot is released.
  await dispatchAndAwaitTurn1(orch, tracker, agent, issueA);
  orch.pauseByIdentifier(issueA.identifier, "graceful");
  agent.completeTurn(0);
  await waitFor(() => orch.snapshot().counts.paused === 1);

  // Dispatch B into the single slot.
  tracker.candidates = [issueB];
  await orch.forceRefresh();
  await waitFor(() => orch.snapshot().running.length === 1, {
    label: "B occupies the slot",
  });

  // Resuming A now has nowhere to go — it stays paused.
  assert.deepEqual(orch.resumeByIdentifier(issueA.identifier), {
    error: "no_slot",
  });
  assert.equal(orch.snapshot().counts.paused, 1, "A remains paused");

  await orch.stop();
});

test("pause / resume on an unknown session report not_found", async () => {
  const orch = new Orchestrator(makeWorkflow(), {
    tracker: new FakeTracker(),
    workspaceManager: new FakeWorkspace(),
    runTurn: new FakeAgent().runTurn,
  });
  assert.deepEqual(orch.pauseByIdentifier("test/repo#999", "graceful"), {
    error: "not_found",
  });
  assert.deepEqual(orch.resumeByIdentifier("test/repo#999"), {
    error: "not_found",
  });
  await orch.stop();
});
