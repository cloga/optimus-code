---
name: daily-ops
description: Autonomous patrol and maintenance decision framework for system stewards. Provides a structured inspection protocol across 8 areas (task health, agent hygiene, VCS hygiene, memory hygiene, role health, release readiness, issue triage, failed task analysis) with a decision matrix mapping findings to actions. Use when awakened by Meta-Cron for routine system maintenance.
---

# Daily Operations — Patrol Protocol

You have been triggered by Meta-Cron for a routine system patrol. Your job: inspect the system, decide what (if anything) needs fixing, take limited action, and write a report.

## Decision Framework

### Phase 0: Previous Patrol Context
Before inspecting the system, check for a previous patrol report to maintain cross-patrol awareness:

1. List files matching `.optimus/reports/daily-ops-YYYY-MM-DD.md` (ISO 8601 date format) and find the most recent one by lexicographic sort of the date portion
2. If a previous report exists, read it and note:
   - Outstanding recommendations from last patrol
   - Items that were "report-only" last time — have they been addressed?
   - Any action items that were deferred due to budget limits
3. If no previous report exists (first patrol), skip this phase
4. Note items from the previous patrol for cross-referencing in Phase 2. In Phase 1, evaluate each area based on current system state — do not skip areas or assume issues are resolved based solely on the previous report.

### Phase 1: Observe
Read the following blackboard locations and note anything anomalous:

1. **Task Health** — `.optimus/state/task-manifest.json`
   - Tasks stuck in "running" for > 2 hours (stale)
   - Tasks with no heartbeat update for > 30 minutes
   - Total active tasks vs capacity

2. **Agent Hygiene** — `.optimus/agents/*.md`
   - Agent instances with status "active" but last heartbeat > 1 hour ago (zombies)
   - Agents with no associated running process
   - Total agent count vs reasonable ceiling (< 20)

3. **VCS Hygiene** — Use `git branch -r --merged master` and `git log`
   - Remote branches already merged to master (stale branches)
   - PRs open for > 7 days with no activity

4. **Memory Hygiene** — `.optimus/memory/continuous-memory.md`
   - Total entry count (flag if > 50 entries — approaching bloat)
   - Duplicate or near-duplicate entries

5. **Role Health** — `.optimus/state/t3-usage-log.json`
   - Roles with 0% success rate over last 5 invocations
   - Roles with > 3 consecutive failures (quarantine candidates)

6. **Release Readiness Assessment** — `git log` and GitHub Issues
   After completing other patrol tasks, check if a new release may be warranted:
   1. Run `git log v<last-tag>..HEAD --oneline` to see commits since last release
      - Use `git describe --tags --abbrev=0` to find the last tag
   2. If 0 commits → skip (nothing to release)
   3. If commits exist, categorize them:
      - P0 bug fixes → flag as "URGENT: P0 fix unreleased"
      - feat commits → count and list
      - docs/chore only → note "cosmetic changes only"
   4. Check release blockers:
      - Any open PRs that should be included?
      - Are README and CHANGELOG up to date?
      - Any open P0/P1 Issues that should be fixed first?
   5. Write findings to `.optimus/reports/release-readiness-<date>.md`
   6. DO NOT trigger a release. Only report. Release decision belongs to PM.

7. **Issue Triage & Hygiene** — Use `vcs_update_work_item` and `vcs_list_work_items` MCP tools
   The steward scans open Issues and performs automated triage:
   1. Fetch all open Issues via `vcs_list_work_items` or equivalent VCS tool
   2. For any Issue **without** a priority label (`P0`, `P1`, `P2`, `P3`):
      - Read the Issue title and body
      - Assess priority using this matrix:
        - **P0**: System is broken, data loss, security vulnerability
        - **P1**: Major feature broken, significant user impact, blocks other work
        - **P2**: Minor feature issue, workaround exists, non-blocking
        - **P3**: Enhancement, cosmetic, nice-to-have
      - Apply the appropriate priority label via `vcs_update_work_item`
   3. For any Issue **already implemented** (check `git log --oneline --all` for `fixes #N`, `closes #N`, `resolves #N`, or `closed #N` references):
      - Close the Issue via `vcs_update_work_item` with `state: "closed"`
      - Add a comment referencing the implementing commit
   4. For every Issue the steward processes → add the `system-maintained` label
   5. For every comment the steward adds → include `[system-maintained]` tag in the comment body

   **Resilience**: If `vcs_update_work_item` or `vcs_list_work_items` returns an error (e.g., `MethodNotFound`), log the failure in the patrol report and skip Issue Triage. Do NOT fail the entire patrol.

8. **Failed Task Analysis** — `.optimus/state/task-manifest.json`
   Scan for tasks with `"status": "failed"` to identify systemic issues:
   1. Read `task-manifest.json` and filter for tasks where `status` is `"failed"`
   2. Only consider tasks that failed within the last 7 days (compare `startTime` epoch ms to current time). If `startTime` is missing, `0`, or `null`, skip that task (treat as outside the 7-day window).
   3. Group failures by root cause category:
      - **Model Error**: `error_message` contains "model" and ("invalid" or "not in the allowed list")
      - **Auth Error**: `error_message` contains "authentication" or "No authentication" or "401" or "403"
      - **Timeout/Startup**: `error_message` contains "timed out", "Watchdog", "failed to start", or "remained pending"
      - **Output Error**: `error_message` contains "ENOENT" or "no such file"
      - **Unknown**: `error_message` is missing or doesn't match above categories
   4. For each category, report: count, affected roles, and a representative error snippet (first 100 chars)
   5. If a specific role has 3+ failures in the last 7 days, flag it as a quarantine candidate (cross-reference with Area 5 Role Health — do NOT double-count)
   6. Exclude tasks that were already flagged and acted upon in Area 1 during this patrol (e.g., stale tasks marked as failed by the steward). Since Phase 1 observation happens before Phase 3 actions, Area 8 captures the pre-action snapshot — but note the overlap in your report if any exist.
   7. This is a **report-only** inspection — do NOT retry, fix, or delete failed tasks

### Phase 2: Decide
Apply this decision matrix:

| Finding | Action | Severity |
|---------|--------|----------|
| Stale task (running > 2h, no heartbeat) | Mark as "failed" in manifest | Low |
| Zombie agent (active, no heartbeat > 1h) | Update agent status to "completed" | Low |
| Merged remote branch | Delete with `git push origin --delete` | Low |
| Role with > 3 consecutive failures | Quarantine via `quarantine_role` tool | Medium |
| Memory > 50 entries | Report only (do not auto-prune) | Info |
| Stale PR (> 7 days, no activity) | Report only (do not auto-close) | Info |
| Unreleased P0 fix on master | Report as URGENT — flag for PM | High |
| Commits since last tag (features) | Report release readiness | Info |
| Issue without priority label | Assess and add P0/P1/P2/P3 label via `vcs_update_work_item` | Medium |
| Issue already implemented (commit ref exists) | Close via `vcs_update_work_item` with commit reference | Low |
| Issue processed by steward | Add `system-maintained` label via `vcs_update_work_item` | Low |
| Deferred action from previous patrol still applicable | Execute if budget allows (counts toward action budget) | Medium |
| Previous recommendation not addressed after 2+ patrols | Escalate in report as recurring issue | Info |
| Failed tasks in last 7 days | Report failure summary by category | Info |

### Phase 3: Act
- Execute actions from the decision matrix, up to your `max_actions` budget (default: 5)
- Prioritize by severity (Medium > Low > Info)
- Info items are report-only — never take action on them

### Phase 4: Report
Write a patrol report to `.optimus/reports/daily-ops-<YYYY-MM-DD>.md` with:
- Date and time of patrol
- Findings per inspection area
- Actions taken (with justification)
- Items deferred (over budget or report-only)
- Recommendations for human review

### Phase 5: Health Log Update
After writing the local patrol report, post a brief one-line summary as a comment on the System Health Log Issue.

1. Read the Health Log Issue number from `.optimus/system/meta-crontab.json` field `health_log_issue`
2. If the field is missing or `null`, skip this phase (Health Log not configured)
3. Compose a one-line summary in one of these formats:
   - `✅ All clear. [actions taken summary]` — no findings or only Info-level items
   - `⚠️ [findings summary]. [actions taken]` — Low/Medium findings with actions taken
   - `🔴 [critical findings]` — High severity findings (e.g., unreleased P0)
4. Post via `vcs_add_comment` with `item_type: "workitem"`, `item_id: <health_log_issue>`, and the summary as `comment`

In Dry-Run mode, still post to the health log but prefix the comment with `DRY RUN: `.

## Dry-Run Mode
If Meta-Cron indicates this is a dry-run (first 3 runs), execute Phases 1-2 only. Write the report with "DRY RUN" prefix. Do NOT take any actions.

## Budget Enforcement
Count each discrete action (delete branch, quarantine role, mark task failed). Stop when budget is reached. Always reserve 1 action slot for writing the report.

## Release Readiness Report Format

When writing release readiness findings, use this format:

```
## Release Readiness Report — <date>
### Commits Since v<last-tag>:
- feat: <N> features
- fix: <N> fixes (P0: <N>)
- docs/chore: <N>

### Blockers:
- [ ] Open P0 Issues: <list or "none">
- [ ] Unmerged PRs: <list or "none">
- [ ] README updated: yes/no
- [ ] CHANGELOG updated: yes/no

### Recommendation:
- 🔴 URGENT patch release (P0 fix unreleased)
- 🟢 Ready for minor release
- 🟡 Wait — blockers exist
- ⚪ No release needed
```
