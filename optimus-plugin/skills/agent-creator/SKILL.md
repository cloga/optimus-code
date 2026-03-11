---
name: agent-creator
description: Meta-skill that teaches the Master Agent how to select, create, and evolve T2 roles and T1 agents in the Spartan Swarm hierarchy.
---

# Agent Creator (Meta-Skill)

This skill teaches the Master Agent how to manage the T3→T2→T1 agent lifecycle. It is a bootstrap meta-skill — it enables the system to self-evolve its workforce.

## The T3→T2→T1 Hierarchy

| Tier | Location | What It Is | Lifecycle |
|------|----------|-----------|-----------|
| T3 | (none — ephemeral) | Dynamic zero-shot worker. No file, no memory. | Created on-the-fly, disappears after use. |
| T2 | `.optimus/roles/<name>.md` | Role template. Describes **what** the role does, which engine/model to use. | Created on first delegation. Master can update anytime. |
| T1 | `.optimus/agents/<name>.md` | Instance snapshot. Copies from T2 + adds session state. | Created when task completes (session_id captured). Frozen after creation — only session_id updates. |

### Key Invariants
- **T2 ≥ T1**: Every T1 agent MUST have a corresponding T2 template.
- **T1 is frozen**: Once created, T1 body content is never modified by the system. Only `session_id` is updated on subsequent runs.
- **T2 is alive**: Master Agent can update T2 descriptions, engine bindings, and model settings to evolve the team.

## How to Create or Update a Role

### Step 1: Check the Roster
Use `roster_check` with the workspace path. This returns:
- T1 agents (local instances with session state)
- T2 roles (project templates with engine/model bindings)
- T3 engine pool (available engines and models from `available-agents.json`)

### Step 2: Decide the Role

Based on the user's request, determine:
1. **role name**: A hyphenated, descriptive name (e.g., `security-auditor`, `frontend-dev`, `data-engineer`)
2. **role_description**: A clear sentence describing what this role does and its expertise
3. **role_engine**: Which engine from `available-agents.json` (e.g., `claude-code`, `copilot-cli`)
4. **role_model**: Which model (e.g., `claude-opus-4.6-1m`, `gpt-5.4`)

### Step 3: Delegate with Role Info

Pass all structured info in the `delegate_task` or `delegate_task_async` call:

```json
{
  "role": "security-auditor",
  "role_description": "Security auditing expert who reviews code for vulnerabilities, enforces compliance, and prevents data leakage",
  "role_engine": "claude-code",
  "role_model": "claude-opus-4.6-1m",
  "task_description": "Review the authentication module for OWASP Top 10 vulnerabilities...",
  "required_skills": ["git-workflow"],
  "output_path": ".optimus/reports/security-audit.md",
  "workspace_path": "/path/to/project"
}
```

The system will automatically:
- **Create T2** if `.optimus/roles/security-auditor.md` doesn't exist (using your `role_description` and `role_engine`/`role_model`)
- **Update T2** if it exists but you provide new `role_description`/`role_engine`/`role_model` (team evolution)
- **Create T1** after the task completes and a session_id is captured

### Step 4: Evolve the Team

After several delegations, review the roster again. You can:
- Update a role's description to reflect evolved understanding of its purpose
- Switch a role's engine/model if a better option becomes available
- Let underperforming T3 roles die naturally (they never precipitate unless delegated)

## Role Name Conventions

- Use lowercase hyphenated names: `security-auditor`, NOT `SecurityAuditor`
- Be descriptive: `api-integration-specialist`, NOT `dev2`
- Keep names unique per project
- Names can only contain: `[a-zA-Z0-9_-]` (anything else is stripped for safety)

## Engine Selection Guide

When choosing `role_engine` and `role_model`, consider:
- **claude-code**: Best for complex reasoning, code generation, architectural analysis
- **copilot-cli**: Best for quick edits, boilerplate generation, refactoring
- Check `available-agents.json` engines for `status: "demo"` — skip those, they're not implemented

If unsure, **omit `role_engine` and `role_model`** — the system auto-resolves from `available-agents.json` (first non-demo engine + first model), or falls back to `claude-code`.

## Anti-Patterns

- Do NOT create roles with vague names like `helper` or `assistant` — be specific
- Do NOT assign tasks to non-existent roles without providing `role_description` — the T2 template will be nearly empty
- Do NOT manually edit T1 agent files — they are managed by the system
- Do NOT skip `roster_check` before delegating — you might create duplicate roles
- Do NOT hardcode engine/model in task_description — use the dedicated `role_engine`/`role_model` fields
