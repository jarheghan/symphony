// Loads WORKFLOW.md: parses YAML front matter and prompt body (Section 5.2).

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { resolveServiceConfig } from "./config.js";
import type { WorkflowDefinition } from "../types.js";

export class WorkflowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const absolute = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(absolute, "utf8");
  } catch (e: any) {
    throw new WorkflowError(
      "missing_workflow_file",
      `WORKFLOW.md not found at ${absolute}: ${e.message}`,
    );
  }

  const { config_raw, prompt_template } = splitFrontMatter(raw);
  const config = resolveServiceConfig(config_raw, absolute);
  return { config_raw, config, prompt_template, source_path: absolute };
}

export function splitFrontMatter(raw: string): {
  config_raw: Record<string, any>;
  prompt_template: string;
} {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    // find closing ---
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        close = i;
        break;
      }
    }
    if (close === -1) {
      throw new WorkflowError("workflow_parse_error", "Unterminated YAML front matter");
    }
    const yamlText = lines.slice(1, close).join("\n");
    let parsed: unknown;
    try {
      parsed = YAML.parse(yamlText);
    } catch (e: any) {
      throw new WorkflowError("workflow_parse_error", `YAML parse error: ${e.message}`);
    }
    if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new WorkflowError(
        "workflow_front_matter_not_a_map",
        "Front matter YAML must decode to a map",
      );
    }
    const config_raw = (parsed ?? {}) as Record<string, any>;
    const body = lines.slice(close + 1).join("\n").trim();
    return { config_raw, prompt_template: body };
  }
  return { config_raw: {}, prompt_template: raw.trim() };
}
