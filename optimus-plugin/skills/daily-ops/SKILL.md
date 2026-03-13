---
name: daily-ops
description: Autonomous patrol and maintenance decision framework for system stewards. Provides a structured inspection protocol across 7 areas (task health, agent hygiene, VCS hygiene, memory hygiene, role health, release readiness, issue triage) with a decision matrix mapping findings to actions. Use when awakened by Meta-Cron for routine system maintenance.
---

# Daily Operations — Patrol Protocol

You have been triggered by Meta-Cron for a routine system patrol. Your job: inspect the system, decide what (if anything) needs fixing, take limited action, and write a report.

## Decision Framework

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

7. **Issue Triage & Hygiene** — Use `github_update_issue` and `github_sync_board` MCP tools
   The steward scans open Issues and performs automated triage:
   1. Fetch all open Issues via `github_sync_board` or equivalent VCS tool
   2. For any Issue **without** a priority label (`P0`, `P1`, `P2`, `P3`):
      - Read the Issue title and body
      - Assess priority using this matrix:
        - **P0**: System is broken, data loss, security vulnerability
        - **P1**: Major feature broken, significant user impact, blocks other work
        - **P2**: Minor feature issue, workaround exists, non-blocking
        - **P3**: Enhancement, cosmetic, nice-to-have
      - Apply the appropriate priority label via `github_update_issue`
   3. For any Issue **already implemented** (check `git log --oneline --all` for `fixes #N`, `closes #N`, `resolves #N`, or `closed #N` references):
      - Close the Issue via `github_update_issue` with `state: "closed"`
      - Add a comment referencing the implementing commit
   4. For every Issue the steward processes → add the `system-maintained` label
   5. For every comment the steward adds → include `[system-maintained]` tag in the comment body

   **Resilience**: If `github_update_issue` or `github_sync_board` returns an error (e.g., `MethodNotFound`), log the failure in the patrol report and skip Issue Triage. Do NOT fail the entire patrol.

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
| Issue without priority label | Assess and add P0/P1/P2/P3 label via `github_update_issue` | Medium |
| Issue already implemented (commit ref exists) | Close via `github_update_issue` with commit reference | Low |
| Issue processed by steward | Add `system-maintained` label via `github_update_issue` | Low |

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
