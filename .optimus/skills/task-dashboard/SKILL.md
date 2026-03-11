---
name: task-dashboard
description: Teaches Master Agent how to inspect swarm runtime state, summarize task health, and flag stale or failed work.
---

# Task Dashboard (Swarm Observability)

<description>
This skill activates when you need to inspect background execution state and present a concise dashboard instead of raw logs. It provides comprehensive swarm observability for monitoring task health, identifying bottlenecks, and maintaining system reliability. Triggers include pre-delegation checks, post-dispatch monitoring, user status requests, troubleshooting stuck tasks, or auditing recent outcomes.
</description>

<workflow>
### Step 1: State Snapshot Collection
- **Tool**: File reading capability
- **Parameters**:
  - `file_path`: `.optimus/state/task-manifest.json`
- **Action**: Read the task manifest exactly once for a complete snapshot. This contains all delegate_task and dispatch_council records with status, role/roles, output paths, timing, and issue links. Do not poll repeatedly - single read for analysis.

### Step 2: Data Normalization and Processing
- **Tool**: None (analysis step)
- **Parameters**: N/A
- **Action**: For each manifest entry, normalize the data by determining task kind (delegate_task vs dispatch_council), owner display (role for delegate_task, roles.join(', ') for dispatch_council), compute elapsed time from startTime, and preserve status, output_path, and github_issue_number when present. Render 'n/a' for missing fields instead of dropping rows.

### Step 3: Health Summary Computation
- **Tool**: None (analysis step)
- **Parameters**: N/A
- **Action**: Compute status counts for running, completed, verified, partial, and failed tasks. Identify recent completions (last 5 by newest startTime with completed or verified status), stale running tasks (running longer than 10 minutes), and failure list (all failed entries with error_message).

### Step 4: Agent Runtime Cross-Check
- **Tool**: File reading capability for agent states
- **Parameters**:
  - `file_path`: `.optimus/agents/*.md` frontmatter status fields
  - `file_path`: `.optimus/agents/*.lock` lock files
- **Action**: Read agent frontmatter status and compare with lock files to identify:
  - status: running + lock exists = healthy running
  - status: running + no lock = possibly stale/abandoned
  - status: idle + lock exists = lock leak candidate
  - Document any inconsistencies for troubleshooting

### Step 5: Concise Dashboard Presentation
- **Tool**: None (formatting step)
- **Parameters**: N/A
- **Action**: Present results in three sections: (1) Overview counts, (2) Running/stale/failed highlights, (3) Recent completions. Use the standardized compact format without dumping raw JSON. Include minimum required signals: running tasks with elapsed time, stale markers for >10m, failed tasks with error messages, last 5 completed/verified entries, and count summary across all statuses.

### Step 6: Targeted Status Refresh (Optional)
- **Tool**: `check_task_status`
- **Parameters**:
  - `taskId`: Specific task ID for live refresh
- **Action**: Use this tool only for targeted checks when a task appears stale, user asks for specific task update, or dependency requires confirmation before next step. Prefer targeted checks over repeated global polling.
</workflow>

<error_handling>
- If task-manifest.json reading fails, THEN check if file exists and create empty dashboard noting the limitation.
- If agent status files are inaccessible, THEN proceed with manifest-only dashboard but note the agent state limitation.
- If lock file directory is unreadable, THEN skip lock file cross-check and document the limitation in dashboard notes.
- If `check_task_status` fails for specific task, THEN note the failure in dashboard and provide manual file check instructions.
- If JSON parsing fails for manifest, THEN attempt partial parsing and report which entries could not be processed.
</error_handling>

<anti_patterns>
- Do not dump the full manifest JSON into chat — always present processed, human-readable summaries.
- Do not poll in a loop — read once and summarize, avoid repeated rapid refreshes.
- Do not mutate `.optimus/state/task-manifest.json` — it is an append-only audit record.
- Do not claim a task is stuck without checking elapsed time and lock/frontmatter signals.
- Do not block the conversation waiting for all background tasks to finish.
- Do not use `check_task_status` for bulk monitoring — it is for targeted individual task checks.
- Do not assume task failure without checking error_message field in manifest.
- Do not ignore stale detection thresholds — flag tasks running >10 minutes as potentially stale.
</anti_patterns>

## Data Sources Reference

All swarm state lives in `.optimus/state/` and `.optimus/agents/`:

| Source | Path | What It Contains |
|--------|------|-----------------|
| **Task Manifest** | `.optimus/state/task-manifest.json` | All `delegate_task` and `dispatch_council` records (`status`, role/roles, output, timing, issue links) |
| **T1 Agent Status** | `.optimus/agents/<name>.md` frontmatter `status` field | `running` = currently executing, `idle` = available |
| **T3 Usage Log** | `.optimus/state/t3-usage-log.json` | Invocation counts, success rates per dynamic role |
| **Lock Files** | `.optimus/agents/<name>.lock` | Which agents are currently locked by a running process |

## Status Meanings Reference

| Status | Meaning |
|--------|---------|
| `running` | Task is currently executing in background |
| `completed` | Process exited successfully, output may exist |
| `verified` | Output path confirmed to exist and be non-empty |
| `partial` | Process exited but output is missing or empty |
| `failed` | Task errored out (check `error_message`) |

## Dashboard Format Template

```markdown
## Swarm Task Dashboard

- Total: 18
- Running: 2
- Completed: 3
- Verified: 10
- Partial: 1
- Failed: 2

### Running
- task_... | role: qa-engineer | 4m 12s
- council_... | roles: chief-architect, security | 12m 04s | STALE

### Failed
- task_... | role: dev | error: MCP timeout

### Recent Completions (latest 5)
- task_... | verified | role: pm | #71
- council_... | completed | roles: architect, qa-engineer | #70
```