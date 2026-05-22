// Orchestrator (Sections 7, 8, 14, 16).
//
// Single authority for scheduling state. Owns the poll tick, dispatch decisions,
// retry queue, reconciliation, and run-attempt lifecycle.

import { EventEmitter } from "node:events";
import { log } from "../logging/logger.js";
import type {
  ClaudeTotals,
  Issue,
  PausedEntry,
  RateLimitSnapshot,
  RetryEntry,
  RunningEntry,
  RuntimeEvent,
  ServiceConfig,
  WorkflowDefinition,
} from "../types.js";
import { GitHubTracker, TrackerError } from "../tracker/github.js";
import { WorkspaceManager, hookEnv, runHook, runHookBestEffort } from "../workspace/manager.js";
import { runTurn, validateAddDirs } from "../agent/claude.js";
import { buildContinuationPrompt, renderPrompt, PromptError } from "../prompt/render.js";
import { validateDispatchConfig } from "../workflow/config.js";

interface RunningInternal extends RunningEntry {
  workerAbort: AbortController;
  workerPromise: Promise<void>;
  // Mid-turn advisory totals from `assistant` events — folded into authoritative
  // totals when the `result` event arrives, then reset.
  advisory_input_tokens: number;
  advisory_output_tokens: number;
  advisory_cache_creation_input_tokens: number;
  advisory_cache_read_input_tokens: number;
  // Pause control. `graceful` is checked at turn boundaries; `immediate` aborts
  // the worker with reason "pause". `pauseStartTurn` records the turn a resumed
  // run should re-enter the per-turn loop at.
  pauseIntent: "graceful" | "immediate" | null;
  pauseStartTurn: number | null;
}

export class Orchestrator extends EventEmitter {
  // Authoritative in-memory state (Section 4.1.8)
  private running = new Map<string, RunningInternal>();
  // Interrupted sessions held for later resume (Section: Pause / Resume).
  // A paused issue stays in `claimed` so the poll loop won't re-dispatch it,
  // but holds no worker, no retry timer, and no concurrency slot.
  private paused = new Map<string, PausedEntry>();
  private claimed = new Set<string>();
  private retry_attempts = new Map<string, RetryEntry & { timer: NodeJS.Timeout | null }>();
  private completed = new Set<string>();
  private claude_totals: ClaudeTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
    total_cost_usd: 0,
  };
  private claude_rate_limits: RateLimitSnapshot | null = null;
  private tracker_rate_limits: RateLimitSnapshot | null = null;

  private workflow: WorkflowDefinition;
  private tracker: GitHubTracker;
  private workspaceManager: WorkspaceManager;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private effectivePollIntervalMs: number;
  private rateLimitBackoffUntilMs = 0;
  private startedAt = new Date().toISOString();

  constructor(workflow: WorkflowDefinition) {
    super();
    this.workflow = workflow;
    this.tracker = new GitHubTracker(workflow.config.tracker);
    this.workspaceManager = new WorkspaceManager(workflow.config.workspace.root);
    this.effectivePollIntervalMs = workflow.config.polling.interval_ms;
  }

  cfg(): ServiceConfig {
    return this.workflow.config;
  }

  /** Apply a hot-reloaded workflow without restarting in-flight runs. */
  applyWorkflow(workflow: WorkflowDefinition): void {
    const prevTrackerKey = trackerSignature(this.workflow.config.tracker);
    const nextTrackerKey = trackerSignature(workflow.config.tracker);
    this.workflow = workflow;
    if (prevTrackerKey !== nextTrackerKey) {
      try {
        this.tracker = new GitHubTracker(workflow.config.tracker);
      } catch (e: any) {
        log.error("tracker reload failed; keeping previous", { error: e.message });
      }
    }
    if (this.workspaceManager["root"] !== workflow.config.workspace.root) {
      this.workspaceManager = new WorkspaceManager(workflow.config.workspace.root);
    }
    this.effectivePollIntervalMs = workflow.config.polling.interval_ms;
    log.info("workflow reload applied", { source: workflow.source_path });
    this.emit("snapshot", this.snapshot());
  }

  async start(): Promise<void> {
    // Validate config; surface but do not crash
    const v = validateDispatchConfig(this.cfg());
    if (!v.ok) {
      for (const err of v.errors) log.error("startup validation failed", { error: err });
    }
    // Startup terminal cleanup (Section 8.6) — best effort
    void this.startupTerminalCleanup();
    this.scheduleTick(0);
    log.info("orchestrator started", {
      poll_interval_ms: this.effectivePollIntervalMs,
      max_concurrent_agents: this.cfg().agent.max_concurrent_agents,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const r of Array.from(this.running.values())) {
      r.workerAbort.abort("orchestrator_stop");
    }
    for (const r of this.retry_attempts.values()) {
      if (r.timer) clearTimeout(r.timer);
    }
    await Promise.all(
      Array.from(this.running.values()).map((r) => r.workerPromise.catch(() => {})),
    );
    log.info("orchestrator stopped");
  }

  private scheduleTick(delayMs: number) {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    const now = Date.now();
    const waitForRateLimit = Math.max(0, this.rateLimitBackoffUntilMs - now);
    this.tickTimer = setTimeout(() => void this.tick(), Math.max(delayMs, waitForRateLimit));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.reconcileRunning();
      const v = validateDispatchConfig(this.cfg());
      if (!v.ok) {
        log.warn("dispatch validation failed", { errors: v.errors.join(",") });
        return;
      }
      try {
        const { issues, rate } = await this.tracker.fetchCandidateIssues();
        this.tracker_rate_limits = rate;
        log.debug("poll_tick_candidates", {
          count: issues.length,
          identifiers: issues.slice(0, 10).map((i) => i.identifier).join(","),
        });
        if (issues.length === 0) {
          log.info("poll_tick_no_candidates", {
            repository: this.cfg().tracker.repository ?? null,
            project_id: this.cfg().tracker.project_id ?? null,
            active_states: this.cfg().tracker.active_states.join("|"),
            include_labels: this.cfg().tracker.label_filters?.include?.join("|") ?? null,
            assignee_filter: this.cfg().tracker.assignee_filter?.join("|") ?? null,
          });
        }
        for (const issue of this.sortForDispatch(issues)) {
          if (!this.hasGlobalSlot()) break;
          await this.maybeDispatch(issue, null);
        }
      } catch (e: any) {
        this.handleTrackerError(e, "candidate_fetch");
      }
    } finally {
      this.emit("snapshot", this.snapshot());
      this.scheduleTick(this.effectivePollIntervalMs);
    }
  }

  private async reconcileRunning(): Promise<void> {
    // Stall detection
    const stallMs = this.cfg().claude.stall_timeout_ms;
    if (stallMs > 0) {
      const now = Date.now();
      for (const entry of Array.from(this.running.values())) {
        const last = entry.last_event_timestamp
          ? Date.parse(entry.last_event_timestamp)
          : Date.parse(entry.started_at);
        if (now - last > stallMs) {
          log.warn("stall_detected", {
            issue_id: entry.issue_id,
            issue_identifier: entry.identifier,
            elapsed_ms: now - last,
            session_id: entry.session_id,
          });
          entry.workerAbort.abort("stalled");
        }
      }
    }
    // Tracker state refresh — covers both running and paused issues.
    const runningIds = Array.from(this.running.keys());
    const pausedIds = Array.from(this.paused.keys());
    const ids = [...runningIds, ...pausedIds];
    if (ids.length === 0) return;
    let refreshed;
    try {
      const res = await this.tracker.fetchIssueStatesByIds(ids);
      this.tracker_rate_limits = res.rate;
      refreshed = res.issues;
    } catch (e: any) {
      this.handleTrackerError(e, "running_state_refresh");
      return;
    }
    const byId = new Map(refreshed.map((i) => [i.id, i]));
    const cfg = this.cfg();
    const termLower = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
    const activeLower = new Set(cfg.tracker.active_states.map((s) => s.toLowerCase()));
    for (const id of runningIds) {
      const refreshedIssue = byId.get(id);
      const runEntry = this.running.get(id);
      if (!runEntry) continue;
      if (!refreshedIssue) continue; // missing — keep running for now
      const stateLower = (refreshedIssue.state || "").toLowerCase();
      if (refreshedIssue.github_state === "closed" || termLower.has(stateLower)) {
        log.info("reconcile_terminate_with_cleanup", {
          issue_id: id,
          issue_identifier: refreshedIssue.identifier,
          state: refreshedIssue.state,
        });
        runEntry.workerAbort.abort("terminal");
        // cleanup workspace after worker exits
        runEntry.workerPromise.finally(async () => {
          try {
            await this.workspaceManager.removeForIssue(refreshedIssue.identifier, cfg.hooks);
          } catch {}
        });
      } else if (activeLower.has(stateLower)) {
        runEntry.issue = refreshedIssue;
      } else {
        log.info("reconcile_terminate_no_cleanup", {
          issue_id: id,
          state: refreshedIssue.state,
        });
        runEntry.workerAbort.abort("non_active");
      }
    }
    // Paused sweep: a paused issue that went terminal / closed is discarded and
    // its workspace cleaned; one that went non-active is discarded without
    // cleanup. An issue that vanished is left paused.
    for (const id of pausedIds) {
      const refreshedIssue = byId.get(id);
      const pausedEntry = this.paused.get(id);
      if (!pausedEntry) continue;
      if (!refreshedIssue) continue; // missing — keep paused for now
      const stateLower = (refreshedIssue.state || "").toLowerCase();
      if (refreshedIssue.github_state === "closed" || termLower.has(stateLower)) {
        log.info("reconcile_discard_paused_with_cleanup", {
          issue_id: id,
          issue_identifier: refreshedIssue.identifier,
          state: refreshedIssue.state,
        });
        this.paused.delete(id);
        this.claimed.delete(id);
        this.workspaceManager
          .removeForIssue(refreshedIssue.identifier, cfg.hooks)
          .catch(() => {});
      } else if (activeLower.has(stateLower)) {
        pausedEntry.issue = refreshedIssue;
      } else {
        log.info("reconcile_discard_paused_no_cleanup", {
          issue_id: id,
          state: refreshedIssue.state,
        });
        this.paused.delete(id);
        this.claimed.delete(id);
      }
    }
  }

  private async startupTerminalCleanup(): Promise<void> {
    try {
      const states = this.cfg().tracker.terminal_states;
      const { issues } = await this.tracker.fetchIssuesByStates(states);
      for (const i of issues) {
        try {
          await this.workspaceManager.removeForIssue(i.identifier, this.cfg().hooks);
        } catch {}
      }
    } catch (e: any) {
      log.warn("startup terminal cleanup failed", { error: e.message });
    }
  }

  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const ap = a.priority ?? Number.POSITIVE_INFINITY;
      const bp = b.priority ?? Number.POSITIVE_INFINITY;
      if (ap !== bp) return ap - bp;
      const ad = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
      const bd = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return a.identifier.localeCompare(b.identifier);
    });
  }

  private hasGlobalSlot(): boolean {
    return this.running.size < this.cfg().agent.max_concurrent_agents;
  }

  private hasStateSlot(state: string): boolean {
    const m = this.cfg().agent.max_concurrent_agents_by_state[state.toLowerCase()];
    if (m == null) return true;
    let inState = 0;
    for (const r of this.running.values()) {
      if ((r.issue.state || "").toLowerCase() === state.toLowerCase()) inState++;
    }
    return inState < m;
  }

  private async maybeDispatch(issue: Issue, attempt: number | null): Promise<void> {
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return;
    if (!this.hasGlobalSlot() || !this.hasStateSlot(issue.state)) return;
    if (!issue.id || !issue.identifier || !issue.title || !issue.state || !issue.repository) {
      return;
    }
    if (issue.github_state !== "open") return;

    const cfg = this.cfg();
    const activeLower = cfg.tracker.active_states.map((s) => s.toLowerCase());
    const stateLower = issue.state.toLowerCase();
    if (!activeLower.includes(stateLower)) return;

    // Blocker rule for first active state
    if (activeLower[0] === stateLower) {
      const cfgTerm = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
      const nonTerminalBlocker = (issue.blocked_by || []).some(
        (b) => !b.state || !cfgTerm.has((b.state || "").toLowerCase()),
      );
      if (issue.blocked_by && issue.blocked_by.length > 0 && nonTerminalBlocker) {
        log.debug("blocked_by_blocker; skip", { issue_identifier: issue.identifier });
        return;
      }
    }

    // add_dir safety
    const errs = validateAddDirs(cfg.claude.add_dir, cfg.workspace.root);
    if (errs.length) {
      log.error("claude.add_dir invalid; aborting dispatch", { errors: errs.join(";") });
      return;
    }

    await this.dispatch(issue, attempt);
  }

  private async dispatch(issue: Issue, attempt: number | null): Promise<void> {
    this.claimed.add(issue.id);
    // Remove from retry queue if present
    const retry = this.retry_attempts.get(issue.id);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retry_attempts.delete(issue.id);

    const abort = new AbortController();
    const entry: RunningInternal = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      workspace_path: "",
      status: "PreparingWorkspace",
      retry_attempt: attempt,
      started_at: new Date().toISOString(),
      session_id: null,
      thread_id: null,
      turn_id: null,
      claude_pid: null,
      last_event: null,
      last_event_timestamp: null,
      last_message: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
      total_cost_usd: 0,
      events: [],
      workerAbort: abort,
      workerPromise: Promise.resolve(),
      advisory_input_tokens: 0,
      advisory_output_tokens: 0,
      advisory_cache_creation_input_tokens: 0,
      advisory_cache_read_input_tokens: 0,
      pauseIntent: null,
      pauseStartTurn: null,
    };
    this.running.set(issue.id, entry);
    log.info("dispatch_started", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      repository: issue.repository,
      attempt,
    });
    this.emit("snapshot", this.snapshot());

    entry.workerPromise = this.runAttempt(entry, attempt)
      .catch((e: any) => {
        log.error("worker_unhandled", { error: e?.message, issue_id: issue.id });
      })
      .finally(() => {
        this.afterWorkerExit(entry);
      });
  }

  /**
   * Re-enter the per-turn loop for a paused session. Reuses the preserved
   * workspace and `--resume <session_id>` continuity; seeds token / cost
   * counters and the start turn from the paused snapshot. The issue is already
   * in `claimed` (it stayed claimed through the pause).
   */
  private dispatchResume(paused: PausedEntry): void {
    const retry = this.retry_attempts.get(paused.issue_id);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retry_attempts.delete(paused.issue_id);
    this.claimed.add(paused.issue_id);

    const abort = new AbortController();
    const entry: RunningInternal = {
      issue_id: paused.issue_id,
      identifier: paused.identifier,
      issue: paused.issue,
      workspace_path: paused.workspace_path,
      status: "PreparingWorkspace",
      retry_attempt: paused.retry_attempt,
      started_at: new Date().toISOString(),
      session_id: paused.session_id,
      thread_id: paused.session_id,
      turn_id: paused.session_id ? `${paused.session_id}-${paused.resume_start_turn}` : null,
      claude_pid: null,
      last_event: null,
      last_event_timestamp: null,
      last_message: null,
      input_tokens: paused.input_tokens,
      output_tokens: paused.output_tokens,
      cache_creation_input_tokens: paused.cache_creation_input_tokens,
      cache_read_input_tokens: paused.cache_read_input_tokens,
      total_tokens: paused.total_tokens,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: paused.turn_count,
      total_cost_usd: paused.total_cost_usd,
      events: paused.events.slice(),
      workerAbort: abort,
      workerPromise: Promise.resolve(),
      advisory_input_tokens: 0,
      advisory_output_tokens: 0,
      advisory_cache_creation_input_tokens: 0,
      advisory_cache_read_input_tokens: 0,
      pauseIntent: null,
      pauseStartTurn: null,
    };
    this.running.set(paused.issue_id, entry);
    log.info("session_resumed", {
      issue_id: paused.issue_id,
      issue_identifier: paused.identifier,
      session_id: paused.session_id,
      start_turn: paused.resume_start_turn,
    });
    this.emit("agent_event", {
      issue_id: paused.issue_id,
      event: {
        event: "session_resumed",
        timestamp: new Date().toISOString(),
        payload: { session_id: paused.session_id, start_turn: paused.resume_start_turn },
      },
    });
    this.emit("snapshot", this.snapshot());

    entry.workerPromise = this.runAttempt(entry, paused.retry_attempt, {
      sessionId: paused.session_id,
      startTurn: paused.resume_start_turn,
    })
      .catch((e: any) => {
        log.error("worker_unhandled", { error: e?.message, issue_id: paused.issue_id });
      })
      .finally(() => {
        this.afterWorkerExit(entry);
      });
  }

  /**
   * Pause a running session. `graceful` finishes the in-flight turn then stops
   * before the next; `interrupt` kills the `claude` subprocess immediately.
   * Idempotent: re-pausing a session that is already pausing / paused is a
   * no-op. Returns `{ ok, status }` or `{ error }`.
   */
  pauseByIdentifier(
    identifier: string,
    mode: "graceful" | "interrupt",
  ): { ok: true; status: string } | { error: string } {
    const entry = this.findRunningByIdentifier(identifier);
    if (!entry) {
      for (const p of this.paused.values()) {
        if (p.identifier === identifier) return { ok: true, status: "Paused" };
      }
      return { error: "not_found" };
    }
    if (mode === "interrupt") {
      entry.pauseIntent = "immediate";
      if (!entry.workerAbort.signal.aborted) entry.workerAbort.abort("pause");
    } else {
      // Don't downgrade an already-requested immediate pause.
      if (entry.pauseIntent !== "immediate") entry.pauseIntent = "graceful";
    }
    log.info("pause_requested", {
      issue_id: entry.issue_id,
      issue_identifier: identifier,
      mode,
    });
    this.emit("snapshot", this.snapshot());
    return { ok: true, status: "Pausing" };
  }

  /**
   * Resume a paused session. Fails with `no_slot` if no global / per-state
   * concurrency slot is free (the session stays paused). Idempotent for a
   * session that is already running. Returns `{ ok, status }` or `{ error }`.
   */
  resumeByIdentifier(
    identifier: string,
  ): { ok: true; status: string } | { error: string } {
    let issueId: string | null = null;
    for (const [id, p] of this.paused) {
      if (p.identifier === identifier) {
        issueId = id;
        break;
      }
    }
    if (!issueId) {
      if (this.findRunningByIdentifier(identifier)) return { ok: true, status: "Running" };
      return { error: "not_found" };
    }
    const paused = this.paused.get(issueId)!;
    if (!this.hasGlobalSlot() || !this.hasStateSlot(paused.issue.state)) {
      return { error: "no_slot" };
    }
    this.paused.delete(issueId);
    this.dispatchResume(paused);
    return { ok: true, status: "Running" };
  }

  /**
   * Whether a graceful pause has been requested for a running entry. Wrapped in
   * a method so the read isn't subject to control-flow narrowing inside the
   * per-turn loop — `pauseIntent` is mutated asynchronously by `pauseByIdentifier`.
   */
  private gracefulPauseRequested(entry: RunningInternal): boolean {
    return entry.pauseIntent === "graceful";
  }

  private async runAttempt(
    entry: RunningInternal,
    attempt: number | null,
    resume?: { sessionId: string | null; startTurn: number },
  ): Promise<void> {
    const cfg = this.cfg();
    let workerExitReason: "normal" | "paused" | { error: string } = "normal";
    let workspaceAvailableForAfterRun = false;
    try {
      // Workspace creation
      entry.status = "PreparingWorkspace";
      const ws = await this.workspaceManager.createForIssue(entry.identifier);
      entry.workspace_path = ws.path;
      workspaceAvailableForAfterRun = true;
      const env = hookEnv(entry.issue, ws.path, attempt);

      if (ws.created_now && cfg.hooks.after_create) {
        const r = await runHook(
          "after_create",
          cfg.hooks.after_create,
          ws.path,
          env,
          cfg.hooks.timeout_ms,
        );
        if (!r.ok) {
          await this.workspaceManager.removeWorkspacePath(ws.path);
          workspaceAvailableForAfterRun = false;
          workerExitReason = { error: `after_create hook failed: ${r.error}` };
          return;
        }
      }
      // On resume, `before_run` is skipped: re-running it (typically a
      // `git checkout -B …`) would clobber the branch state the paused session
      // left in progress. The original `before_run` ran at first dispatch.
      if (!resume && cfg.hooks.before_run) {
        const r = await runHook(
          "before_run",
          cfg.hooks.before_run,
          ws.path,
          env,
          cfg.hooks.timeout_ms,
        );
        if (!r.ok) {
          workerExitReason = { error: `before_run hook failed: ${r.error}` };
          return;
        }
      }

      // Per-turn loop
      let turnNumber = resume ? resume.startTurn : 1;
      let sessionId: string | null = resume ? resume.sessionId : null;
      const maxTurns = cfg.agent.max_turns;
      while (true) {
        // Graceful pause requested — stop cleanly at this turn boundary before
        // launching the next turn.
        if (this.gracefulPauseRequested(entry)) {
          entry.pauseStartTurn = turnNumber;
          workerExitReason = "paused";
          return;
        }
        if (entry.workerAbort.signal.aborted) {
          // An interrupt-mode pause aborts the worker with reason "pause";
          // treat that as a pause, not a failure.
          if (entry.workerAbort.signal.reason === "pause") {
            entry.pauseStartTurn = turnNumber;
            workerExitReason = "paused";
          } else {
            workerExitReason = { error: `cancelled: ${entry.workerAbort.signal.reason}` };
          }
          return;
        }
        entry.status = "BuildingPrompt";
        entry.turn_count = turnNumber;
        let prompt: string;
        try {
          prompt =
            sessionId == null
              ? await renderPrompt(this.workflow.prompt_template, {
                  issue: entry.issue,
                  attempt,
                })
              : buildContinuationPrompt(cfg.claude.continuation_prompt, entry.issue, attempt);
        } catch (e: any) {
          if (e instanceof PromptError) {
            workerExitReason = { error: `${e.code}: ${e.message}` };
            return;
          }
          throw e;
        }
        entry.status = "LaunchingClaude";

        const result = await runTurn({
          cwd: entry.workspace_path,
          prompt,
          resumeSessionId: sessionId,
          turnNumber,
          config: cfg.claude,
          cancelSignal: entry.workerAbort.signal,
          onEvent: (e) => this.absorbAgentEvent(entry, e),
        });
        entry.status = "StreamingTurn";
        if (result.session_id) {
          sessionId = result.session_id;
          entry.session_id = sessionId;
          entry.thread_id = sessionId;
          entry.turn_id = `${sessionId}-${turnNumber}`;
        }
        // Apply usage deltas (per-turn result.usage = per-turn delta per spec 13.5)
        if (result.usage) {
          this.accumulateUsage(entry, result.usage);
        }
        if (!result.ok) {
          // Interrupt-mode pause kills the subprocess mid-turn. The partial
          // turn's work is discarded; a resume re-runs this turn from the last
          // commit recovered via `--resume`.
          if (entry.workerAbort.signal.aborted && entry.workerAbort.signal.reason === "pause") {
            entry.pauseStartTurn = turnNumber;
            workerExitReason = "paused";
            return;
          }
          workerExitReason = { error: result.error || result.result_subtype || "turn_failed" };
          return;
        }

        // After successful turn: refresh issue state, possibly continue
        try {
          const { issues: refreshed } = await this.tracker.fetchIssueStatesByIds([
            entry.issue_id,
          ]);
          if (refreshed.length === 0) {
            return; // issue vanished; exit normally
          }
          entry.issue = refreshed[0];
          const stateLower = (entry.issue.state || "").toLowerCase();
          const term = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
          const active = new Set(cfg.tracker.active_states.map((s) => s.toLowerCase()));
          if (entry.issue.github_state === "closed" || term.has(stateLower)) return;
          if (!active.has(stateLower)) return;
        } catch (e: any) {
          workerExitReason = { error: `issue_state_refresh: ${e.message}` };
          return;
        }
        // `max_turns` completion wins over a pause at the same boundary — the
        // session is effectively done.
        if (turnNumber >= maxTurns) return;
        // Graceful pause requested — the just-completed turn is committed;
        // resume continues from the next turn.
        if (this.gracefulPauseRequested(entry)) {
          entry.pauseStartTurn = turnNumber + 1;
          workerExitReason = "paused";
          return;
        }
        turnNumber++;
      }
    } catch (e: any) {
      workerExitReason = { error: e?.message || "worker exception" };
    } finally {
      const paused = workerExitReason === "paused";
      // after_run hook best effort. Skipped on pause: it is the symmetric
      // counterpart of the `before_run` skipped on resume, so a paused/resumed
      // run still gets exactly one before_run / after_run pair.
      if (
        !paused &&
        workspaceAvailableForAfterRun &&
        entry.workspace_path &&
        this.cfg().hooks.after_run
      ) {
        await runHookBestEffort(
          "after_run",
          this.cfg().hooks.after_run as string,
          entry.workspace_path,
          hookEnv(entry.issue, entry.workspace_path, attempt),
          this.cfg().hooks.timeout_ms,
        );
      }
      if (workerExitReason === "normal") {
        entry.status = "Succeeded";
      } else if (workerExitReason === "paused") {
        entry.status = "Paused";
      } else {
        entry.status = "Failed";
        entry.error = workerExitReason.error;
      }
    }
  }

  private absorbAgentEvent(entry: RunningInternal, event: RuntimeEvent): void {
    entry.last_event = event.event;
    entry.last_event_timestamp = event.timestamp;
    // Advance status as events arrive so the UI reflects reality.
    switch (event.event) {
      case "session_started":
        entry.status = "StreamingTurn";
        // session_started carries the session_id in the payload; capture it
        // immediately so the UI doesn't show null until the turn completes.
        if (event.payload?.session_id && !entry.session_id) {
          entry.session_id = event.payload.session_id;
          entry.thread_id = event.payload.session_id;
          entry.turn_id = `${event.payload.session_id}-${entry.turn_count || 1}`;
        }
        break;
      case "startup_failed":
        entry.status = "Failed";
        break;
      case "turn_completed":
        entry.status = "Finishing";
        break;
      case "turn_failed":
      case "turn_ended_with_error":
        entry.status = "Failed";
        break;
      case "turn_cancelled":
        entry.status = "CanceledByReconciliation";
        break;
      case "turn_paused":
        entry.status = "Paused";
        break;
    }
    if (event.payload) {
      if (event.event === "assistant_text") {
        entry.last_message = String(event.payload.text || "").slice(0, 240);
      } else if (event.event === "tool_use") {
        entry.last_message = `tool:${event.payload.name}`;
      } else if (event.event === "tool_result") {
        entry.last_message = `tool_result:${event.payload.ok ? "ok" : "error"}`;
      } else if (event.event === "session_started") {
        entry.last_message = `session ${event.payload.session_id?.slice(0, 8)} model ${event.payload.model}`;
      } else {
        entry.last_message = event.event;
      }
    }
    if (event.claude_pid) entry.claude_pid = event.claude_pid;
    if (event.usage) {
      this.accumulateUsageAdvisory(entry, event.usage);
    }
    // Cap stored events per session
    entry.events.push(event);
    if (entry.events.length > 200) entry.events.splice(0, entry.events.length - 200);
    this.emit("agent_event", { issue_id: entry.issue_id, event });
  }

  private accumulateUsage(entry: RunningInternal, u: NonNullable<RuntimeEvent["usage"]>) {
    const i = u.input_tokens ?? 0;
    const o = u.output_tokens ?? 0;
    const cc = u.cache_creation_input_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0;
    const cost = u.total_cost_usd ?? 0;
    entry.input_tokens += i;
    entry.output_tokens += o;
    entry.cache_creation_input_tokens += cc;
    entry.cache_read_input_tokens += cr;
    entry.total_tokens = entry.input_tokens + entry.output_tokens;
    entry.total_cost_usd += cost;
    entry.last_reported_input_tokens = i;
    entry.last_reported_output_tokens = o;
    entry.last_reported_total_tokens = i + o;
    // Authoritative result has arrived — the advisory for this turn is folded in.
    entry.advisory_input_tokens = 0;
    entry.advisory_output_tokens = 0;
    entry.advisory_cache_creation_input_tokens = 0;
    entry.advisory_cache_read_input_tokens = 0;
    this.claude_totals.input_tokens += i;
    this.claude_totals.output_tokens += o;
    this.claude_totals.cache_creation_input_tokens += cc;
    this.claude_totals.cache_read_input_tokens += cr;
    this.claude_totals.total_tokens =
      this.claude_totals.input_tokens + this.claude_totals.output_tokens;
    this.claude_totals.total_cost_usd += cost;
  }

  // Advisory usage from `assistant` messages reports cumulative tokens within the
  // current turn. Use max() so we never go backwards if events arrive out of order;
  // these values are reset to 0 when the authoritative `result` lands.
  private accumulateUsageAdvisory(
    entry: RunningInternal,
    u: NonNullable<RuntimeEvent["usage"]>,
  ) {
    entry.advisory_input_tokens = Math.max(entry.advisory_input_tokens, u.input_tokens ?? 0);
    entry.advisory_output_tokens = Math.max(entry.advisory_output_tokens, u.output_tokens ?? 0);
    entry.advisory_cache_creation_input_tokens = Math.max(
      entry.advisory_cache_creation_input_tokens,
      u.cache_creation_input_tokens ?? 0,
    );
    entry.advisory_cache_read_input_tokens = Math.max(
      entry.advisory_cache_read_input_tokens,
      u.cache_read_input_tokens ?? 0,
    );
  }

  private afterWorkerExit(entry: RunningInternal): void {
    const wasRunning = this.running.delete(entry.issue_id);
    if (!wasRunning) {
      this.claimed.delete(entry.issue_id);
      return;
    }
    const runtimeSec = (Date.now() - Date.parse(entry.started_at)) / 1000;
    this.claude_totals.seconds_running += runtimeSec;
    const cfg = this.cfg();

    // Paused: hold a resume snapshot, keep the issue claimed (so the poll loop
    // won't re-dispatch it), schedule no retry, and leave the workspace intact.
    if (entry.status === "Paused") {
      const pausedReason = entry.pauseIntent === "immediate" ? "interrupt" : "graceful";
      const pausedEntry: PausedEntry = {
        issue_id: entry.issue_id,
        identifier: entry.identifier,
        issue: entry.issue,
        session_id: entry.session_id,
        workspace_path: entry.workspace_path,
        resume_start_turn: entry.pauseStartTurn ?? Math.max(1, entry.turn_count),
        turn_count: entry.turn_count,
        retry_attempt: entry.retry_attempt,
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_input_tokens,
        cache_read_input_tokens: entry.cache_read_input_tokens,
        total_tokens: entry.total_tokens,
        total_cost_usd: entry.total_cost_usd,
        events: entry.events.slice(),
        started_at: entry.started_at,
        paused_at: new Date().toISOString(),
        paused_reason: pausedReason,
      };
      this.paused.set(entry.issue_id, pausedEntry);
      log.info("session_paused", {
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        session_id: entry.session_id,
        reason: pausedReason,
        resume_start_turn: pausedEntry.resume_start_turn,
        runtime_seconds: runtimeSec.toFixed(1),
      });
      this.emit("agent_event", {
        issue_id: entry.issue_id,
        event: {
          event: "session_paused",
          timestamp: pausedEntry.paused_at,
          payload: { reason: pausedReason, resume_start_turn: pausedEntry.resume_start_turn },
        },
      });
      this.emit("snapshot", this.snapshot());
      return;
    }

    this.claimed.delete(entry.issue_id);
    if (entry.status === "Succeeded") {
      this.completed.add(entry.issue_id);
      // Continuation retry after ~1s
      this.scheduleRetry(entry.issue_id, entry.identifier, 1, 1000, null);
    } else {
      const attempt = nextAttempt(entry.retry_attempt);
      const delay = Math.min(10000 * Math.pow(2, attempt - 1), cfg.agent.max_retry_backoff_ms);
      this.scheduleRetry(
        entry.issue_id,
        entry.identifier,
        attempt,
        delay,
        entry.error || "worker_exit",
      );
    }
    log.info("worker_exited", {
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      status: entry.status,
      runtime_seconds: runtimeSec.toFixed(1),
      session_id: entry.session_id,
      total_cost_usd: entry.total_cost_usd.toFixed(4),
    });
    this.emit("snapshot", this.snapshot());
  }

  private scheduleRetry(
    issue_id: string,
    identifier: string,
    attempt: number,
    delay_ms: number,
    error: string | null,
  ): void {
    const existing = this.retry_attempts.get(issue_id);
    if (existing?.timer) clearTimeout(existing.timer);
    const due_at_ms = Date.now() + delay_ms;
    const entry: RetryEntry & { timer: NodeJS.Timeout | null } = {
      issue_id,
      identifier,
      attempt,
      due_at_ms,
      due_at: new Date(due_at_ms).toISOString(),
      error,
      timer: null,
    };
    this.claimed.add(issue_id);
    entry.timer = setTimeout(() => void this.onRetryTimer(issue_id), delay_ms);
    this.retry_attempts.set(issue_id, entry);
  }

  private async onRetryTimer(issue_id: string): Promise<void> {
    const entry = this.retry_attempts.get(issue_id);
    if (!entry) return;
    this.retry_attempts.delete(issue_id);
    let candidates;
    try {
      const r = await this.tracker.fetchCandidateIssues();
      this.tracker_rate_limits = r.rate;
      candidates = r.issues;
    } catch (e: any) {
      this.handleTrackerError(e, "retry_poll");
      this.scheduleRetry(
        issue_id,
        entry.identifier,
        entry.attempt + 1,
        Math.min(10000 * Math.pow(2, entry.attempt), this.cfg().agent.max_retry_backoff_ms),
        "retry poll failed",
      );
      return;
    }
    const issue = candidates.find((i) => i.id === issue_id);
    if (!issue) {
      this.claimed.delete(issue_id);
      return;
    }
    if (!this.hasGlobalSlot() || !this.hasStateSlot(issue.state)) {
      this.scheduleRetry(
        issue_id,
        issue.identifier,
        entry.attempt + 1,
        Math.min(10000 * Math.pow(2, entry.attempt), this.cfg().agent.max_retry_backoff_ms),
        "no available orchestrator slots",
      );
      return;
    }
    await this.dispatch(issue, entry.attempt);
  }

  private handleTrackerError(e: any, label: string) {
    if (e instanceof TrackerError) {
      log.warn("tracker_error", { code: e.code, label, message: e.message });
      if (e.code === "github_rate_limited" || e.code === "github_secondary_rate_limit") {
        const cap = Math.min(
          this.effectivePollIntervalMs * 4,
          this.cfg().agent.max_retry_backoff_ms,
        );
        this.rateLimitBackoffUntilMs = Date.now() + cap;
      }
    } else {
      log.error("tracker_unknown_error", { label, error: e?.message });
    }
  }

  snapshot(): {
    generated_at: string;
    started_at: string;
    counts: { running: number; retrying: number; paused: number };
    running: any[];
    retrying: any[];
    paused: any[];
    claude_totals: ClaudeTotals;
    tracker_rate_limits: RateLimitSnapshot | null;
    claude_rate_limits: RateLimitSnapshot | null;
    workflow: {
      source: string;
      tracker_kind: string;
      repository: string | null;
      project_id: string | null;
      poll_interval_ms: number;
      max_concurrent_agents: number;
      max_turns: number;
    };
  } {
    const maxTurns = this.cfg().agent.max_turns;
    const running = Array.from(this.running.values()).map((r) => {
      const liveIn = r.input_tokens + r.advisory_input_tokens;
      const liveOut = r.output_tokens + r.advisory_output_tokens;
      const liveCc = r.cache_creation_input_tokens + r.advisory_cache_creation_input_tokens;
      const liveCr = r.cache_read_input_tokens + r.advisory_cache_read_input_tokens;
      const live = r.advisory_input_tokens + r.advisory_output_tokens > 0;
      return {
        issue_id: r.issue_id,
        issue_identifier: r.identifier,
        repository: r.issue.repository,
        title: r.issue.title,
        url: r.issue.url,
        state: r.issue.state,
        priority: r.issue.priority,
        labels: r.issue.labels,
        assignees: r.issue.assignees,
        session_id: r.session_id,
        claude_pid: r.claude_pid,
        turn_count: r.turn_count,
        max_turns: maxTurns,
        status: r.status,
        last_event: r.last_event,
        last_message: r.last_message,
        started_at: r.started_at,
        last_event_at: r.last_event_timestamp,
        error: r.error ?? null,
        tokens: {
          input_tokens: liveIn,
          output_tokens: liveOut,
          cache_creation_input_tokens: liveCc,
          cache_read_input_tokens: liveCr,
          // Headline total includes cache reads + cache writes so the displayed
          // number reflects the actual prompt size Claude processed, not just
          // the (typically tiny) non-cached delta.
          total_tokens: liveIn + liveOut + liveCc + liveCr,
          live, // true while mid-turn advisory is in effect
        },
        cost_usd: r.total_cost_usd,
        events: r.events.slice(-30),
        workspace_path: r.workspace_path,
      };
    });
    const retrying = Array.from(this.retry_attempts.values()).map((r) => ({
      issue_id: r.issue_id,
      issue_identifier: r.identifier,
      attempt: r.attempt,
      due_at: r.due_at,
      error: r.error,
    }));
    const paused = Array.from(this.paused.values()).map((p) => {
      const inn = p.input_tokens;
      const out = p.output_tokens;
      const cc = p.cache_creation_input_tokens;
      const cr = p.cache_read_input_tokens;
      return {
        issue_id: p.issue_id,
        issue_identifier: p.identifier,
        repository: p.issue.repository,
        title: p.issue.title,
        url: p.issue.url,
        state: p.issue.state,
        priority: p.issue.priority,
        labels: p.issue.labels,
        assignees: p.issue.assignees,
        session_id: p.session_id,
        turn_count: p.turn_count,
        max_turns: maxTurns,
        status: "Paused" as const,
        resume_start_turn: p.resume_start_turn,
        paused_at: p.paused_at,
        paused_reason: p.paused_reason,
        started_at: p.started_at,
        tokens: {
          input_tokens: inn,
          output_tokens: out,
          cache_creation_input_tokens: cc,
          cache_read_input_tokens: cr,
          total_tokens: inn + out + cc + cr,
          live: false,
        },
        cost_usd: p.total_cost_usd,
        events: p.events.slice(-30),
        workspace_path: p.workspace_path,
      };
    });
    return {
      generated_at: new Date().toISOString(),
      started_at: this.startedAt,
      counts: { running: running.length, retrying: retrying.length, paused: paused.length },
      running,
      retrying,
      paused,
      claude_totals: this.claude_totals,
      tracker_rate_limits: this.tracker_rate_limits,
      claude_rate_limits: this.claude_rate_limits,
      workflow: {
        source: this.workflow.source_path,
        tracker_kind: this.cfg().tracker.kind,
        repository: this.cfg().tracker.repository ?? null,
        project_id: this.cfg().tracker.project_id ?? null,
        poll_interval_ms: this.effectivePollIntervalMs,
        max_concurrent_agents: this.cfg().agent.max_concurrent_agents,
        max_turns: maxTurns,
      },
    };
  }

  findRunningByIdentifier(identifier: string) {
    for (const r of this.running.values()) {
      if (r.identifier === identifier) return r;
    }
    return null;
  }

  async forceRefresh(): Promise<void> {
    // Cancel the current scheduled tick and run immediately
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    await this.tick();
  }
}

function trackerSignature(t: ServiceConfig["tracker"]): string {
  return JSON.stringify({
    kind: t.kind,
    endpoint: t.endpoint,
    repository: t.repository,
    project_id: t.project_id,
    api_key_present: !!t.api_key,
  });
}

function nextAttempt(prev: number | null): number {
  if (prev == null) return 1;
  return prev + 1;
}
