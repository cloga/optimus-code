# Issue Draft: Asynchronous Event-Driven Swarm & Fully Autonomous Architecture

**Title:** Architecture: Evolve Swarm Delegation to Asynchronous Event-Driven Core

**Body:**

## Genesis / Why
Currently, MCP tools like delegate_task block the calling Agent until the subprocess (child_process.spawn) returns. This creates a deeply nested, synchronous blocking chain:
\User -> VS Code Chat -> PM Agent -> [awaits MCP] -> Dev Agent -> [awaits MCP] -> ...\

If a Dev agent takes several minutes to generate code and PR, the PM Agent's token stream hangs, risking LLM timeout limits and wasting context window time. To achieve true autonomy and horizontal parallelization, we must transition from a **Synchronous Call Stack** to an **Event-Driven Blackboard Architecture**.

## Proposed Evolution Paths

### 1. Phase 1: Async MCP Fire-and-Forget
Instead of delegate_task awaiting the spawned CLI, we refactor it to become a non-blocking queue submission:
- The PM calls delegate_task_async(task_id, role, input).
- The MCP server writes the task payload to a local database/queue (e.g., .optimus/queue/<taskId>.json).
- The MCP server spawns the child process in detached mode (detached: true).
- The MCP server IMMEDIATELY returns {"status": "queued", "taskId": "<taskId>"} to the PM, freeing the PM to handle other user inputs concurrently.

### 2. Phase 2: Event-Driven Wake-up Mechanism
How does the PM know a task is done if it didn't block to wait?
- Implement a Watcher/Webhook layer in the Node.js Orchestrator.
- When an async subprocess finishes, it updates the Blackboard or GitHub Issue.
- The Orchestrator injects a synthesized system message into the active chat stream: \[SYSTEM EVENT: Agent "dev" completed Task #29. Action required.]\
- This actively wakes up the PM Agent to report to the human or continue to the QA phase.

### 3. Phase 3 (End-Game): The Headless Master (T0 Daemon)
Decouple the PM Agent strictly from the VS Code Chat View.
- Abstract the Master Agent to run as a pure daemon (T0).
- Triggers become entirely webhook-based (e.g., human opens GitHub issue -> wakes up T0 PM -> delegates to Dev -> Dev makes PR -> wakes up T0 PM -> delegates to QA).

## Acceptance Criteria for Phase 1
- [ ] Refactor delegate_task to support async mode in MCP layer.
- [ ] Child processes are spawned detached, avoiding main thread blocking.
- [ ] Queued tasks are queryable via a new check_queue_status tool.
