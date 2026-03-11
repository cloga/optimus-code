---
name: agent-creator
description: Meta-skill that teaches the Master Agent how to select, create, and evolve T2 roles and T1 agents in the Spartan Swarm hierarchy.
---

# Agent Creator (Meta-Skill)

<description>
This skill activates when the Master Agent needs to manage the T3→T2→T1 agent lifecycle. It enables the system to self-evolve its workforce by creating, updating, and optimizing specialized agent roles. Triggers include requests to create new agents, delegate tasks to non-existent roles, or optimize the agent team composition.
</description>

<workflow>
### Step 1: Roster Inspection
- **Tool**: `roster_check`
- **Parameters**:
  - `workspace_path`: The current project workspace path
- **Action**: Mandatory first step to retrieve the current agent roster. Returns T1 agents (local instances with session state), T2 roles (project templates with engine/model bindings), and T3 engine pool (available engines and models from `available-agents.json`). Never skip this step even if you think you know the roster.

### Step 2: Role Analysis and Selection
- **Tool**: None (analysis step)
- **Parameters**: N/A
- **Action**: Based on the user's task request and roster data, determine the appropriate role using this priority order:
  - **T1 Priority (Local Project Experts)**: If the task requires deep domain knowledge of this specific project and a matching T1 Expert exists, use them first.
  - **T2 Priority (Project Roles)**: For general architectural, security, or universal pattern tasks where a T2 Role exists.
  - **T3 Fallback (Dynamic Outsourcing)**: If no suitable specialist exists, invent a highly descriptive, hyphenated role name (e.g., `webgl-shader-guru`, `api-integration-specialist`).

### Step 3: Role Definition and Structuring
- **Tool**: None (preparation step)
- **Parameters**: N/A
- **Action**: Prepare structured role information including:
  - `role`: Hyphenated, descriptive name using only `[a-zA-Z0-9_-]` characters
  - `role_description`: Clear sentence describing expertise and responsibilities
  - `role_engine`: Engine selection from available options (`claude-code` for complex reasoning, `copilot-cli` for quick edits)
  - `role_model`: Specific model version (omit to let system auto-resolve)
  - Ensure names are unique per project and descriptive rather than generic

### Step 4: Role Deployment
- **Tool**: `delegate_task_async` or `delegate_task`
- **Parameters**:
  - `role`: The determined role name
  - `role_description`: Expert capabilities and domain
  - `role_engine`: Selected engine (optional - system resolves if omitted)
  - `role_model`: Selected model (optional - system resolves if omitted)
  - `task_description`: The specific task to execute
  - `required_skills`: Array of skill names needed
  - `output_path`: Where results should be saved
  - `workspace_path`: Current project path
- **Action**: Dispatch the task with complete role information. The system will automatically create T2 templates for new roles, update existing ones if different info provided, and create T1 instances upon task completion.

### Step 5: Team Evolution and Optimization
- **Tool**: Periodic roster review using `roster_check`
- **Parameters**:
  - `workspace_path`: Current project path
- **Action**: After several delegations, review roster performance and optimize:
  - Update role descriptions to reflect evolved understanding
  - Switch engines/models for better performance
  - Allow underperforming T3 roles to expire naturally
  - Document team composition changes
</workflow>

<error_handling>
- If `roster_check` fails or returns empty data, THEN verify workspace path and retry. If persistent, proceed with T3 role creation but document the limitation.
- If role name validation fails (invalid characters), THEN sanitize by converting to lowercase and replacing invalid characters with hyphens.
- If `delegate_task_async` fails with role creation error, THEN retry with simplified role description or fallback to manual T2 role file creation.
- If engine/model selection fails, THEN remove `role_engine`/`role_model` parameters and let system auto-resolve from `available-agents.json`.
</error_handling>

<anti_patterns>
- Do not create roles with vague names like `helper` or `assistant` — be specific about domain expertise.
- Do not assign tasks to non-existent roles without providing comprehensive `role_description` — the T2 template will be inadequate.
- Do not manually edit T1 agent files — they are system-managed and frozen after creation.
- Do not skip `roster_check` before delegating — you might create duplicate or conflicting roles.
- Do not hardcode engine/model in task_description — use the dedicated `role_engine`/`role_model` fields.
- Do not create overly narrow roles that can only handle one specific task — design for reasonable reusability.
- Do not assume roles exist without verification — always check the roster first.
</anti_patterns>

## The T3→T2→T1 Hierarchy Reference

| Tier | Location | What It Is | Lifecycle |
|------|----------|-----------|-----------|
| T3 | (none — ephemeral) | Dynamic zero-shot worker. No file, no memory. | Created on-the-fly, disappears after use. |
| T2 | `.optimus/roles/<name>.md` | Role template. Describes **what** the role does, which engine/model to use. | Created on first delegation. Master can update anytime. |
| T1 | `.optimus/agents/<name>.md` | Instance snapshot. Copies from T2 + adds session state. | Created when task completes (session_id captured). Frozen after creation — only session_id updates. |

### Key Invariants
- **T2 ≥ T1**: Every T1 agent MUST have a corresponding T2 template.
- **T1 is frozen**: Once created, T1 body content is never modified by the system. Only `session_id` is updated on subsequent runs.
- **T2 is alive**: Master Agent can update T2 descriptions, engine bindings, and model settings to evolve the team.

## Engine Selection Guide

When choosing `role_engine` and `role_model`, consider:
- **claude-code**: Best for complex reasoning, code generation, architectural analysis
- **copilot-cli**: Best for quick edits, boilerplate generation, refactoring
- Check `available-agents.json` engines for `status: "demo"` — skip those, they're not implemented

If unsure, **omit `role_engine` and `role_model`** — the system auto-resolves from `available-agents.json` (first non-demo engine + first model), or falls back to `claude-code`.