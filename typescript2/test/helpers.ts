// Test doubles and fixtures for the orchestrator pause/resume suite.
//
// The orchestrator accepts injectable collaborators (`OrchestratorDeps`); these
// fakes stand in for the GitHub tracker, the workspace manager, and the Claude
// Code turn runner so pause/resume can be exercised without network or
// subprocesses.

import os from "node:os";
import path from "node:path";
import type { TurnContext, TurnResult } from "../src/agent/claude.js";
import type {
  TrackerLike,
  WorkspaceManagerLike,
} from "../src/orchestrator/orchestrator.js";
import type {
  Issue,
  LinkedPullRequest,
  RateLimitSnapshot,
  ServiceConfig,
  Workspace,
  WorkflowDefinition,
} from "../src/types.js";

/** A minimal but valid workflow — passes `validateDispatchConfig`, no hooks. */
export function makeWorkflow(partial?: Partial<ServiceConfig>): WorkflowDefinition {
  const config: ServiceConfig = {
    tracker: {
      kind: "github",
      endpoint: "https://api.github.com",
      api_key: "test-token",
      repository: "test/repo",
      state_source: "labels",
      state_label_prefix: "status:",
      state_field: "Status",
      priority_source: "labels",
      priority_label_pattern: "^p(\\d)$",
      priority_field: "Priority",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Cancelled"],
      branch_prefix: "symphony/",
    },
    polling: { interval_ms: 600_000, use_etag: false },
    workspace: { root: path.join(os.tmpdir(), "symphony-test-ws") },
    hooks: { timeout_ms: 1000 },
    agent: {
      max_concurrent_agents: 4,
      max_turns: 10,
      max_retry_backoff_ms: 60_000,
      max_concurrent_agents_by_state: {},
    },
    claude: {
      command: "claude",
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 5000,
      stall_timeout_ms: 0, // disable stall detection in reconcile
    },
    ...partial,
  };
  return {
    config_raw: {},
    config,
    prompt_template: "Work on {{ issue.identifier }}: {{ issue.title }}",
    source_path: "TEST",
  };
}

export function makeIssue(over?: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "test/repo#1",
    number: 1,
    repository: "test/repo",
    title: "Test issue",
    description: "Body text",
    priority: 1,
    state: "Todo",
    github_state: "open",
    branch_name: null,
    url: "https://github.com/test/repo/issues/1",
    labels: [],
    assignees: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** A linked pull request fixture for conflict tests. */
export function makePr(over?: Partial<LinkedPullRequest>): LinkedPullRequest {
  return {
    number: 7,
    url: "https://github.com/test/repo/pull/7",
    mergeable: "conflicting",
    is_draft: false,
    base_ref_name: "main",
    head_ref_name: "symphony/1-test-issue",
    ...over,
  };
}

/** Programmable tracker: set `candidates` / `statesById` / `prByHeadRef` per test. */
export class FakeTracker implements TrackerLike {
  candidates: Issue[] = [];
  statesById = new Map<string, Issue>();
  byStates: Issue[] = [];
  prByHeadRef = new Map<string, LinkedPullRequest | null>();
  /** When set, `fetchOpenPullRequestForBranch` throws it (failure-isolation test). */
  prFetchError: Error | null = null;
  rate: RateLimitSnapshot = {};

  async fetchCandidateIssues() {
    return { issues: [...this.candidates], rate: this.rate };
  }
  async fetchIssueStatesByIds(ids: string[]) {
    const issues = ids
      .map((id) => this.statesById.get(id))
      .filter((x): x is Issue => !!x);
    return { issues, rate: this.rate };
  }
  async fetchIssuesByStates(_states: string[]) {
    return { issues: [...this.byStates], rate: this.rate };
  }
  async fetchOpenPullRequestForBranch(
    _repository: string,
    headRefName: string,
  ): Promise<LinkedPullRequest | null> {
    if (this.prFetchError) throw this.prFetchError;
    return this.prByHeadRef.get(headRefName) ?? null;
  }
}

/** Records workspace lifecycle calls; models `created_now` on first creation. */
export class FakeWorkspace implements WorkspaceManagerLike {
  created: string[] = [];
  removed: string[] = [];
  removedPaths: string[] = [];
  private existing = new Set<string>();

  async createForIssue(identifier: string): Promise<Workspace> {
    const created_now = !this.existing.has(identifier);
    this.existing.add(identifier);
    this.created.push(identifier);
    return {
      path: `/fake/ws/${identifier.replace(/[^\w]/g, "_")}`,
      workspace_key: identifier,
      created_now,
    };
  }
  async removeForIssue(identifier: string) {
    this.removed.push(identifier);
    this.existing.delete(identifier);
  }
  async removeWorkspacePath(workspacePath: string) {
    this.removedPaths.push(workspacePath);
  }
}

/**
 * Fake turn runner. Each `runTurn` call parks until the test resolves it via
 * `completeTurn`; if the turn carries a cancel signal, an abort resolves it
 * immediately with a cancelled result — modelling a subprocess dying fast.
 */
export class FakeAgent {
  calls: TurnContext[] = [];
  sessionId: string | null = "sess-1";
  private resolvers: Array<(r: TurnResult) => void> = [];

  runTurn = (ctx: TurnContext): Promise<TurnResult> => {
    this.calls.push(ctx);
    return new Promise<TurnResult>((resolve) => {
      this.resolvers.push(resolve);
      if (ctx.cancelSignal) {
        const onAbort = () =>
          resolve({
            ok: false,
            session_id: this.sessionId,
            error: "turn_cancelled",
            exit_code: null,
            duration_ms: 1,
          });
        if (ctx.cancelSignal.aborted) onAbort();
        else ctx.cancelSignal.addEventListener("abort", onAbort);
      }
    });
  };

  /** Resolve the turn at `index` as a successful completion. */
  completeTurn(index: number, result: Partial<TurnResult> = {}): void {
    const resolve = this.resolvers[index];
    if (!resolve) throw new Error(`no in-flight turn at index ${index}`);
    resolve({
      ok: true,
      session_id: this.sessionId,
      exit_code: 0,
      duration_ms: 5,
      result_subtype: "success",
      ...result,
    });
  }
}

/** Poll `predicate` until true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeout?: number; label?: string } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 2000;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out${opts.label ? `: ${opts.label}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
