// Strict liquid template rendering (Section 5.4, 12).
//
// Unknown variables and unknown filters MUST fail rendering.

import { Liquid } from "liquidjs";
import type { Issue } from "../types.js";

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
