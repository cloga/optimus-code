---
name: master-onboarding
description: First-run protocol for the Master Agent. Read this BEFORE using any Optimus MCP tools.
---

# Master Agent Onboarding

**When:** Every time you start a new conversation as the Optimus Master Agent.

## Step 1: Read System Instructions

Read `.optimus/config/system-instructions.md` — this is the single source of truth for all rules, artifact routing, format templates, and workflow protocols.

## Step 2: Inspect Your Team

Call `roster_check` with your `workspace_path` to see:
- Available T1 agent instances (resumable sessions)
- Available T2 role templates (project experts)
- Available T3 engines and models (compute backends)
- Available skills

## Step 3: Understand the Workflow

The Optimus SDLC follows a **Problem-First** lifecycle:

1. **PROBLEM** — Frame the problem without prescribing solutions → `.optimus/specs/{date}-{topic}/00-PROBLEM.md`
2. **PROPOSAL** — Experts independently propose solutions → `01-PROPOSAL_{role}.md`
3. **SOLUTION** — Synthesize best ideas → `02-SOLUTION.md`
4. **EXECUTE** — Delegate implementation to dev roles
5. **VERIFY** — QA validates

## Step 4: Know the Critical Rules

- **Always use `_async` variants** for delegation and councils
- **Always call `roster_check` before delegating** — even if you think you know the roster
- **Always pass `parent_issue_number`** when delegating sub-tasks under an epic
- **Never simulate a worker's output** — physically call `delegate_task_async`
- **Never push directly to master** — always go through PR
- **Never busy-poll** `check_task_status` — wait at least 30 seconds between polls

## Step 5: Know Where Things Go

| Artifact | Directory |
|----------|-----------|
| Problem/Proposal/Solution | `specs/{date}-{topic}/` |
| Task output | `results/` |
| Council reviews | `reviews/{timestamp}/` |
| Reports | `reports/` |
| Task descriptions | `tasks/` |

All paths are under `.optimus/`. Use `write_blackboard_artifact` to write files.

## Step 6: Know When to Escalate

Before implementing high-impact changes (schema changes, multi-file refactors, new protocols, security changes), draft a `00-PROBLEM.md` and dispatch an expert council.

## User Memory

Call `get_user_memory` (Copilot: `get_user_memory`, Claude Code: `mcp__spartan-swarm__get_user_memory`) at the start of each conversation before any other work. This loads the user's cross-project preferences and ensures parity with sub-agents.

## Anti-Patterns to Avoid

- **Don't create roles without roster_check** — check if a similar role already exists
- **Don't write PROPOSAL with implementation details** — let experts propose independently
- **Don't ignore council VERDICT** — read both `COUNCIL_SYNTHESIS.md` and `VERDICT.md`
- **Don't skip Issue creation** — every task needs a GitHub Issue for traceability
