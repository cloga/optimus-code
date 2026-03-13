---
name: project-patrol
description: Structured patrol protocol for the patrol-manager role. Provides a 5-phase inspection framework (Observe, Judge, Act, Track, Report) covering Issues, PRs, branches, tasks, and agent health. Includes a decision matrix mapping findings to direct actions or specialist delegations.
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

## Phase 2: Judge

Apply this decision framework to each finding:

| Finding | Action | Who | Severity |
|---------|--------|-----|----------|
| Issue verified-implemented (commit ref with `fixes/closes/resolves #N` exists) | Close directly via `github_update_issue` with state: "closed" | Self (depth-1) | Low |
| Issue unimplemented idea/enhancement/investigation | Leave open, add priority label if missing | Self (depth-1) | Info |
| Issue needs investigation (unclear if implemented) | Delegate read-only investigation | Specialist (depth-2) | Medium |
| Issue without priority label | Assess and add P0/P1/P2/P3 label | Self (depth-1) | Low |
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
