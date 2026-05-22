// Symphony dashboard — React 18 (ESM CDN) + htm for JSX-free templating.
// A real-time view of the orchestrator: live Claude Code sessions, the retry
// queue, token/cost accounting, and a streaming activity feed.

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

/* ------------------------------------------------------------------ utils */
const fmtNum = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return (n / 1e3).toFixed(a < 1e4 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(a < 1e7 ? 2 : 1) + "M";
};

const fmtCost = (n) => {
  if (n == null) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
};

const fmtDuration = (sec) => {
  if (!Number.isFinite(sec) || sec < 1) return "0s";
  if (sec < 60) return Math.round(sec) + "s";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const fmtRelative = (iso) => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1500) return "just now";
  if (ms < 60_000) return Math.floor(ms / 1000) + "s ago";
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m ago";
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h ago";
  return Math.floor(ms / 86_400_000) + "d ago";
};

const fmtTime = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const fmtCountdown = (ms) => {
  if (ms <= 0) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
};

const eventClass = (name) => {
  if (!name) return "";
  if (/fail|error|cancel|timeout|stall|malformed/.test(name)) return "err";
  if (/complete|started|success|^ok$|usage/.test(name)) return "ok";
  return "";
};

/* ------------------------------------------------------------------- icons */
const Icon = {
  refresh: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg>`,
  branch: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  ext: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  pulse: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
  clock: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>`,
  tokens: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  coin: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.2A2.6 2.6 0 0 1 12 7.6c1.5 0 2.6.9 2.6 2.1 0 2.7-5.2 1.6-5.2 4.4 0 1.2 1.2 2.1 2.6 2.1 1.3 0 2.2-.6 2.5-1.5"/></svg>`,
  inbox: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5z"/></svg>`,
  check: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14.1 9 11.1"/></svg>`,
  pause: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
  play: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
  caret: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  zap: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  alert: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};

/* ------------------------------------------------------------- count-up hook */
function useCountUp(value, duration = 650) {
  const [display, setDisplay] = useState(value || 0);
  const from = useRef(value || 0);
  const raf = useRef(0);
  useEffect(() => {
    const target = value || 0;
    const start = performance.now();
    const origin = from.current;
    cancelAnimationFrame(raf.current);
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(origin + (target - origin) * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);
  return display;
}

/* --------------------------------------------------------------- components */
function Topbar({ connected, paused, repo, onRefresh, refreshing }) {
  const cls = !connected ? "off" : paused ? "warn" : "";
  const label = !connected ? "Offline" : paused ? "Rate-limited" : "Live";
  return html`
    <header class="topbar">
      <div class=${"brand" + (paused ? " paused" : "")}>
        <div class="brand-mark" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </div>
        <div>
          <div class="brand-name">Symphony</div>
          <div class="brand-tag">Claude Code · GitHub orchestrator</div>
        </div>
      </div>
      <div class="topbar-right">
        ${repo
          ? html`<div class="repo-pill" title=${repo}>${Icon.branch}<span>${repo}</span></div>`
          : null}
        <div class=${"status " + cls}>
          <span class="dot"></span><span>${label}</span>
        </div>
        <button
          class=${"btn" + (refreshing ? " spin" : "")}
          onClick=${onRefresh}
          title="Trigger an immediate poll tick"
        >
          ${Icon.refresh}<span>Poll now</span>
        </button>
      </div>
    </header>
  `;
}

function Metric({ label, icon, value, unit, grad, foot, meter }) {
  // The hook is called unconditionally (rules of hooks); when `value` is a
  // string placeholder like "—" the animated number is simply ignored.
  const isNum = typeof value === "number";
  const animated = useCountUp(isNum ? value : 0);
  const shown = !isNum
    ? value
    : value >= 1000 || value % 1 !== 0
    ? fmtNum(animated)
    : Math.round(animated);
  return html`
    <div class="metric">
      <div class="metric-top">
        <div class="metric-label">${label}</div>
        <div class="metric-icon">${icon}</div>
      </div>
      <div class="metric-value">
        <span class=${grad ? "grad" : ""}>${shown}</span>
        ${unit ? html`<span class="unit">${unit}</span>` : null}
      </div>
      ${meter != null
        ? html`<div class="meter"><i style=${{ width: Math.max(2, Math.min(100, meter * 100)) + "%" }}></i></div>`
        : null}
      <div class="metric-foot">${foot}</div>
    </div>
  `;
}

function TurnRing({ turn, max }) {
  const R = 24;
  const C = 2 * Math.PI * R;
  const frac = max > 0 ? Math.min(1, (turn || 0) / max) : 0;
  return html`
    <div class="ring" title=${`turn ${turn || 0} of ${max}`}>
      <svg viewBox="0 0 56 56">
        <circle class="track" cx="28" cy="28" r=${R} fill="none" stroke-width="4" />
        <circle
          class="fill"
          cx="28"
          cy="28"
          r=${R}
          fill="none"
          stroke-width="4"
          stroke-dasharray=${C}
          stroke-dashoffset=${C * (1 - frac)}
        />
      </svg>
      <div class="ring-label">
        <b>${turn || 0}</b>
        <small>turn</small>
      </div>
    </div>
  `;
}

function TokenBar({ tokens }) {
  const t = tokens || {};
  const inn = t.input_tokens || 0;
  const out = t.output_tokens || 0;
  const cw = t.cache_creation_input_tokens || 0;
  const cr = t.cache_read_input_tokens || 0;
  const total = inn + out + cw + cr || 1;
  const pct = (v) => (v / total) * 100 + "%";
  return html`
    <div class="bar">
      <span class="seg-in" style=${{ width: pct(inn) }}></span>
      <span class="seg-out" style=${{ width: pct(out) }}></span>
      <span class="seg-cw" style=${{ width: pct(cw) }}></span>
      <span class="seg-cr" style=${{ width: pct(cr) }}></span>
    </div>
    <div class="legend">
      <span><i class="l-in"></i>${fmtNum(inn)} input</span>
      <span><i class="l-out"></i>${fmtNum(out)} output</span>
      <span><i class="l-cw"></i>${fmtNum(cw)} cache write</span>
      <span><i class="l-cr"></i>${fmtNum(cr)} cache read</span>
    </div>
  `;
}

function Stat({ k, v, accent }) {
  return html`
    <div class="stat">
      <div class="k">${k}</div>
      <div class=${"v" + (accent ? " run-status" : "")}>${v}</div>
    </div>
  `;
}

function SessionCard({ run, open, onToggle, onPause, busy }) {
  const t = run.tokens || {};
  const stateCls = /progress/i.test(run.state || "") ? " s-progress" : "";
  const cat = eventClass(run.last_event);
  const events = (run.events || []).slice().reverse();
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the interrupt menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);
  const pausing = /pausing|paused/i.test(run.status || "");
  return html`
    <div class=${"card session" + (open ? " open" : "")}>
      <div class="session-head" onClick=${onToggle}>
        <div class="session-main">
          <div class="ident-row">
            <span class="ident">${run.issue_identifier}</span>
            <span class=${"pill state" + stateCls}>${run.state || "—"}</span>
            ${run.priority != null
              ? html`<span class="pill prio">P${run.priority}</span>`
              : null}
            ${run.pr && run.pr.mergeable === "conflicting"
              ? html`<a
                  class="pill pr-conflict"
                  href=${run.pr.url || "#"}
                  target="_blank"
                  rel="noreferrer"
                  onClick=${(e) => e.stopPropagation()}
                  title=${`PR #${run.pr.number} has merge conflicts — the agent is resolving it`}
                  >${Icon.alert}<span>PR #${run.pr.number} conflict</span></a
                >`
              : null}
            ${run.url
              ? html`<a
                  class="gh-link"
                  href=${run.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick=${(e) => e.stopPropagation()}
                  >${Icon.ext}github</a
                >`
              : null}
          </div>
          <div class="session-title">${run.title || "(untitled issue)"}</div>
          ${run.labels && run.labels.length
            ? html`<div class="labels">
                ${run.labels.slice(0, 7).map(
                  (l) => html`<span class="chip" key=${l}>${l}</span>`,
                )}
                ${run.labels.length > 7
                  ? html`<span class="chip">+${run.labels.length - 7}</span>`
                  : null}
              </div>`
            : null}
        </div>
        <${TurnRing} turn=${run.turn_count} max=${run.max_turns || 1} />
      </div>

      <div class="session-stats">
        <${Stat} k="Status" v=${run.status} accent=${true} />
        <${Stat} k="Session" v=${run.session_id ? run.session_id.slice(0, 8) : "—"} />
        <${Stat} k="PID" v=${run.claude_pid || "—"} />
        <${Stat} k="Started" v=${fmtRelative(run.started_at)} />
        <${Stat} k="Repository" v=${run.repository} />
      </div>

      <div class="tokens">
        <div class="tokens-top">
          <div class="tokens-total">
            <span class="grad">${fmtNum(t.total_tokens || 0)}</span> tokens
          </div>
          <div class="tokens-cost">${fmtCost(run.cost_usd)}</div>
        </div>
        <${TokenBar} tokens=${t} />
      </div>

      <div class="now-line">
        <span class=${"spark " + cat}></span>
        <span class="now-ev">${run.last_event || "waiting"}</span>
        <span class="now-msg">${run.last_message || "no message yet"}</span>
        ${t.live
          ? html`<span class="live-tag"><i></i>streaming</span>`
          : null}
      </div>

      <div class="session-actions" onClick=${(e) => e.stopPropagation()}>
        ${pausing
          ? html`<span class="pausing-note">${Icon.pause}<span>pause requested — stopping…</span></span>`
          : html`<div class="split-btn">
              <button
                class="btn-sm"
                disabled=${busy}
                onClick=${() => onPause(run.issue_identifier, "graceful")}
                title="Finish the in-flight turn, then hold"
              >
                ${Icon.pause}<span>Pause</span>
              </button>
              <button
                class=${"btn-sm caret" + (menuOpen ? " active" : "")}
                disabled=${busy}
                onClick=${() => setMenuOpen((o) => !o)}
                title="More pause options"
              >
                ${Icon.caret}
              </button>
              ${menuOpen
                ? html`<div class="pause-menu">
                    <button
                      class="pause-menu-item"
                      onClick=${() => {
                        setMenuOpen(false);
                        onPause(run.issue_identifier, "interrupt");
                      }}
                    >
                      ${Icon.zap}
                      <span>
                        <b>Interrupt now</b>
                        <small>kill the turn — partial work is discarded</small>
                      </span>
                    </button>
                  </div>`
                : null}
            </div>`}
      </div>

      ${open
        ? html`<div class="detail">
            <div class="detail-title">
              <span>Event stream</span>
              <span>${events.length} events</span>
            </div>
            <div class="stream">
              ${events.length === 0
                ? html`<div class="empty mini">
                    <div class="e-sub">No events captured yet.</div>
                  </div>`
                : events.map((ev, i) => {
                    const detail = ev.payload
                      ? Object.entries(ev.payload)
                          .filter(([k]) => k !== "stderr" && k !== "tools")
                          .map(
                            ([k, v]) =>
                              `${k}=${
                                typeof v === "string"
                                  ? v.slice(0, 70)
                                  : JSON.stringify(v).slice(0, 70)
                              }`,
                          )
                          .join("  ")
                      : "";
                    return html`<div class="ev" key=${i}>
                      <span class="ev-t">${fmtTime(ev.timestamp)}</span>
                      <span class=${"ev-n " + eventClass(ev.event)}>${ev.event}</span>
                      <span class="ev-d">${detail}</span>
                    </div>`;
                  })}
            </div>
            ${run.error
              ? html`<div class="err-banner">${run.error}</div>`
              : null}
            <div class="ws-path"><b>workspace</b> · ${run.workspace_path || "—"}</div>
          </div>`
        : null}
    </div>
  `;
}

function PausedCard({ run, open, onToggle, onResume, busy }) {
  const t = run.tokens || {};
  const stateCls = /progress/i.test(run.state || "") ? " s-progress" : "";
  const events = (run.events || []).slice().reverse();
  return html`
    <div class=${"card session is-paused" + (open ? " open" : "")}>
      <div class="session-head" onClick=${onToggle}>
        <div class="session-main">
          <div class="ident-row">
            <span class="ident">${run.issue_identifier}</span>
            <span class="pill paused-pill">${Icon.pause}<span>paused</span></span>
            <span class=${"pill state" + stateCls}>${run.state || "—"}</span>
            ${run.priority != null
              ? html`<span class="pill prio">P${run.priority}</span>`
              : null}
            ${run.url
              ? html`<a
                  class="gh-link"
                  href=${run.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick=${(e) => e.stopPropagation()}
                  >${Icon.ext}github</a
                >`
              : null}
          </div>
          <div class="session-title">${run.title || "(untitled issue)"}</div>
          ${run.labels && run.labels.length
            ? html`<div class="labels">
                ${run.labels.slice(0, 7).map(
                  (l) => html`<span class="chip" key=${l}>${l}</span>`,
                )}
                ${run.labels.length > 7
                  ? html`<span class="chip">+${run.labels.length - 7}</span>`
                  : null}
              </div>`
            : null}
        </div>
        <${TurnRing} turn=${run.turn_count} max=${run.max_turns || 1} />
      </div>

      <div class="session-stats">
        <${Stat} k="Status" v="Paused" accent=${true} />
        <${Stat} k="Pause mode" v=${run.paused_reason || "—"} />
        <${Stat} k="Session" v=${run.session_id ? run.session_id.slice(0, 8) : "fresh"} />
        <${Stat} k="Paused" v=${fmtRelative(run.paused_at)} />
        <${Stat} k="Resumes at" v=${"turn " + (run.resume_start_turn || 1)} />
      </div>

      <div class="tokens">
        <div class="tokens-top">
          <div class="tokens-total">
            <span class="grad">${fmtNum(t.total_tokens || 0)}</span> tokens
          </div>
          <div class="tokens-cost">${fmtCost(run.cost_usd)}</div>
        </div>
        <${TokenBar} tokens=${t} />
      </div>

      <div class="session-actions" onClick=${(e) => e.stopPropagation()}>
        <button
          class="btn-sm resume"
          disabled=${busy}
          onClick=${() => onResume(run.issue_identifier)}
          title="Re-enter the per-turn loop via --resume"
        >
          ${Icon.play}<span>Resume</span>
        </button>
        <span class="paused-hint">
          ${run.session_id
            ? "continues session " + run.session_id.slice(0, 8) + " via --resume"
            : "no session captured — resume restarts fresh"}
        </span>
      </div>

      ${open
        ? html`<div class="detail">
            <div class="detail-title">
              <span>Event stream</span>
              <span>${events.length} events</span>
            </div>
            <div class="stream">
              ${events.length === 0
                ? html`<div class="empty mini">
                    <div class="e-sub">No events captured yet.</div>
                  </div>`
                : events.map((ev, i) => {
                    const detail = ev.payload
                      ? Object.entries(ev.payload)
                          .filter(([k]) => k !== "stderr" && k !== "tools")
                          .map(
                            ([k, v]) =>
                              `${k}=${
                                typeof v === "string"
                                  ? v.slice(0, 70)
                                  : JSON.stringify(v).slice(0, 70)
                              }`,
                          )
                          .join("  ")
                      : "";
                    return html`<div class="ev" key=${i}>
                      <span class="ev-t">${fmtTime(ev.timestamp)}</span>
                      <span class=${"ev-n " + eventClass(ev.event)}>${ev.event}</span>
                      <span class="ev-d">${detail}</span>
                    </div>`;
                  })}
            </div>
            <div class="ws-path"><b>workspace</b> · ${run.workspace_path || "—"}</div>
          </div>`
        : null}
    </div>
  `;
}

function RetryPanel({ retrying }) {
  const now = Date.now();
  return html`
    <div class="panel">
      <div class="panel-head">
        <h3>Retry queue</h3>
        <span class="tally">${retrying.length}</span>
      </div>
      <div class="panel-body">
        ${retrying.length === 0
          ? html`<div class="empty mini">
              <div class="glyph">${Icon.check}</div>
              <div class="e-sub">Queue is clear — nothing waiting to retry.</div>
            </div>`
          : retrying.map(
              (r) => html`<div class="retry" key=${r.issue_id}>
                <div>
                  <div class="r-id">${r.issue_identifier}</div>
                  <div class="r-meta">attempt #${r.attempt} · ${r.error || "queued"}</div>
                </div>
                <div class="r-due">
                  ${fmtCountdown(new Date(r.due_at).getTime() - now)}
                </div>
              </div>`,
            )}
      </div>
    </div>
  `;
}

function WorkflowPanel({ wf, totals, rate, startedAt }) {
  if (!wf) return null;
  const rows = [
    ["repository", wf.repository || wf.project_id || "—", true],
    ["tracker", wf.tracker_kind, false],
    ["poll interval", `${Math.round((wf.poll_interval_ms || 0) / 1000)}s`, false],
    ["max agents", String(wf.max_concurrent_agents ?? "—"), false],
    ["max turns", String(wf.max_turns ?? "—"), false],
    ["uptime", fmtRelative(startedAt).replace(" ago", ""), false],
    ["compute time", fmtDuration(totals?.seconds_running || 0), false],
  ];
  if (rate && rate.graphql_remaining != null) {
    rows.push(["graphql budget", `${rate.graphql_remaining} left`, false]);
  }
  return html`
    <div class="panel">
      <div class="panel-head"><h3>Workflow</h3></div>
      <div class="panel-body">
        ${rows.map(
          ([k, v, accent]) => html`<div class="kv" key=${k}>
            <span class="k">${k}</span>
            <span class=${"v" + (accent ? " accent" : "")} title=${v}>${v}</span>
          </div>`,
        )}
      </div>
    </div>
  `;
}

function ActivityPanel({ feed }) {
  return html`
    <div class="panel">
      <div class="panel-head">
        <h3>Activity</h3>
        <span class="tally">${feed.length}</span>
      </div>
      <div class="panel-body">
        ${feed.length === 0
          ? html`<div class="empty mini">
              <div class="e-sub">Agent events will stream here in real time.</div>
            </div>`
          : html`<div class="feed">
              ${feed
                .slice()
                .reverse()
                .slice(0, 120)
                .map((e, i) => {
                  const name = e.event?.event || "event";
                  const extra = e.event?.payload?.name
                    ? ` · ${e.event.payload.name}`
                    : "";
                  return html`<div
                    class=${"feed-row is-" + (eventClass(name) || "n")}
                    key=${i}
                  >
                    <span class="f-t">${fmtTime(e.event?.timestamp)}</span>
                    <span class="f-id">${(e.issue_id || "").slice(0, 6)}</span>
                    <span class="f-ev">${name}${extra}</span>
                  </div>`;
                })}
            </div>`}
      </div>
    </div>
  `;
}

/* --------------------------------------------------------------------- app */
function App() {
  const [snap, setSnap] = useState(null);
  const [feed, setFeed] = useState([]);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState({});
  const [toast, setToast] = useState(null);
  const [, force] = useState(0);

  // 1s heartbeat so relative timers stay fresh
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // SSE with exponential reconnect
  useEffect(() => {
    let es;
    let dead = false;
    let attempt = 0;
    const connect = () => {
      es = new EventSource("/api/v1/events");
      es.addEventListener("snapshot", (ev) => {
        try {
          setSnap(JSON.parse(ev.data));
          setConnected(true);
          attempt = 0;
        } catch {}
      });
      es.addEventListener("agent_event", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          setFeed((cur) => {
            const next = [...cur, data];
            return next.length > 240 ? next.slice(-240) : next;
          });
        } catch {}
      });
      es.addEventListener("error", () => {
        setConnected(false);
        es?.close();
        if (dead) return;
        attempt = Math.min(attempt + 1, 8);
        setTimeout(connect, Math.min(1000 * 2 ** attempt, 15000));
      });
    };
    connect();
    return () => {
      dead = true;
      es?.close();
    };
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/v1/refresh", { method: "POST" });
    } catch {}
    setTimeout(() => setRefreshing(false), 700);
  };

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4600);
    return () => clearTimeout(t);
  }, [toast]);

  const sessionAction = async (ident, action, body) => {
    setBusy((b) => ({ ...b, [ident]: true }));
    try {
      const res = await fetch(
        `/api/v1/sessions/${encodeURIComponent(ident)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = data && data.error;
        const msg =
          err === "no_slot"
            ? `Can't resume ${ident} — no free agent slot. It stays paused.`
            : err === "not_found"
            ? `${ident} is no longer an active session.`
            : `${action} failed for ${ident}: ${err || res.status}`;
        setToast({ msg, kind: "err", id: Date.now() });
      } else if (action === "pause") {
        const verb = body && body.mode === "interrupt" ? "Interrupting" : "Pausing";
        setToast({ msg: `${verb} ${ident}…`, kind: "ok", id: Date.now() });
      } else if (action === "resume") {
        setToast({ msg: `Resuming ${ident}…`, kind: "ok", id: Date.now() });
      }
    } catch {
      setToast({
        msg: `${action} failed for ${ident}: network error`,
        kind: "err",
        id: Date.now(),
      });
    } finally {
      setBusy((b) => ({ ...b, [ident]: false }));
    }
  };

  const onPause = (ident, mode) => sessionAction(ident, "pause", { mode });
  const onResume = (ident) => sessionAction(ident, "resume");

  const running = snap?.running || [];
  const retrying = snap?.retrying || [];
  const pausedSessions = snap?.paused || [];
  const totals = snap?.claude_totals;
  const wf = snap?.workflow;
  const rate = snap?.tracker_rate_limits;
  const paused = !!(rate?.retry_after_ms && rate.retry_after_ms > 0);

  const cacheEff = useMemo(() => {
    const cr = totals?.cache_read_input_tokens || 0;
    const inn = totals?.input_tokens || 0;
    const denom = cr + inn;
    return denom > 0 ? cr / denom : 0;
  }, [totals]);

  const sorted = useMemo(
    () =>
      [...running].sort((a, b) => {
        const ap = a.priority ?? 99;
        const bp = b.priority ?? 99;
        if (ap !== bp) return ap - bp;
        return (a.started_at || "").localeCompare(b.started_at || "");
      }),
    [running],
  );

  return html`
    <div class="app">
      <svg width="0" height="0" style=${{ position: "absolute" }} aria-hidden="true">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#8b7bff" />
            <stop offset="1" stop-color="#5cd9e8" />
          </linearGradient>
        </defs>
      </svg>

      <${Topbar}
        connected=${connected}
        paused=${paused}
        repo=${wf?.repository || wf?.project_id}
        onRefresh=${onRefresh}
        refreshing=${refreshing}
      />

      <main class="main">
        <section class="metrics">
          <${Metric}
            label="Active sessions"
            icon=${Icon.pulse}
            value=${snap ? running.length : "—"}
            grad=${true}
            meter=${snap ? running.length / Math.max(1, wf?.max_concurrent_agents || 1) : null}
            foot=${snap
              ? html`<b>${wf?.max_concurrent_agents ?? "—"}</b> concurrent max${
                  pausedSessions.length > 0
                    ? html` · <b>${pausedSessions.length}</b> paused`
                    : ""
                }`
              : "connecting…"}
          />
          <${Metric}
            label="Retry queue"
            icon=${Icon.clock}
            value=${snap ? retrying.length : "—"}
            foot=${retrying.length > 0
              ? html`next in <b>${fmtCountdown(
                  new Date(retrying[0].due_at).getTime() - Date.now(),
                )}</b>`
              : "all caught up"}
          />
          <${Metric}
            label="Tokens processed"
            icon=${Icon.tokens}
            value=${snap ? totals?.total_tokens || 0 : "—"}
            meter=${snap ? cacheEff : null}
            foot=${snap
              ? html`<b>${Math.round(cacheEff * 100)}%</b> served from cache`
              : "connecting…"}
          />
          <${Metric}
            label="Cumulative cost"
            icon=${Icon.coin}
            value=${snap ? fmtCost(totals?.total_cost_usd || 0) : "—"}
            grad=${true}
            foot=${snap
              ? html`<b>${fmtDuration(totals?.seconds_running || 0)}</b> compute`
              : "connecting…"}
          />
        </section>

        <section class="grid">
          <div>
            <div class="col-head">
              <h2>Live sessions</h2>
              <span class="tally">${running.length} running</span>
            </div>
            ${!snap
              ? html`<div class="sessions">
                  ${[0, 1].map((i) => html`<div class="skeleton" key=${i}></div>`)}
                </div>`
              : sorted.length === 0
              ? html`<div class="empty">
                  <div class="glyph">${Icon.inbox}</div>
                  <div class="e-title">No active sessions</div>
                  <div class="e-sub">
                    Symphony is polling GitHub for eligible issues. A Claude Code
                    session appears here the moment one is dispatched.
                  </div>
                </div>`
              : html`<div class="sessions">
                  ${sorted.map(
                    (r) => html`<${SessionCard}
                      key=${r.issue_id}
                      run=${r}
                      open=${!!open[r.issue_id]}
                      onToggle=${() =>
                        setOpen((p) => ({ ...p, [r.issue_id]: !p[r.issue_id] }))}
                      onPause=${onPause}
                      busy=${!!busy[r.issue_identifier]}
                    />`,
                  )}
                </div>`}

            ${pausedSessions.length > 0
              ? html`<div class="col-head paused-head">
                    <h2>Paused sessions</h2>
                    <span class="tally">${pausedSessions.length} held</span>
                  </div>
                  <div class="sessions">
                    ${pausedSessions.map(
                      (r) => html`<${PausedCard}
                        key=${r.issue_id}
                        run=${r}
                        open=${!!open[r.issue_id]}
                        onToggle=${() =>
                          setOpen((p) => ({ ...p, [r.issue_id]: !p[r.issue_id] }))}
                        onResume=${onResume}
                        busy=${!!busy[r.issue_identifier]}
                      />`,
                    )}
                  </div>`
              : null}
          </div>

          <aside class="rail">
            <${RetryPanel} retrying=${retrying} />
            <${WorkflowPanel}
              wf=${wf}
              totals=${totals}
              rate=${rate}
              startedAt=${snap?.started_at}
            />
            <${ActivityPanel} feed=${feed} />
          </aside>
        </section>
      </main>

      <footer class="footer">
        <span class="ps-badge">PowerShell edition · TypeScript</span>
        <span
          >${snap
            ? "snapshot " + fmtRelative(snap.generated_at)
            : "awaiting first snapshot…"}</span
        >
      </footer>

      ${toast
        ? html`<div class=${"toast " + (toast.kind || "")} key=${toast.id}>
            <span class="toast-dot"></span>
            <span class="toast-msg">${toast.msg}</span>
            <button
              class="toast-x"
              onClick=${() => setToast(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>`
        : null}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
