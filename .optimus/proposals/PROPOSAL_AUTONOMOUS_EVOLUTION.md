# Proposal: Asynchronous Delegation & Fully Autonomous Swarm Evolution

## Genesis / The User's Question
How to evolve the system towards higher autonomy by making MCP delegation asynchronous? Can we build a "Pseudo-Autonomous System" where the human drops a requirement to the pm, the pm delegates asynchronously, and the human/pm just periodically checks status?

## Architectural Evaluation of Async MCP
The user's intuition is fundamentally correct. Currently, MCP tools block the calling Agent until the subprocess (child_process.spawn) returns. This creates a deeply nested, synchronous blocking chain:
User -> VS Code Chat -> PM Agent -> [awaits MCP] -> Dev Agent -> [awaits MCP] -> ...
If a Dev agent takes 5 minutes to generate code and PR, the PM Agent's token stream hangs, often running into LLM timeout limits or max-token constraints.

To achieve true autonomy, we must move from a **Synchronous Call Stack** to an **Event-Driven Blackboard (Message Broker) Architecture**.

## Proposed Evolution Paths

### 1. The Immediate Step: Async MCP Fire-and-Forget
Instead of delegate_task awaiting the spawned CLI, it becomes a non-blocking queue submission:
- **How it works**: The PM calls delegate_task_async(task_id, role, input). The MCP server writes the task to .optimus/queue/<taskId>.json, spawns the child process detached, and IMMEDIATELY returns {"status": "queued", "taskId": "..."} to the PM.
- **The PM's behavior**: The PM says to the user: "I have dispatched the task to the Dev. I will inform you when it's done." The PM can then sleep or handle other UI requests.

### 2. The Mid-Term Step: The GitHub-Driven Polling Loop (Webhooks vs Cron)
How does the PM know a task is done if it didn't wait?
- **The Blackboard Standard**: When the Dev finishes asynchronously, it updates the GitHub Issue or the local .optimus/tasks/<id>_status.md.
- **Wake-up Trigger**: 
  - *Option A (Polling)*: Provide the PM with a new tool check_task_status. The PM checks it periodically. (Inefficient but easy).
  - *Option B (System Prompt Injection)*: The Swarm Orchestrator (Node.js) monitors .optimus/queue/. When a Dev finishes, the Orchestrator synthesizes a system message: [SYSTEM ALERT: Dev has finished task #29. Here is the PR link.] and pushes it into the PM's VS Code chat stream, waking the PM up to report to the human.

### 3. The End-Game: The "Cron-Agent" / Headless Master (True Autonomy)
Currently, the PM (Master Agent) is tied to the VS Code Chat View. It shuts down when the user closes VS Code.
To reach true autonomy, the PM must operate as a background daemon (T0).
- The human drops a GitHub Issue.
- The Node.js server sees the webhook -> Wakes up the T0 Headless Master.
- T0 delegates to T1 (Dev).
- Dev writes code -> creates PR -> Updates Issue.
- Node.js sees PR webhook -> Wakes up T0 (PM) -> PM invokes T1 (QA).
- QA tests -> approves.
- PM merges PR.
- The human wakes up the next day to merged, tested code. VS Code is only used as a transparent debug dashboard.

## Summary Verdict
Yes, modifying the MCP to be asynchronous is the *required next pivot* for scaling this architecture. It prevents connection timeouts, allows horizontal parallelization (1 PM dispatching 5 Devs simultaneously), and shifts the paradigm from "A fancy chatbox" to an "Enterprise AI Pipeline".
