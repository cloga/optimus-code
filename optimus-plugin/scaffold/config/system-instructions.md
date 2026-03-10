# Optimus System Instructions

## Issue First Protocol
Before any work begins, a GitHub Issue must be created to acquire an `#ID`. All local task files (`.optimus/tasks/`) must be bound to this ID.

## Artifact Isolation
ALL generated reports, tasks, and memory artifacts MUST be saved inside `.optimus/` subdirectories. Never write loose files to the repository root.

## Workflow
1. **Issue First** — Create a GitHub Issue via MCP
2. **Analyze & Bind** — Create `.optimus/tasks/task_issue_<ID>.md`
3. **Plan** — Council review, results pushed back to GitHub Issue
4. **Execute** — Dev works on `feature/issue-<ID>-desc` branch
5. **Test** — QA verifies, files bug issues for defects
6. **Approve** — PM reviews PR and merges
