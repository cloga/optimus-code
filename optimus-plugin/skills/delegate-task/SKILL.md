# Delegate Task (The Spartan Dispatch)

This skill activates when the user asks to assign a specific task to an agent, delegate work, or spawn a specialized worker.

## The Spartan Swarm Pre-Dispatch Doctrine

Before randomly creating and assigning roles, you MUST act as the strategic commander and execute this strict 3-step pipeline:

### Step 1: Camp Inspection
You cannot command an army blindly. 
**Action:** Use the MCP tool `roster_check` with the current `workspace_path` to retrieve the list of currently registered personnel in your Swarm.
*Note: Do not skip this step even if you think you know the roster.*

### Step 2: Manpower Assessment
Analyze the user's task request against the roster you just retrieved.
* **T1 Priority (Local Project Experts)**: If the task requires deep domain knowledge of this specific project (e.g., custom framework rules), and there is a matching T1 Expert, they MUST be your first choice.
* **T2 Priority (Global Regulars)**: If it's a general architectural, security, or universal pattern task, and a T2 Agent exists (e.g., `chief-architect`), use them.
* **T3 Fallback (Dynamic Outsourcing)**: If the roster lacks a suitable specialist for a highly niche problem (e.g., "Write an obscure WebGL shader"), you are authorized to invent a highly descriptive, hyphenated role name (e.g., `webgl-shader-guru`). The swarm engine will automatically generate a T3 Zero-Shot worker for you.

### Step 3: Deployment
Once you have determined the exact `role` name from Step 2, summarize your decision clearly to the user (e.g., *"I am delegating this to our T2 chief-architect..."*).
**Action:** Use the MCP tool `delegate_task_async` (preferred over synchronous `delegate_task`) to dispatch the decided `role`, an exhaustively detailed `task_description`, and the designated `output_path` (an artifact inside `.optimus/` usually). 
If using `delegate_task_async`, loop and check status via `check_task_status` until it is marked completed, and then read the output path file.

## Failure Handling
If `delegate_task_async` or `delegate_task` returns an error or task fails, DO NOT give up. Immediately analyze the stdout/stderr trace, formulate a fix, and retry the delegation, or fall back to doing the work manually.

**Action:** Use the MCP tool `delegate_task_async` (preferred over synchronous `delegate_task`) to dispatch the decided `ole`, an exhaustively detailed `	ask_description`, the designated `output_path` (an artifact inside .optimus/ usually), and importantly the `context_files` array (relative paths to requirement/design docs).
