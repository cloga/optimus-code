---
name: role-creator
description: Teaches the Master Agent how to build, select, and evolve the agent team. Use whenever you need to create a new role, pick a specialist for delegation, improve an underperforming agent, assign engine/model bindings, or figure out why a delegate_task failed due to weak role context. Also use when the user says "find someone to do X", "we need an expert for Y", or "who can handle Z".
---

# Role Creator

You are building and managing a team of specialized AI agents. Each role you
create becomes a persistent member of the project's workforce. The quality of
the role description directly determines how well the agent performs — a thin
description produces a thin agent. Think of it like writing a job posting: the
best hires come from the clearest job descriptions.

## When to use this skill

- Creating a new role for the first time
- Selecting an existing role for a delegation
- Improving a role that produced poor results
- Troubleshooting a `delegate_task` failure caused by missing context
- Reviewing the roster to see who's available

## Core Process

**1. Inspect the Roster**

Call `roster_check` before every delegation. It returns:
- T1 agents: instances with session history (project memory)
- T2 roles: reusable templates with engine/model bindings
- Engine/model pool: what compute is available

Prefer T1 agents over T2 roles — they carry project context from prior tasks.
Prefer T2 roles over inventing new T3 names — existing roles already have
tested descriptions.

**2. Select or Create the Role**

Match the task to the roster:
- **T1 match found**: Use it. The agent knows the project.
- **T2 match found**: Use it. The template is already written.
- **No match**: Create a new role with a descriptive hyphenated name.

Naming matters because it shapes the agent's self-concept:

```
❌  helper, assistant, dev2, worker
✅  data-pipeline-engineer, api-security-auditor, react-frontend-dev
```

Characters allowed: `[a-zA-Z0-9_-]`. Everything else gets stripped.

**3. Write the Role Description**

The `role_description` becomes the agent's persona. It is the single biggest
lever for quality. Structure it like this:

```
{Role title} responsible for {domain}.

Core Responsibilities:
- {action with deliverable}
- {action with deliverable}
- {action with deliverable}

Quality Standards:
- {what success looks like}
- {boundaries and constraints}
```

Side-by-side comparison:

```
❌  "A developer who writes code"

✅  "Backend Developer specializing in Node.js API development.

     Core Responsibilities:
     - Implement REST endpoints following existing router patterns
     - Write integration tests for happy paths and error cases
     - Use parameterized queries for all database access
     - Follow Conventional Commits and create PRs via git-workflow

     Quality Standards:
     - Code must build cleanly before PR creation
     - Error responses include actionable messages, not generic 500s"
```

The good version gives the agent concrete behaviors to follow. The bad version
leaves everything to chance.

**4. Delegate**

Pass all structured info in a single call:

```json
{
  "role": "backend-dev",
  "role_description": "<rich description from step 3>",
  "role_engine": "claude-code",
  "task_description": "<the specific work to do>",
  "required_skills": ["git-workflow"],
  "output_path": ".optimus/reports/<output>.md",
  "workspace_path": "<project root>"
}
```

Omit `role_model` to let the system pick the best available. Only specify it
when you have a reason to use a non-default model.

## Evolution

Roles are living documents — they improve over time:

- **After a poor result**: Read the output, identify what context was missing,
  and re-delegate with an enriched `role_description`. The system updates the
  T2 template automatically.
- **After a great result**: The agent's session is captured as a T1 instance.
  Next time, it resumes with full conversation history.
- **Periodically**: Review the roster. Retire roles that never get used. Merge
  roles that overlap.

## Pitfalls to avoid

- **Thin descriptions** — A one-liner generates an agent that doesn't know what
  it's supposed to do. Always provide 3-5 specific responsibilities.
- **Skipping roster_check** — You'll create duplicates or miss agents that
  already have project context from prior work.
- **Invalid models** — Only use models from `available-agents.json`. Unknown
  models get rejected by the pre-flight check.
- **Editing T1 files directly** — Agent instances in `.optimus/agents/` are
  system-managed. To change behavior, update the T2 role instead.
