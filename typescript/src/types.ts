// Symphony core domain types (Section 4 of SPEC-CLAUDE-GITHUB.md)

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  number: number;
  repository: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  github_state: "open" | "closed";
  branch_name: string | null;
  url: string | null;
  labels: string[];
  assignees: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key?: string;
  app_credentials?: {
    app_id?: string | number;
    installation_id?: string | number;
    private_key?: string;
  };
  repository?: string;
  project_id?: string;
  state_source: "labels" | "project" | "closed_flag";
  state_label_prefix: string;
  state_field: string;
  priority_source: "labels" | "project" | "none";
  priority_label_pattern: string;
  priority_field: string;
  assignee_filter?: string[];
  label_filters?: {
    include?: string[];
    exclude?: string[];
  };
  active_states: string[];
  terminal_states: string[];
}

export interface PollingConfig {
  interval_ms: number;
  use_etag: boolean;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  after_create?: string;
  before_run?: string;
  after_run?: string;
  before_remove?: string;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

export interface ClaudeConfig {
  command: string;
  model?: string;
  permission_mode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  allowed_tools?: string[];
  disallowed_tools?: string[];
  mcp_config?: string;
  add_dir?: string[];
  claude_settings?: string;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
  extra_args?: string[];
  continuation_prompt?: string;
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  claude: ClaudeConfig;
}

export interface WorkflowDefinition {
  config_raw: Record<string, any>;
  config: ServiceConfig;
  prompt_template: string;
  source_path: string;
}

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingClaude"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

export interface LiveSession {
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  claude_pid: string | null;
  last_event: string | null;
  last_event_timestamp: string | null;
  last_message: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
  total_cost_usd: number;
}

export interface RunningEntry extends LiveSession {
  issue_id: string;
  identifier: string;
  issue: Issue;
  workspace_path: string;
  status: RunAttemptStatus;
  retry_attempt: number | null;
  started_at: string;
  error?: string;
  events: RuntimeEvent[]; // recent events (bounded)
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  due_at: string;
  error: string | null;
}

export interface ClaudeTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
  seconds_running: number;
  total_cost_usd: number;
}

export interface RateLimitSnapshot {
  graphql_remaining?: number;
  graphql_reset_at?: string;
  rest_remaining?: number;
  rest_reset_at?: string;
  retry_after_ms?: number;
}

export type RuntimeEvent = {
  event: string;
  timestamp: string;
  claude_pid?: string | null;
  payload?: any;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    total_cost_usd?: number;
  };
};
