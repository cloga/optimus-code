# Blueprint: Migrating Optimus Code to Native CLI Session Architectures

## 1. The Core Realization
The original attempt in Optimus Code to establish a persistent daemon/REPL by spawning interactive interactive instances of `claude` and `github-copilot-cli` (via standard text I/O pipes) was fundamentally flawed. 
The heavy reliance of these CLIs on TTY environments (for rendering spinners, ANSI escape sequences, and console interactions) caused deadlocks and hanging streams when captured programmatically via Node.js pipes without a pseudo-terminal (PTY).

**The Discovery**: Both official CLIs already implement their own persistent context management and native Structured Output (JSON Streams) designed precisely for headless execution and programmatic orchestration. We do not need to maintain complex conversational states or brute-force string parsing in our wrapper adapters.

## 2. CLI Capability Matrix

| Capability | Claude Code (`claude`) | GitHub Copilot (`copilot`) |
| :--- | :--- | :--- |
| **Non-Interactive Execution** | `-p "prompt"` | `-p "prompt"` |
| **Session / Memory Persistence** | `--session-id <uuid>` or `-c` | `--resume <uuid>` |
| **Headless Auto-Loop (Execution)**| `--dangerously-skip-permissions` | `--allow-all-tools` (or `--yolo`) |
| **Structured Output (JSON Stream)** | `--output-format stream-json --verbose` | `--output-format json --stream on` |

*Note: In both systems, maintaining the `uuid` across sequential one-shot (`-p`) calls perfectly preserves conversation history, file system context, and even benefits from API-level Prompt Caching.*

## 3. Refactoring Roadmap for Optimus Code

To fully transition Optimus Code into a pure "PM Agent Orchestrator", the following architectural shifts must occur:

### Phase 1: Retire the Custom Context Synthesizer
*   **Current State:** `SharedTaskStateManager.ts` and adapters manually concatenate the entire multi-turn history into a massive prompt for every single execution.
*   **Future State:** The Orchestrator assigns a unique `UUID` when a new Task/Council session begins. It simply passes the user's *latest* message (and any high-level PM guidance) via the `-p` argument, alongside the `uuid`. The underlying CLI handles the retrieval of history and tool state.

### Phase 2: Refactor `PersistentAgentAdapter.ts`
*   Remove complex heuristics that attempt to divine "turn completion" from ANSI sequences (`> ` prompts, `●` spinners).
*   Standardize the invocation pattern to: **One-Shot execution + UUID binding + JSON Streaming.**
    *   **Child Process Contract:** Call `spawn()` using the respective CLI arguments.
    *   **Vital:** Explicitly send an EOF via `child.stdin.end()` immediately after initialization if no further input is required, to prevent wrappers from stalling and waiting for TTY inputs.
    *   **Event Handling:** Rely primarily on the CLI process's natural `close`/`exit` event to signal absolute task completion. The Orchestrator does not need to parse intermediate thoughts unless it wishes to stream them to the VS Code UI for user visibility.

### Phase 3: Update Adapter Implementations

#### For `ClaudeCodeAdapter.ts`
When invoked by Optimus, execute:
```bash
claude -p "<latest_instruction_from_PM>" \
  --session-id "<optimus_task_uuid>" \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions
```
*   *Note*: The CLI output must be mapped from Claude's internal JSON stream types (`message_start`, `chunk`, `tool_started`, `result`) to Optimus's `ChatViewProvider` UI update callbacks.

#### For `GitHubCopilotAdapter.ts`
When invoked by Optimus, execute:
```bash
copilot -p "<latest_instruction_from_PM>" \
  --resume "<optimus_task_uuid>" \
  --output-format json \
  --stream on \
  --allow-all-tools
```

### 4. Ultimate Architecture (The PM-Worker Paradigm)
1. **The PM Agent (Optimus VS Code Host)**: Reads constraints, maintains global Markdown documents (e.g. `task.md`), allocates a session UUID, and triggers the Workers.
2. **The Workers (Headless CLI Subprocesses)**: A `claude` and/or `copilot` shell spins up, reads the UUID, fetches its context from its internal SQLite/local storage, resolves any code issues autonomously using local tools, and gracefully exits `0`.
3. **The Yield**: The PM Agent monitors the worker exit codes and usage JSON. If successful, it updates the visual Kanban board in VS Code and waits for the next human instruction.

## 5. The "Brain" Tier: VS Code Native Language Model API

Instead of spawning CLI processes for every cognitive task (like breaking down user requirements, acting as the PM, or evaluating code quality), Optimus Code will leverage the **VS Code Native Language Model API** (`vscode.lm`) for its central orchestrator ("The Brain").

**Why `vscode.lm`?**
- **Zero Overhead**: No process spawning, no IPC pipes, instantly available within the extension host.
- **Cost & Auth**: Piggybacks on the user's existing GitHub Copilot subscription integrated into VS Code natively.
- **Capabilities**: Full access to the LLM for text generation, architecture planning, and file analysis.

**Implementation Signature:**
```typescript
// 1. Select the appropriate model (e.g., Copilot GPT-4o)
const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });

// 2. Construct the PM Prompt (System + User)
const messages = [
    vscode.LanguageModelChatMessage.User("You are the PM. Break down this feature...")
];

// 3. Stream the cognitive output
const chatResponse = await model.sendRequest(messages, {}, token);
for await (const fragment of chatResponse.text) {
    // Stream directly to the Optimus UI / PRD.md
}
```

By splitting the architecture into a **"Brain"** (VS Code native `lm` API) and **"Hands"** (stateless CLI `--session-id` workers), we achieve maximum performance, perfect context preservation, and zero hanging daemons.

## 6. Agent-to-Agent (A2A) Interaction & The Blackboard Pattern

To enable seamless teamwork between the PM Agent (Brain) and the Dev/Coding Agents (Hands), we will adopt an **asynchronous, Document-driven Blackboard Pattern**. The File System itself acts as the Message Queue and Shared Database.

### What is the Blackboard Pattern?
The Blackboard Pattern is a classic software engineering architecture originating from AI, designed to handle complex, non-deterministic problems.

**The Analogy:** Imagine a room full of experts (Architect, Developer, QA) surrounding a large blackboard. The host writes a complex problem on the board. The Architect walks up, draws a diagram, and sits down. The Developer sees the diagram, writes code tasks next to it, and sits down. The QA sees the tasks and adds test cases. *The experts never talk directly to each other; they only read from and write to the shared blackboard.*

**Why it's essential for our Multi-Agent System:**
*   **Decoupling**: The PM Agent and Coding Agent operate independently. They don't need to know each other's APIs or underlying LLMs. They just agree on the Markdown format.
*   **No Context Bloat**: Multi-turn agent-to-agent chatting explodes token limits with conversational filler. Writing only the final, distilled outputs (`PRD.md`, `TODO.md`) keeps contexts pure and fast.
*   **Human-in-the-Loop friendly**: Everything on the "blackboard" is physical, readable Markdown. A human can step in, erase a line, or write a new one anytime before the next agent wakes up.

**Mapping to Optimus Code:**
*   **The Blackboard**: The `.optimus/` directory in the user's workspace (acting as our shared state).
*   **Knowledge Source 1 (The Brain)**: The `vscode.lm` driven PM Agent that analyzes requirements and writes the initial plan.
*   **Knowledge Source 2 (The Hands)**: The CLI-driven Coding Agents (`claude --session-id`) that read the `.optimus/TODO.md` and execute changes.
*   **The Controller (Orchestrator)**: The Optimus VS Code Extension itself, which monitors the file changes, manages human approval flows, and spawns the CLI processes.

### Guiding Principles for A2A
1. **No In-Memory Context Passing**: Avoid injecting the entire PM brainstorming chat history directly into the Coding Agent's prompt to prevent context pollution and length explosion.
2. **Markdown Contracts (Protocol)**: Communication occurs structurally via files like `.optimus/PRD.md` and `.optimus/TODO.md`. 
   * The PM writes `- [ ] Task 1`.
   * The Worker completes the task and updates it to `- [x] Task 1`.
3. **Human-in-the-Loop (HITL)**: Before the CLI Workers are spawned by the Orchestrator, the generated `.optimus/TODO.md` is presented to the user. The human acts as the supreme project manager—approving or tweaking the Markdown file. Only upon human approval does the Orchestrator read the file and dispatch the Worker.
4. **Error Feedback Loop (Blockers)**: If a CLI Worker reaches a dead end (e.g., repeating API errors or dependency conflicts), it is instructed to halt execution (`exit 0`) and record the obstacle in a `.optimus/BLOCKERS.md` file. The Orchestrator monitors this outcome and routes the blocker back to the PM Agent (`vscode.lm`) to either re-plan or solicit human intervention.

In this paradigm, the File System provides the ultimate source of truth, yielding maximum stability and visibility for multi-agent workflows.

## 7. Gradual Upgrade Plan (Dogfooding Strategy)

To evolve the current Optimus Code project into this target architecture, we will use a gradual, "Dogfooding" approach (using Optimus to build Optimus). Every phase must be independently usable and testable. 

**Key Insight:** The "PM Agent" in the early stages does *not* need to be a hardcoded LLM call within the extension. It can be *any* interactive agent (like GitHub Copilot Chat), or even the human themselves. The absolute core of this architecture is the **Blackboard**. As long as *someone* writes to the blackboard, the subsequent execution engine will work.

### Phase 1: Establish the Blackboard & Interactive PM (Zero extension code needed)
**Goal:** Formalize the protocol and establish the directory structure without writing a single line of extension code. Prove the flow entirely through manual human-AI chat.
*   **Action:** 
    1. Create the `.optimus/` directory in the project root.
    2. Define a `.optimus/rules.md` (the protocol for the Worker).
    3. The human talks to their existing Copilot/Claude Chat interface (acting as the "PM"), asks it to break down tasks, and instructs it to output a `.optimus/TODO.md`.
*   **Value:** Immediately establishes the A2A working environment. The human acting as the Orchestrator has a tangible task list to feed the worker.

### Phase 2: Semi-Auto Labor (The CLI Worker Test)
**Goal:** Prove the CLI worker can read the blackboard and modify files correctly.
*   **Action:** After Phase 1 generates `.optimus/TODO.md`, the human manually runs the CLI worker in the VS Code terminal: 
    ```bash
    claude -p "Read .optimus/TODO.md, execute the first unfinished task. When done, change '- [ ]' to '- [x]'." --session-id optimus-v2-dev
    ```
*   **Value:** Validates the state-preserving nature of `--session-id` and the CLI's ability to act upon the structured Markdown contract.

### Phase 3: Optimus as the Execution Orchestrator
**Goal:** Replace the legacy, hanging `persistent` REPL logic with clean, automated background `spawn` calls. Optimus becomes a dedicated "Task Execution Engine", ignorant of complex NLP or chat histories.
*   **Action:** 
    1. Tear down old PTY/daemon hacks in `ClaudeCodeAdapter.ts`. 
    2. Implement a simple one-shot runner `runTask(uuid)`.
    3. Add a simple **"Execute Next Task"** button in Optimus. Clicking this button merely reads `.optimus/TODO.md`, formats a static prompt to the CLI, and spawns the subprocess.
*   **Value:** Agent-to-Agent (A2A) is fully connected via UI. The Optimus extension's codebase is heavily simplified, focusing on IO orchestration rather than prompt-engineering.

### Phase 4: Full Auto-Cruise (The Autonomous Loop)
**Goal:** Close the loop, minimize human interaction during execution, and handle errors.
*   **Action:** Implement the Orchestrator loop in the extension host. 
    1. User clicks "Start Sprint".
    2. Extension reads `.optimus/TODO.md` and dispatches Worker.
    3. Monitor `exit 0`, check if task was checked `[x]`, move to the next task automatically.
    4. Implement `vscode.lm` for automated replanning if `.optimus/BLOCKERS.md` is updated by a failing worker.
*   **Value:** High-level autonomous workflow. The Human provides the overarching goal, the built-in LLM writes the TODO, the internal orchestrator loop dispatches the CLI, and the job gets done.

### Phase 5: Council Review (Map-Reduce Multi-Expert Execution)
**Goal:** Implement true agent parallelism and prevent context pollution during large architectural features by leveraging native Process pooling.
*   **Action:** 
    1. Support `runCouncilReview(proposalPath)` by using `Promise.all()` to orchestrate concurrent `ClaudeCodeAdapter.invoke()` calls.
    2. Launch these CLI worker jobs using completely physically isolated identifiers: `--session-id sec-review`, `--session-id perf-review`. Ensure strictly **1 active process per session-id** at any given time to avoid SQLite locked DB errors or memory corruption.
    3. Inject strict `role_prompt`s into the adapter instructing the agents to dump their findings solely into `.optimus/reviews/<role>.md`.
    4. Upon all async calls returning `exit 0`, automatically prompt the base Master Agent to read `reviews/*.md` and refine the origin architecture, spitting out conflicts if human arbitration is needed.
*   **Value:** Bypasses limitations on single LLM cognitive load over large design tasks, mimicking a true organization with role-constrained expertise at native runtime speeds.