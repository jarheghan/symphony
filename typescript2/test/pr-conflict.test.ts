// PR merge-conflict awareness tests — exercises the orchestrator with injected
// fakes, plus a unit test for the directive builder and the config default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { setLogLevel } from "../src/logging/logger.js";
import {
  buildConflictDirective,
  CONFLICT_DIRECTIVE_MARKER,
} from "../src/prompt/render.js";
import { resolveServiceConfig } from "../src/workflow/config.js";
import {
  FakeAgent,
  FakeTracker,
  FakeWorkspace,
  makeIssue,
  makePr,
  makeWorkflow,
  waitFor,
} from "./helpers.js";

setLogLevel("error");

/** An issue with a real branch name → head ref `symphony/1-test-issue`. */
const ISSUE_BRANCH = "1-test-issue";
const HEAD_REF = `symphony/${ISSUE_BRANCH}`;
const hasDirective = (s: string) => s.includes(CONFLICT_DIRECTIVE_MARKER);

function setup() {
  const tracker = new FakeTracker();
  const ws = new FakeWorkspace();
  const agent = new FakeAgent();
  const orch = new Orchestrator(makeWorkflow(), {
    tracker,
    workspaceManager: ws,
    runTurn: agent.runTurn,
  });
  const issue = makeIssue({ branch_name: ISSUE_BRANCH });
  tracker.candidates = [issue];
  tracker.statesById.set(issue.id, issue);
  return { tracker, ws, agent, orch, issue };
}

test("a conflicting PR prepends the resolution directive to the first-turn prompt", async () => {
  const { tracker, agent, orch } = setup();
  tracker.prByHeadRef.set(
    HEAD_REF,
    makePr({ number: 42, base_ref_name: "main", head_ref_name: HEAD_REF }),
  );

  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1);

  const prompt = agent.calls[0].prompt;
  assert.ok(hasDirective(prompt), "directive marker present");
  assert.ok(prompt.includes("#42"), "names the PR number");
  assert.ok(prompt.includes(HEAD_REF), "names the PR head branch");
  assert.ok(prompt.includes("origin/main"), "names the base branch");
  // The directive comes first — before the rendered issue prompt.
  assert.ok(prompt.indexOf(CONFLICT_DIRECTIVE_MARKER) === 0, "directive is prepended");

  await orch.stop();
});

test("a mergeable PR adds no directive", async () => {
  const { tracker, agent, orch } = setup();
  tracker.prByHeadRef.set(HEAD_REF, makePr({ mergeable: "mergeable" }));

  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1);

  assert.ok(!hasDirective(agent.calls[0].prompt));
  await orch.stop();
});

test("no linked PR adds no directive", async () => {
  const { agent, orch } = setup(); // prByHeadRef left empty

  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1);

  assert.ok(!hasDirective(agent.calls[0].prompt));
  await orch.stop();
});

test("an UNKNOWN mergeable state adds no directive", async () => {
  const { tracker, agent, orch } = setup();
  tracker.prByHeadRef.set(HEAD_REF, makePr({ mergeable: "unknown" }));

  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1);

  assert.ok(!hasDirective(agent.calls[0].prompt));
  await orch.stop();
});

test("the directive is also injected on a continuation turn", async () => {
  const { tracker, agent, orch } = setup();
  tracker.prByHeadRef.set(HEAD_REF, makePr());

  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1);
  agent.completeTurn(0); // turn 1 done → turn 2 is a continuation (sessionId set)
  await waitFor(() => agent.calls.length === 2);

  assert.equal(agent.calls[1].resumeSessionId, "sess-1", "turn 2 is a continuation");
  assert.ok(hasDirective(agent.calls[1].prompt), "continuation prompt carries the directive");

  await orch.stop();
});

test("a conflict resolved mid-run drops the directive on the next turn", async () => {
  const { tracker, agent, orch } = setup();
  tracker.prByHeadRef.set(HEAD_REF, makePr({ mergeable: "conflicting" }));

  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1);
  assert.ok(hasDirective(agent.calls[0].prompt), "turn 1 sees the conflict");

  // Agent resolved it — the PR is mergeable by the time turn 2 builds its prompt.
  tracker.prByHeadRef.set(HEAD_REF, makePr({ mergeable: "mergeable" }));
  agent.completeTurn(0);
  await waitFor(() => agent.calls.length === 2);

  assert.ok(!hasDirective(agent.calls[1].prompt), "turn 2 no longer sees a conflict");
  await orch.stop();
});

test("a PR-fetch error does not fail the run — the turn still launches", async () => {
  const { tracker, agent, orch } = setup();
  tracker.prFetchError = new Error("graphql blew up");

  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1, { label: "turn launched despite PR-fetch error" });

  assert.ok(!hasDirective(agent.calls[0].prompt), "no directive when PR state is unknown");
  const snap = orch.snapshot();
  assert.equal(snap.running.length, 1, "the session is running, not failed");
  assert.notEqual(snap.running[0].status, "Failed");

  await orch.stop();
});

test("resume re-evaluates conflict state: a conflict that appears while paused is surfaced", async () => {
  const { tracker, agent, orch, issue } = setup();
  // No conflict initially.
  await orch.forceRefresh();
  await waitFor(() => agent.calls.length === 1);
  assert.ok(!hasDirective(agent.calls[0].prompt), "turn 1 has no conflict");

  // Pause after turn 1.
  orch.pauseByIdentifier(issue.identifier, "graceful");
  agent.completeTurn(0);
  await waitFor(() => orch.snapshot().counts.paused === 1);

  // A conflict develops while the session is paused.
  tracker.prByHeadRef.set(HEAD_REF, makePr());

  orch.resumeByIdentifier(issue.identifier);
  await waitFor(() => agent.calls.length === 2);

  assert.ok(hasDirective(agent.calls[1].prompt), "the resumed turn surfaces the new conflict");
  await orch.stop();
});

test("buildConflictDirective includes the PR number, url, and head/base refs", () => {
  const directive = buildConflictDirective(
    makePr({
      number: 99,
      url: "https://github.com/test/repo/pull/99",
      base_ref_name: "develop",
      head_ref_name: "symphony/9-thing",
    }),
  );
  assert.ok(directive.startsWith(CONFLICT_DIRECTIVE_MARKER));
  assert.ok(directive.includes("#99"));
  assert.ok(directive.includes("https://github.com/test/repo/pull/99"));
  assert.ok(directive.includes("symphony/9-thing"));
  assert.ok(directive.includes("develop"));
  assert.ok(directive.includes("git merge"));
  assert.ok(directive.includes("git rebase"));
});

test("branch_prefix config defaults to symphony/ and honors an override", () => {
  const dflt = resolveServiceConfig({}, "WORKFLOW.md");
  assert.equal(dflt.tracker.branch_prefix, "symphony/");

  const custom = resolveServiceConfig(
    { tracker: { branch_prefix: "feature/" } },
    "WORKFLOW.md",
  );
  assert.equal(custom.tracker.branch_prefix, "feature/");
});
