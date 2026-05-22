---
# ============================================================================
# Symphony workflow contract (PowerShell edition).
#
# Every workspace hook below is authored in PowerShell and executed by Symphony
# through `powershell.exe` / `pwsh` — never bash. Use `$env:NAME` to read the
# injected SYMPHONY_* variables and `$($env:NAME)` for interpolation inside
# double-quoted strings.
# ============================================================================

tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  repository: jarheghan/SparkHub
  state_source: labels
  state_label_prefix: "status:"
  active_states: ["Todo", "In Progress", "Open"]
  terminal_states: ["Done", "Cancelled", "Wont Fix", "Duplicate"]
  priority_source: labels
  priority_label_pattern: "^p(\\d)$"
  assignee_filter: ["@me"]
  label_filters:
    include: ["feat"]
    exclude: ["needs-human"]

polling:
  interval_ms: 30000
  use_etag: true

workspace:
  root: ~/code/symphony-workspaces

hooks:
  # Runs once, only when a per-issue workspace directory is first created.
  after_create: |
    git clone --depth=1 "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/$($env:SYMPHONY_ISSUE_REPOSITORY).git" .
    git config user.email "symphony-bot@users.noreply.github.com"
    git config user.name  "Symphony Bot"

  # Runs before every Claude Code attempt. Always start from a clean tree
  # (a previous run may have left uncommitted work, which would otherwise block
  # `git checkout`). If the PR branch already exists on the remote, continue it
  # so work accumulates across runs; otherwise branch off the default.
  before_run: |
    git fetch origin
    git reset --hard
    git clean -fd
    $branch = "symphony/$($env:SYMPHONY_ISSUE_BRANCH_NAME)"
    if (git ls-remote --heads origin $branch) {
      # `after_create` clones with --depth=1, which implies --single-branch:
      # `git fetch origin` only updates origin/<default> and never creates an
      # origin/$branch ref. Fetch the branch by name and branch off FETCH_HEAD.
      git fetch origin $branch
      git checkout -B $branch FETCH_HEAD
    } else {
      $head = git symbolic-ref --quiet --short refs/remotes/origin/HEAD
      if (-not $head) { $head = "origin/main" }
      git checkout -B $branch $head
    }

  # Runs after every attempt (best effort — failures are logged and ignored).
  after_run: |
    git status --short

agent:
  max_concurrent_agents: 4
  max_turns: 8
  max_retry_backoff_ms: 300000

claude:
  command: claude
  model: claude-opus-4-7[1m]
  permission_mode: bypassPermissions
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

# Issue {{ issue.identifier }}: {{ issue.title }}

Repository: {{ issue.repository }}
Labels: {{ issue.labels | join: ", " }}
Assignees: {{ issue.assignees | join: ", " }}

{% if attempt %}
> This is retry/continuation attempt #{{ attempt }}.
{% endif %}

## Description

{{ issue.description }}

## Your task

1. Read the issue body and any linked references.
2. Make the required changes on the current branch.
3. Run the project's tests (for example `npm test`, `pytest`, or `mix test`) and
   make sure they pass.
4. Use the `gh` CLI to:
   - open a pull request when the work is ready for review,
   - add the `needs-review` label to this issue,
   - and post a short summary comment linking the PR.
5. When the PR is open and the issue is labeled `needs-review`, your work is
   done — stop.

If you hit something you cannot resolve (missing context, broken environment,
ambiguous requirements), add the `needs-human` label, comment with your
blockers, and stop. Do not fabricate solutions.
