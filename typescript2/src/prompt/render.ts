// Strict liquid template rendering (Section 5.4, 12).
//
// Unknown variables and unknown filters MUST fail rendering.

import { Liquid } from "liquidjs";
import type { Issue, LinkedPullRequest } from "../types.js";

export class PromptError extends Error {
  constructor(public code: "template_parse_error" | "template_render_error", message: string) {
    super(message);
    this.name = "PromptError";
  }
}

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  greedy: false,
});

export const DEFAULT_FALLBACK_PROMPT = "You are working on a GitHub issue.";

export async function renderPrompt(
  template: string,
  variables: { issue: Issue; attempt: number | null },
): Promise<string> {
  const body = template?.trim().length ? template : DEFAULT_FALLBACK_PROMPT;
  try {
    return await engine.parseAndRender(body, variables);
  } catch (e: any) {
    if (/template/i.test(e.name || "") || /parse/i.test(e.message || "")) {
      throw new PromptError("template_parse_error", e.message);
    }
    throw new PromptError("template_render_error", e.message);
  }
}

export function buildContinuationPrompt(
  template: string | undefined,
  issue: Issue,
  attempt: number | null,
): string {
  const dflt = `Continue with the next step on issue ${issue.identifier}.`;
  if (!template) return dflt;
  return template
    .replace(/\{\{\s*issue\.identifier\s*\}\}/g, issue.identifier)
    .replace(/\{\{\s*attempt\s*\}\}/g, attempt == null ? "" : String(attempt));
}

/** Marker line that opens the conflict directive — also used by tests. */
export const CONFLICT_DIRECTIVE_MARKER =
  "=== MERGE CONFLICT — RESOLVE BEFORE ANY OTHER WORK ===";

/**
 * A self-contained, template-agnostic instruction block telling the agent to
 * resolve a conflicting pull request before doing anything else. Prepended to
 * whatever prompt the per-turn loop built. The explicit `git checkout` makes it
 * robust regardless of what the `before_run` hook left in the working tree.
 */
export function buildConflictDirective(pr: LinkedPullRequest): string {
  const base = pr.base_ref_name || "the base branch";
  return [
    CONFLICT_DIRECTIVE_MARKER,
    `Pull request #${pr.number} (${pr.url ?? "no url"}) for this issue has merge`,
    "conflicts with its base branch and cannot be merged as-is.",
    `  PR branch:   ${pr.head_ref_name}`,
    `  Base branch: ${base}`,
    "Resolve it now, before continuing with the issue:",
    "  1. git fetch origin",
    `  2. git checkout ${pr.head_ref_name}      # make sure you are on the PR branch`,
    "  3. Integrate the latest base branch — pick the approach that matches this",
    "     repository's history conventions:",
    `       - merge:  git merge origin/${base}`,
    `       - rebase: git rebase origin/${base}`,
    "  4. Resolve every conflicted file, then stage and commit (or continue the rebase).",
    "  5. Run the project's tests and make sure they pass.",
    "  6. Push:  git push   (use git push --force-with-lease if you rebased)",
    `Only once PR #${pr.number} is mergeable again, continue with the remaining issue work.`,
    "======================================================",
  ].join("\n");
}
