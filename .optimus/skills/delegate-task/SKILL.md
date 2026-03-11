---
name: delegate-task
description: Dispatches a task to a specialized agent role using async-first, non-blocking delegation via the Spartan Swarm.
---

# Delegate Task (The Spartan Dispatch)

<description>
This skill activates when the user asks to assign a specific task to an agent, delegate work, or spawn a specialized worker. It implements async-first, non-blocking delegation using the Spartan Swarm architecture to maintain session responsiveness while enabling parallel work execution. Triggers include direct delegation requests, task assignment commands, or when specialized expertise is needed for a specific task.
</description>

<workflow>
### Step 1: Camp Inspection (Roster Check)
- **Tool**: `roster_check`
- **Parameters**:
  - `workspace_path`: The current project workspace path
- **Action**: Mandatory first step to retrieve the list of currently registered personnel in your Swarm. Returns T1 agents (local instances), T2 roles (project templates), T3 engine pool (available engines and models), and available skills. Never skip this step even if you think you know the roster.

### Step 2: Manpower Assessment (Role Selection)
- **Tool**: None (analysis step)
- **Parameters**: N/A
- **Action**: Analyze the user's task request against the retrieved roster using priority order:
  - **T1 Priority**: If task requires deep domain knowledge of this specific project and matching T1 Expert exists, choose them first
  - **T2 Priority**: For general architectural, security, or universal pattern tasks where T2 Role exists
  - **T3 Fallback**: If roster lacks suitable specialist, invent highly descriptive, hyphenated role name (e.g., `webgl-shader-guru`)

### Step 3: Role Contextualization and Enrichment
- **Tool**: File reading and editing capabilities
- **Parameters**:
  - `file_path`: `.optimus/roles/<role_name>.md` (if existing role)
  - `content`: Enhanced role description with task-specific context
- **Action**: Mandatory evaluation of role depth. If delegating to existing T2 role, read the role file first. If current description lacks specific context, rules, or domain knowledge for the current task, physically edit and enrich the role file with task-specific SOPs, API constraints, codebase conventions, and detailed responsibilities.

### Step 4: Skill Verification
- **Tool**: Check against roster's Available Skills section
- **Parameters**:
  - `required_skills`: Array of skill names needed for the task
- **Action**: Verify the role has necessary skills to execute the task:
  - If skill exists → add to `required_skills` parameter
  - If skill does NOT exist → first delegate to `skill-creator` to create it, then retry original delegation

### Step 5: Task Deployment (Async-First)
- **Tool**: `delegate_task_async`
- **Parameters**:
  - `role`: The determined role name from assessment
  - `role_description`: Expert capabilities and domain knowledge
  - `role_engine`: Selected engine (e.g., `claude-code`, `copilot-cli`) - optional
  - `role_model`: Selected model version - optional
  - `task_description`: Specific task to execute
  - `required_skills`: Array of verified skill names
  - `output_path`: Where results should be saved
  - `workspace_path`: Current project path
  - `context_files`: Relevant source files (optional)
- **Action**: Dispatch using async tool (fire-and-forget background execution). Summarize decision to user clearly before dispatching. The tool returns a taskId for tracking.

### Step 6: Non-Blocking Follow-Up
- **Tool**: `check_task_status`
- **Parameters**:
  - `taskId`: The task ID returned from delegate_task_async
- **Action**: After dispatch, inform user task is running asynchronously in background and provide taskId. Continue other productive work - do not wait idle. Use check_task_status only when progress needs checking or user asks for update. Once marked 'completed', read output artifact and present results.
</workflow>

<error_handling>
- If `roster_check` fails, THEN proceed with T3 role creation using descriptive names, but document the roster access limitation.
- If `delegate_task_async` returns error, THEN analyze the stdout/stderr trace, formulate fix, and retry delegation or fallback to manual work execution.
- If role file reading fails during contextualization, THEN proceed with basic role_description but note the limitation in task_description.
- If skill verification fails, THEN remove problematic skills from required_skills and document which skills were skipped.
- If task status checking fails, THEN provide manual instructions for checking output files directly.
</error_handling>

<anti_patterns>
- Do not use synchronous `delegate_task` unless user explicitly requests blocking execution — async-first is mandatory.
- Do not enter wait/sleep/poll loops after async dispatch — no tight polling, no repeated immediate status checks.
- Do not simulate or narrate worker output yourself — the delegated worker produces its own output artifact.
- Do not block the conversation waiting for background task completion — maintain session responsiveness.
- Do not skip roster inspection even if you think you know the available agents.
- Do not rely solely on task_description for context — enrich role files with task-specific knowledge.
- Do not create generic role names like "helper" or "assistant" — be specific about domain expertise.
- Do not fabricate, predict, or role-play what the worker would produce.
</anti_patterns>

## Core Rule: Async-First, Non-Blocking Delegation

All delegation MUST use `delegate_task_async` by default. This is a **hard rule**, not a preference.

- **Default**: `delegate_task_async` — fire-and-forget background dispatch
- **Exception**: `delegate_task` (synchronous) ONLY if user explicitly requests blocking/synchronous execution
- After dispatching async, you MUST NOT block, loop, sleep, or poll in a tight wait

## Role Structure Requirements

For new or existing roles, prepare structured role information:

- `role_description`: What this role does and its expertise (used to generate/update the T2 template)
- `role_engine`: Which engine to use from roster's Engine & Model Spec section
- `role_model`: Which model version (omit to let system auto-resolve)

## Synchronous Execution Rule

**CRITICAL**: You MUST use `delegate_task_async` by default. The synchronous `delegate_task` tool should ONLY be used if the user explicitly and specifically requests blocking/synchronous execution. Always default to async-first, non-blocking delegation.