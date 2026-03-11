# Optimus System Instructions

---

# Part 1: System-Level Constraints (Universal)

> These rules apply to ALL projects using the Optimus Spartan Swarm. They are shipped via `optimus init` and must NOT be modified per-project.

## Issue First Protocol
Before any work begins, a VCS Work Item must be created to acquire an `#ID`. All local task files (`.optimus/tasks/`) must be bound to this ID.

## Artifact Isolation
ALL generated reports, tasks, and memory artifacts MUST be saved inside `.optimus/` subdirectories. Never write loose files to the repository root.

## Workflow
1. **Issue First** — Create a VCS Work Item via MCP (`vcs_create_work_item`)
2. **Analyze & Bind** — Create `.optimus/tasks/task_issue_<ID>.md`
3. **Plan** — Council review, results pushed back to VCS Work Item
4. **Execute** — Dev works on `feature/issue-<ID>-desc` branch
5. **Test** — QA verifies, files bug work items for defects
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

## VCS Auto-Tagging
All Work Items and PRs created via MCP tools are automatically tagged with `[Optimus]` prefix and `optimus-bot` label for traceability across both GitHub and Azure DevOps platforms.

---

# Part 2: Project-Specific Constraints (Optimus Code Repository)

> These rules are specific to the `optimus-code` repository itself. They do NOT ship to end-users via `optimus init`.

## Dual-Codebase Architecture

This repository contains **two intertwined codebases**:

| Layer | Path | Purpose |
|-------|------|---------|
| **Host project** | Root (`src/`, `docs/`, `.optimus/`) | The Optimus orchestrator's own development workspace |
| **Plugin package** | `optimus-plugin/` | The npm-publishable MCP server plugin that ships to end-users |

## Development & Reload Constraints (Hard Rule)
When making any code modifications to the Optimus project itself (e.g., `src/`, `optimus-plugin/`, or MCP server logic):
1. **Agent MUST Build**: The agent must automatically run the build command (`cd optimus-plugin && npm run build`) after modifications.
2. **Prompt User to Reload**: After a successful build, the agent **MUST explicitly and clearly prompt the user** to execute the "Developer: Reload Window" command in VS Code, as this is strictly required for the new MCP server binary to be loaded.

### Impact Rule: When making changes, ALWAYS evaluate whether the change should propagate to the plugin.

| Change Type | Apply to `.optimus/` (host) | Also apply to `optimus-plugin/` (packaging) |
|---|---|---|
| System instructions update | ✅ `.optimus/config/system-instructions.md` | ✅ `optimus-plugin/scaffold/config/system-instructions.md` |
| New/updated skill | ✅ `.optimus/skills/<name>/SKILL.md` | ✅ `optimus-plugin/skills/<name>/SKILL.md` |
| Config change (`available-agents.json`) | ✅ `.optimus/config/` | ✅ `optimus-plugin/scaffold/config/` |
| New T2 role (project-specific, e.g., `marketing`) | ✅ `.optimus/roles/` | ❌ NOT packaged — project-specific |
| T1 agent instance | ✅ `.optimus/agents/` | ❌ NEVER packaged — instance state |
| MCP server code change | N/A | ✅ `src/mcp/` → `optimus-plugin/dist/` (rebuild required) |
| init.js / CLI change | N/A | ✅ `optimus-plugin/bin/` |

### Build & Publish Checklist
After modifying plugin-relevant files:
1. `cd optimus-plugin && npm run build` — rebuild `dist/mcp-server.js`
2. Verify `optimus-plugin/scaffold/` contains the latest config and instructions
3. Verify `optimus-plugin/skills/` contains only universal bootstrap skills (not project-specific ones)
4. `git push origin master` — end-users pull via `npx -y github:cloga/optimus-code`

### What MUST NOT Ship in the Plugin
- `.optimus/roles/` — Project-specific T2 role templates (auto-generated at runtime)
- `.optimus/agents/` — T1 instance snapshots (workspace-local)
- `.optimus/state/` — Task manifests, T3 usage logs
- `.optimus/reports/`, `.optimus/reviews/` — Generated artifacts
- `.env` — Contains secrets
