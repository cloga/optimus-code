---
name: daily-ops
description: Autonomous patrol and maintenance decision framework for system stewards.
---

# Daily Operations — Patrol Protocol

You have been triggered by Meta-Cron for a routine system patrol.

## Decision Framework

### Phase 1: Observe
Read these blackboard locations:

1. **Task Health** — `.optimus/state/task-manifest.json`
   - Tasks stuck in "running" for > 2 hours
   - Tasks with no heartbeat update for > 30 minutes

2. **Agent Hygiene** — `.optimus/agents/*.md`
   - Agent instances with status "active" but last heartbeat > 1 hour ago
   - Total agent count vs reasonable ceiling (< 20)

3. **VCS Hygiene** — Use `git branch -r --merged master` and `git log`
   - Remote branches already merged to master
   - PRs open for > 7 days with no activity

4. **Memory Hygiene** — `.optimus/memory/continuous-memory.md`
   - Total entry count (flag if > 50 entries)
   - Duplicate or near-duplicate entries

5. **Role Health** — `.optimus/state/t3-usage-log.json`
   - Roles with > 3 consecutive failures (quarantine candidates)

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

### Phase 3: Act
- Execute actions up to your `max_actions` budget (default: 5)
- Prioritize by severity (Medium > Low > Info)
- Info items are report-only

### Phase 4: Report
Write a patrol report to `.optimus/reports/daily-ops-<YYYY-MM-DD>.md` with:
- Date and time of patrol
- Findings per inspection area
- Actions taken (with justification)
- Items deferred (over budget or report-only)
- Recommendations for human review

## Dry-Run Mode
If Meta-Cron indicates dry-run, execute Phases 1-2 only. Write report with "DRY RUN" prefix. Do NOT take any actions.

## Budget Enforcement
Count each discrete action. Stop when budget is reached. Always reserve 1 action slot for writing the report.
