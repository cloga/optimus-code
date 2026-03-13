---
name: delegate-task
description: Dispatches a task to a specialized agent role using async-first, non-blocking delegation via the Spartan Swarm.
---

# Delegate Task (The Spartan Dispatch)

This skill activates when the user asks to assign a specific task to an agent, delegate work, or spawn a specialized worker.

## Core Rule: Async-First, Non-Blocking Delegation

All delegation MUST use `delegate_task_async` by default. This is a **hard rule**, not a preference.

- **Default**: `delegate_task_async` — fire-and-forget background dispatch.
- **Exception**: `delegate_task` (synchronous) ONLY if the user explicitly requests blocking/synchronous execution.
- After dispatching async, you MUST NOT block, loop, sleep, or poll in a tight wait. Inform the user the task is running in the background and continue productive work.

## The Spartan Swarm Pre-Dispatch Doctrine

Before randomly creating and assigning roles, you MUST act as the strategic commander and execute this strict pipeline:

### Step 1: Camp Inspection

You cannot command an army blindly.

**Action:** Use your available roster inspection tool (e.g., `roster_check`) with the current `workspace_path` to retrieve the list of currently registered personnel in your Swarm.

*Note: Do not skip this step even if you think you know the roster.*

### Step 2: Manpower Assessment

Analyze the user's task request against the roster you just retrieved. Follow the `role-creator` meta-skill for detailed guidance on role selection and creation.

* **T1 Priority (Local Project Experts)**: If the task requires deep domain knowledge of this specific project, and there is a matching T1 Expert, they MUST be your first choice.
* **T2 Priority (Project Roles)**: If it's a general architectural, security, or universal pattern task, and a T2 Role exists, use them.
* **T3 Fallback (Dynamic Outsourcing)**: If the roster lacks a suitable specialist, invent a highly descriptive, hyphenated role name (e.g., `webgl-shader-guru`). The system will auto-create a T2 template on first use.

For **new or existing roles**, prepare structured role info:
- `role_description`: What this role does and its expertise (used to generate/update the T2 template)
- `role_engine`: Which engine to use — check the roster's Engine & Model Spec section (e.g., `claude-code`, `copilot-cli`)
- `role_model`: Which model (e.g., `claude-opus-4.6-1m`). Omit to let the system auto-resolve.

### Step 2.1: Role Contextualization & Enrichment (Hard Constraint)

Before delegating, you MUST evaluate if the current role description is sufficiently deep for the specific task at hand. 
*Zero-shot or basic templates are often too thin to handle complex enterprise requirements.*

**Action:** 
1. If delegating to an existing T2 role (e.g., `.optimus/roles/security.md`), **read the role file first**.
2. If the current description lacks specific context, rules, or domain knowledge required for the current task (e.g., it only says "Security Engineer" but lacks ADO integration context), you **MUST** physically edit and enrich the `.optimus/roles/<name>.md` file using an edit tool before dispatching.
3. Inject task-specific standard operating procedures (SOPs), relevant API constraints, codebase conventions, and detailed responsibilities into the role file so the agent starts with a robust baseline prompt. Do NOT rely solely on `task_description` to provide context.

### Step 2.5: Skill Check

Check which skills the role needs to execute the task. Look at the roster's **Available Skills** section.

- If the role needs a skill that **exists** → add it to `required_skills`
- If the role needs a skill that **does NOT exist** → first delegate a `skill-creator` to create it (using `required_skills: ["skill-creator"]`), then retry

### Step 3: Deployment

Once you have determined the exact `role` name from Step 2, summarize your decision clearly to the user (e.g., *"I am delegating this to our T2 chief-architect..."*).

**Action:** Use `delegate_task_async` to dispatch with all structured info:

```json
{
  "role": "security-auditor",
  "role_description": "Security auditing expert who reviews code for vulnerabilities",
  "role_engine": "claude-code",
  "role_model": "claude-opus-4.6-1m",
  "task_description": "Review the auth module for OWASP Top 10...",
  "required_skills": ["git-workflow"],
  "output_path": ".optimus/reports/security-audit.md",
  "workspace_path": "/path/to/project",
  "context_files": ["src/auth/handler.ts"]
}
```

The tool will return a `taskId`. After dispatch:

1. **Inform the user** that the task is now running asynchronously in the background.
2. **Continue other productive work** — do not wait idle.
3. Use `check_task_status` only when progress needs to be checked or the user asks for an update.
4. Once the task is marked `completed`, read the output path file to collect results.

### Step 4: Non-Blocking Follow-Up

After dispatching, your responsibilities are:

1. **Report dispatch success** — Tell the user the task was dispatched, which role is handling it, and the taskId.
2. **Continue working** — If there are other pending tasks, context to gather, or questions to address, do those now.
3. **Check on demand** — Use `check_task_status` with the `taskId` when the user asks for progress, or when you need the result to proceed with a dependent task.
4. **Collect results** — Once `check_task_status` reports `completed`, read the output artifact from the `output_path` and present or act on the results.

This mirrors the non-blocking pattern used in the `council-review` skill (see Step 3: Non-Blocking Status Check and Result Collection).

## Anti-Patterns

The following behaviors are **strictly prohibited**:

- **Do NOT use synchronous `delegate_task`** unless the user explicitly requests blocking execution.
- **Do NOT enter a wait/sleep/poll loop** after async dispatch. No `while (!done)` behavior, no repeated immediate `check_task_status` calls, no artificial delays.
- **Do NOT simulate or narrate worker output yourself.** The delegated worker produces its own output artifact. Never fabricate, predict, or role-play what the worker would say.
- **Do NOT block the conversation** waiting for a background task to finish. The user's session must remain responsive.

## Failure Handling

If `delegate_task_async` or `delegate_task` returns an error or the task fails, DO NOT give up. Immediately analyze the stdout/stderr trace, formulate a fix, and retry the delegation, or fall back to doing the work manually.

## Synchronous Execution (Fallback ONLY)

**CRITICAL RULE**: You MUST use the async tool (delegate_task_async) by default. The synchronous delegate_task tool is strictly placed at the very end of your priority list and should ONLY be used if the user **explicitly and specifically requests** blocking/synchronous execution. Otherwise, always default to async-first non-blocking delegation.