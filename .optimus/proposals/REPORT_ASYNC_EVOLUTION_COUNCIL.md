#  Spartan Swarm Council Report: Asynchronous Evolution

**Topic:** Evolution toward Async Event-Driven MCP Architecture 
**Council Members:** Chief Architect, PM Agent, QA Engineer
**Date:** March 10, 2026

## 1. Consensus & Verdict
**Verdict: RED (Do Not Proceed as Written)**

All three experts unanimously agree that while the *vision* of moving from synchronous blocking to an asynchronous event-driven blackboard is absolutely correct and necessary to scale the enterprise pipeline, the current "Phase 1 / Phase 2" implementation plan is a **"whiteboard-level sketch"** filled with critical distributed system vulnerabilities.

## 2. Core Architectural Flaws Identified

###  The Flat-File Queue Anti-Pattern (TOCTOU Vulnerability)
*Raised by: Chief Architect & QA Engineer*
Using \.optimus/queue/<taskId>.json\ on an unmodified local filesystem for an async message broker guarantees race conditions. 
- **No Atomic Locks**: If two processes poll simultaneously, they will claim the same task. 
- **Crash Corruption**: If a write is partially completed during a crash, the JSON state falls into an unrecoverable corrupted state.
- **Solution Proposed**: Discard flat files for the queue. The queue must be backed by SQLite (WAL mode enabled) which guarantees atomic \BEGIN EXCLUSIVE\ transactions for dequeue/enqueue operations, or a dedicated local broker.

###  The Silent Death (Missing Dead-Letter / Retry)
*Raised by: PM & QA Engineer*
In "Fire-and-Forget", if a \detached: true\ child process encounters an OOM error or CLI auth failure, it dies silently. 
- The \_status.md\ file is never updated. 
- The PM remains unaware, thinking the task is still "in progress".
- **Solution Proposed**: The Orchestrator requires a **Timeout Watchdog** and a **Dead-Letter Queue (DLQ)**. If a worker hasn't pinged back within an SLA (e.g., 15 minutes), the task must be re-queued or bounced back to the user with a failure trace.

###  The Thundering Herd (Cost & Rate Limit Explosion)
*Raised by: Chief Architect & PM*
The proposal claims the benefit of "1 PM dispatching 5 Devs simultaneously."
- Triggering 5 parallel CLI instances invoking Claude/Copilot LLM APIs will immediately trigger \HTTP 429 Too Many Requests\ limits at the API gateway layer.
- It will also burn excessive token budgets out of control.
- **Solution Proposed**: Implement an **Orchestrator Semaphore / Concurrency Governor**. The local queue worker must limit \Max_Parallel_Workers = 2\ (or configurable) regardless of how many tasks the PM dumps into the queue.

###  DX & Wake-up Fragility 
*Raised by: Chief Architect*
"Option B" relies on injecting synthetic system messages into the VS Code UI Chat stream to wake up the PM.
- **Risk**: This tightly couples the Optimus backend Node.js server to volatile VS Code Extension internal APIs and UI states. If the chat window is closed or garbage collected by VS Code, the message evaporates into the void.

## 3. Recommended Action Plan (Next Steps for User)
The Council recommends pausing Phase 1 code implementation until the underlying IPC/Queue infrastructure is upgraded:

1. **Step 1 (Infrastructure):** Refactor the Blackboard mechanism from plain Markdown to a local **SQLite Database (WAL Mode)** to provide atomic Enqueue/Dequeue.
2. **Step 2 (The Governor):** Build the Node.js \QueueWorker.ts\ with a strict concurrency limit (Semaphore) and a Dead-Letter Queue for crashed agents.
3. **Step 3 (Polling vs Webhooks):** Implement a robust SSE (Server-Sent Events) or WebSocket bridge between the Node daemon and the VS Code View Provider, rather than hacky UI-level prompt injections, so the frontend UI dynamically updates its state cleanly.
