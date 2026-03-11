# Optimus System Instructions

> These rules apply to ALL projects using the Optimus Spartan Swarm.

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

## Strict Delegation Protocol (Anti-Simulation)
Roles are strictly bounded within the Spartan Swarm to prevent hallucinations:
- **Orchestrator (Master)**: MUST physically invoke the `delegate_task` or `dispatch_council` MCP tool when delegating. **NEVER** simulate a worker's response in plain text, and **NEVER** write ad-hoc scripts to play the role of a subordinate.
- **Worker/Expert (T1/T2/T3)**: Execute the exact task autonomously from your delegated perspective. Do not attempt to orchestrate, spawn other agents, or assume another persona's duties.

## Self-Evolving Agent Lifecycle (T3→T2→T1)

The system uses a three-tier agent hierarchy that evolves automatically:

| Tier | Location | What It Is | Created By |
|------|----------|-----------|------------|
| **T3** | *(ephemeral)* | Zero-shot dynamic worker, no file | Master Agent names it |
| **T2** | `.optimus/roles/<name>.md` | Role template with engine/model binding | Auto-precipitated on first delegation, Master can evolve |
| **T1** | `.optimus/agents/<name>.md` | Frozen instance snapshot + session state | Auto-created when task completes with session_id |

### Key Invariants
- **T2 ≥ T1**: Every T1 agent instance MUST have a corresponding T2 role template.
- **T1 is frozen**: Once created, T1 body content is never modified. Only `session_id` updates on re-use.
- **T2 is alive**: Master Agent can update T2 descriptions, engine bindings, and model settings to evolve the team.
- **No pre-installed roles**: The system starts with zero roles/agents. Everything is created dynamically.

### Delegation Pre-Flight Pipeline

When delegating a task, the Master Agent should follow this sequence:

1. **`roster_check`** — See available T1 agents, T2 roles, T3 engines, and skills
2. **Select role** — Choose existing or invent new role name (use `agent-creator` meta-skill for guidance)
3. **Provide structured role info** — Pass `role_description`, `role_engine`, `role_model` in `delegate_task`
4. **Check skills** — Specify `required_skills`. Missing skills → create them first via `skill-creator`
5. **Delegate** — Use `delegate_task_async` (preferred) or `delegate_task`
6. **System auto-handles**:
   - T3 first use → creates T2 role template (with Master's description/engine/model)
   - Task completes with session_id → creates T1 instance from T2

## Skill System

Skills are domain-specific instruction manuals stored at `.optimus/skills/<name>/SKILL.md`.
They teach agents **how to use specific MCP tools or follow specific workflows**.

### Skill Pre-Flight
If `required_skills` is specified in `delegate_task`, the system verifies all skills exist before execution.
Missing skills cause rejection with an actionable error — Master must create them first.

### Bootstrap Meta-Skills

Two meta-skills are pre-installed to enable self-evolution:

| Skill | Purpose |
|-------|--------|
| 🧬 `agent-creator` | Teaches Master how to build & evolve the team (T3→T2→T1 lifecycle, engine selection) |
| 🧬 `skill-creator` | Teaches agents how to create new SKILL.md files |

### Creating a Missing Skill

1. Delegate to any role with `required_skills: ["skill-creator"]`
2. Task description: explain what the new skill should teach
3. The agent reads `skill-creator` SKILL.md, learns the format, and writes the new skill
4. Retry the original delegation — skill pre-flight now passes

## Engine/Model Resolution

When delegating, engine and model are resolved in priority order:
1. Master-provided `role_engine` / `role_model` (highest priority)
2. T2 role frontmatter `engine` / `model`
3. `available-agents.json` (first non-demo engine + first model)
4. Hardcoded fallback: `claude-code`

## GitHub Auto-Tagging
All Issues and PRs created via MCP tools are automatically tagged with `[Optimus]` prefix and `optimus-bot` label for traceability.
