---
name: project-patrol
description: Structured patrol protocol for the patrol-manager role. Provides a 6-phase inspection framework (Observe, Judge, Diagnose, Act, Track, Report) covering Issues, PRs, branches, tasks, and agent health. Includes a decision matrix mapping findings to direct actions or specialist delegations, and a diagnose-and-re-delegate phase that correlates open Issues with task-manifest records to automatically retry failed tasks with session continuity.
---

# Project Patrol — Patrol Protocol

You have been triggered by Meta-Cron for a system patrol. Your job: observe project health across all dimensions, judge each finding against the decision framework, take direct actions where appropriate, delegate investigations to specialists, and produce a patrol report.

## Phase 1: Observe

Read the following state sources and note anything anomalous:

### 1.1 Open Issues
- Fetch all open Issues via `github_sync_board` or VCS tools
- For each Issue, note: number, title, labels, last activity date
- Cross-reference with `git log --oneline --all` for `fixes #N`, `closes #N`, `resolves #N` references
- Identify: Issues already implemented (commit reference exists), Issues without priority labels, stale Issues (no activity > 30 days)

### 1.2 Open PRs
- Check for open PRs via `git log --remotes` or VCS tools
- For each PR, note: number, title, age, review status
- Identify: PRs approved and ready to merge, PRs stale (> 7 days with no activity), PRs with merge conflicts

### 1.3 Stale Branches
- Run `git branch -r --merged master` to find remote branches already merged to master
- Exclude `origin/master` and `origin/HEAD` from the list
- These are cleanup candidates

### 1.4 Task Manifest
- Read `.optimus/state/task-manifest.json`
- Identify: tasks stuck in "running" for > 2 hours, tasks with "failed" status in the last 7 days, total active task count

### 1.5 Previous Patrol State
- Read `.optimus/state/patrol-ledger.json` (if it exists) for in-flight delegations from previous patrols
- Read the most recent `.optimus/reports/daily-ops-*.md` or `.optimus/reports/cron-hourly-patrol-*.md` for previous findings
- Note any outstanding recommendations from the last patrol

### 1.6 Delta Detection (MANDATORY)

Before proceeding to Phase 2, compare current observations against previous patrol state to identify what is NEW:

1. Read `known_findings` from `.optimus/state/patrol-ledger.json` (if it exists)
2. For each current finding, check if it was already reported in a previous patrol:
   - Match by Issue number for Issue-related findings
   - Match by PR number for PR-related findings
   - Match by branch name for branch-related findings
   - Match by task ID for task-related findings
3. Classify each finding:
   - **NEW**: Not present in previous patrol's known_findings → apply full decision matrix in Phase 2
   - **KNOWN**: Already reported in a previous patrol → report-only, skip action unless status changed
   - **RESOLVED**: Was in known_findings but no longer present → remove from ledger, note in report
4. Update `known_findings` in the ledger at the end of Phase 3 (Act) with all current findings

Schema for `known_findings` in `patrol-ledger.json`:
```json
{
  "known_findings": {
    "implemented_issues": ["#123", "#456"],
    "unlabeled_issues_triaged": ["#789"],
    "stale_prs": ["#101"],
    "stuck_tasks": ["task_xyz"],
    "stale_branches": ["feature/old-branch"],
    "last_patrol_date": "2026-03-15T10:00:00Z"
  }
}
```

This prevents the patrol from reporting and acting on the same findings every cycle. Only genuinely new findings trigger action.

## Phase 2: Judge

Apply this decision framework to each finding:

| Finding | Action | Who | Severity |
|---------|--------|-----|----------|
| Issue verified-implemented (commit ref with `fixes/closes/resolves #N` exists) | Close directly via `github_update_issue` with state: "closed" | Self (depth-1) | Low |
| Issue unimplemented idea/enhancement/investigation | Leave open, add priority label if missing | Self (depth-1) | Info |
| Issue needs investigation (unclear if implemented) | Delegate read-only investigation | Specialist (depth-2) | Medium |
| Issue without priority label | **MANDATORY**: Assess and add P0/P1/P2/P3 label — every unlabeled Issue MUST be triaged | Self (depth-1) | Low |
| PR approved, ready to merge | Merge via `vcs_merge_pr` | Self (depth-1) | Medium |
| PR needs review | Delegate to code-reviewer | Specialist (depth-2) | Medium |
| PR stale (> 7 days, no activity) | Report only | N/A | Info |
| Branch merged to master | Delete via `git push origin --delete <branch>` | Self (depth-1) | Low |
| Task stuck in running (> 2h) | Mark as failed in task manifest | Self (depth-1) | Low |
| Task failed (systemic pattern) | Analyze, delegate fix to specialist | Specialist (depth-2) | Medium |
| Agent zombie (active, no heartbeat > 1h) | Mark as completed | Self (depth-1) | Low |

### CRITICAL RULE: Never Close Unimplemented Ideas
An Issue that describes an unimplemented feature, enhancement request, investigation, or design idea must NEVER be closed — regardless of its age, priority level, or activity. Low priority does not mean "won't do". Only close Issues where a commit with `fixes/closes/resolves #N` is confirmed in the git history.

### Priority Assessment Matrix (for unlabeled Issues)
- **P0**: System is broken, data loss, security vulnerability
- **P1**: Major feature broken, significant user impact, blocks other work
- **P2**: Minor feature issue, workaround exists, non-blocking
- **P3**: Enhancement, cosmetic, nice-to-have

### MANDATORY Actions (Non-Negotiable)

The following actions are MANDATORY on every patrol — not optional, not deferrable:

1. **Issue Triage**: Every unlabeled open Issue MUST be assessed and labeled P0-P3. No exceptions. If you're unsure of priority, default to P2.
2. **Issue Closing**: Every Issue where a `fixes/closes/resolves #N` commit exists in git history MUST be closed with a comment citing the commit SHA. No exceptions.

Failure to perform mandatory actions is a protocol violation. These actions do NOT count against the delegation budget — they are free direct actions.

## Phase 2.5: Diagnose Open Issues

For each open Issue without recent activity (> 7 days), perform task-manifest correlation to determine if the Issue was worked on and what happened:

### Step 1: Find Related Tasks

For each stale open Issue #N:
1. Read `.optimus/state/task-manifest.json` and find all tasks where `github_issue_number === N` or `parent_issue_number === N`
   - The `TaskManifestManager.findTasksByIssue(workspacePath, N)` helper does this lookup
2. If no tasks found, this Issue was never worked on — proceed to Step 2 assessment
3. If tasks found, sort by `startTime` descending (most recent first)

### Step 2: Assess Task Status and Act

| Task Status | Issue State | Action |
|-------------|-------------|--------|
| `verified` | Still open | Close the Issue directly — the fix was delivered but the Issue was not auto-closed (likely missing `fixes #N` in commit message). Comment with the task ID and output_path for traceability. |
| `failed` or `timeout` | Still open | **Re-delegate** with session continuity (see Step 3). The previous attempt failed but the Issue still needs resolution. |
| `running` | Still open | Skip — task is still in progress. Note in report. |
| `awaiting_input` | Still open | Skip — task is blocked on human input. Apply escalation rules from Phase 4. |
| No tasks found | Still open | Issue was never worked on. Assess priority: if P0/P1, delegate to appropriate specialist. If P2/P3, report only. |

### Step 3: Re-delegation with Session Continuity

When re-delegating a failed task, ALWAYS preserve session context:

1. **Find the last agent_id**: Read the most recent task record for this Issue from the manifest. Use its `agent_id` field.
2. **Collect context files**: Include the failed task's `output_path` (if it exists and has content) in `context_files` so the agent can see what went wrong.
3. **Compose the re-delegation**:
   ```
   delegate_task_async(
     role: <same role as the failed task>,
     agent_id: <last task's agent_id>,     // Session continuity
     task_description: "Re-attempt: <original task description>. Previous attempt (task_id: <failed_task_id>) failed with: <error_message>. Diagnose the failure, check if the root cause has been fixed, and re-attempt the implementation.",
     context_files: [<failed task's output_path>, <any other relevant files>],
     parent_issue_number: <the Issue number being resolved>,
     output_path: ".optimus/reports/redelegate_issue_<N>_<date>.md",
     workspace_path: "<project root>"
   )
   ```
4. **Record in patrol ledger**: Add the re-delegation to `delegations` array with `finding: "Re-delegation of failed task <task_id> for Issue #N"`
5. **Budget**: Each re-delegation counts against the delegation budget

### Diagnosis Constraints

- This phase runs AFTER Phase 2 (Judge) and BEFORE Phase 3 (Act)
- Re-delegations count against the same delegation budget as Phase 3 actions
- Direct actions from diagnosis (closing verified Issues) do NOT count against the budget
- Only diagnose Issues that are genuinely stale (> 7 days no activity) — recently active Issues are skipped

## Phase 3: Act

Execute actions from the decision matrix, respecting the following constraints:

### Delegation Budget
- Read `max_delegations` from the crontab entry (default: 3)
- Each delegation to a specialist counts against this budget
- Direct actions (close Issue, delete branch, mark task failed) do NOT count against the delegation budget
- Prioritize by severity: Medium > Low > Info
- Info items are report-only — never take action on them

### Delegation Tracking
For each delegation issued:
1. Record in `.optimus/state/patrol-ledger.json`:
   ```json
   {
     "delegations": [
       {
         "id": "<task_id>",
         "patrol_date": "<ISO date>",
         "role": "<specialist role>",
         "finding": "<what triggered this>",
         "status": "pending",
         "result": null
       }
     ]
   }
   ```
2. Use `delegate_task_async` with `parent_issue_number` set to the cron's tracking Issue

### Action Attribution
- For every Issue the patrol manager processes, add the `system-maintained` label
- For every comment posted, include `[patrol-manager]` tag in the comment body

## Phase 4: Track

Check the patrol ledger for in-flight delegations from previous patrols:
- If a delegation completed since the last patrol: note the result, update ledger entry status to "completed"
- If a delegation is still running: skip (do not re-delegate the same task)
- If a delegation failed: re-delegate (counts against this patrol's budget) or escalate in the report
- If a delegation is `awaiting_input` (waiting for human response): apply escalation rules below

### Escalation Rules for Awaiting-Input Items

When a patrol ledger item has been `awaiting_input` for multiple consecutive patrols, escalate progressively:

| Stale Count | Time (at hourly cron) | Action |
|-------------|----------------------|--------|
| 1-3 patrols | 1-3 hours | Skip — give the human time to respond |
| 4-6 patrols | 4-6 hours | Post a reminder comment on the GitHub Issue: "⏰ Reminder: this question has been waiting for [N] hours" |
| 7-24 patrols | 7-24 hours | Mark as URGENT in the patrol report. Post: "⚠️ URGENT: awaiting human response for [N] hours" |
| 25+ patrols | > 24 hours | **Auto-decide**: Make a safe-default decision autonomously. Post: "[AUTO-DECIDED] Human did not respond within 24 hours. System chose: [decision]. Override by commenting on this issue." Update ledger status to "auto-decided" |

### Auto-Decision Guidelines

When auto-deciding after 24 hours of no human response:
- **PR waiting for merge decision** → Do NOT merge. Close the PR with comment "Auto-closed: no human approval within 24h. Reopen if needed."
- **Issue needs product direction** → Label as P3 (lowest priority) and skip. Do not close.
- **Failed task needs retry decision** → Retry once with default parameters. If retry fails, mark as "abandoned" in ledger.
- **Ambiguous investigation** → Close the investigation delegation and log the ambiguity in the patrol report for future reference.
- **Destructive action (delete, close)** → Do NOT auto-execute destructive actions. Only non-destructive defaults are allowed.

### Human-in-the-Loop Integration

When the patrol-manager determines a finding requires human judgment:
1. Call `request_human_input` with:
   - `question`: Clear, specific question with options if possible
   - `context_summary`: What the patrol found and why human input is needed
2. Record the awaiting_input state in patrol-ledger.json
3. Continue processing other findings (do not block on human response)
4. Track the response status in subsequent patrols via the escalation rules above

## Phase 5: Report

### 5.1 Write Patrol Report
Write a patrol report to `.optimus/reports/cron-hourly-patrol-<YYYY-MM-DD>.md` with:
- Date and time of patrol
- Summary of findings per observation area (1.1–1.5)
- Actions taken with justification
- Delegations issued (role, task, finding)
- Items deferred (over budget or report-only)
- Recommendations for human review
- Status of previous patrol's delegations

### 5.2 Post Health Summary
Post a one-line health summary as a comment on the Health Log Issue:

1. Read `health_log_issue` from `.optimus/system/meta-crontab.json`
2. If missing or null, skip this step
3. Compose summary in one of these formats:
   - `✅ All clear. [actions taken summary]` — no findings or only Info-level items
   - `⚠️ [findings summary]. [actions taken]` — Low/Medium findings with actions taken
   - `🔴 [critical findings]` — High severity findings
4. Post via `vcs_add_comment` with `item_type: "workitem"`, `item_id: <health_log_issue>`

## Budget Enforcement
Count each discrete action (delete branch, close Issue, merge PR, mark task failed). Stop when the `max_actions` budget is reached. Always reserve 1 action slot for writing the report.

## Dry-Run Mode
If Meta-Cron indicates this is a dry-run (dry_run_remaining > 0), execute Phases 1-2 only. Write the report with "DRY RUN" prefix. Do NOT take any actions or delegations.
