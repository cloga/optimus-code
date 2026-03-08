# Optimus Code 🚀

> *The Ultimate Multi-Agent Orchestrator. Let models debate, you make the final call.*

## 🌟 Project Genesis

This project was born out of a brainstorming session in early 2026. We realized that any single Language Model (LLM) possesses inherent limitations. Some excel at deep code autocompletion and syntax due to native editor integrations, while others offer unparalleled macroscopic architectural planning but involve context-breaking copy/pasting.

How do we force top-tier models from mega-corporations to work together and "debate" without incurring dual API costs?

**The Core Concept: Hijacking the OS CLI Layer.**
Since these autonomous Coding Agents act as Model Context Protocol (MCP) clients in their own ecosystems, they refuse to be subservient servers to one another.
The solution was to build an omniscient **Orchestrator** — **Optimus Code**.

It operates as a **VS Code Extension** where at its foundation it forcefully converts existing first-party CLI abilities (like `@github/copilot` and `claude-code`) into headless, raw computation threads ("Workers") executed via Node.js standard subprocesses (`child_process`).

## 🏗️ Architecture

The overall design follows a "Three-Tier Model" and standardized directory structure:

### Directory Structure Convention
To maintain clarity as the project scales, the codebase enforces the following organization:
*   `src/extension.ts`: The main entry point for the VS Code extension.
*   `src/providers/`: Contains VS Code Webview providers (e.g., `ChatViewProvider.ts`) responsible for extending the UI and handling frontend message passing.
*   `src/adapters/`: Contains integration logic for external AI CLIs (e.g., `AgentAdapter.ts`, `ClaudeCodeAdapter.ts`).

### 1. Top Layer: Native VS Code Extension UI (Webview & Context Layer)
Operates as the geeks' command center, directly attached to your editor's sidebar.
*   **Context Extraction**: It reads the active code you've selected, cursor positions, and project context.
*   **Side-by-Side Asynchronous "Kanban" Chat**: The traditional top-down chat flow limits reviewing parallel model data. Optimus renders a dynamically scrolling horizontally-aligned Webview where every summoned agent writes its output side-by-side. 
*   **Rich Client Representation**: Employs real-time markdown parsing (`marked.js`) overlaying native VS Code themes.

### 2. Middle Layer: The Thin Orchestrator & Session Tree
Optimus Code embraces a **"Thin Client"** architecture. Instead of manually parsing histories or enforcing token limits, the extension delegates memory, state persistence, and context isolation entirely to the external CLI coding agents (e.g., Claude Code, GitHub Copilot CLI).

#### 2.1 The "Session Tree" (Logical vs. Physical Sessions)
To the end-user, there is only one tracking entity: the **Logical Session** (e.g., "Feature_Login_Refactor"). Internally, Optimus manages a mapping to a sub-space of multiple **Physical CLI Sessions**:
* **The Main/PM Agent**: Maintains the macro-level context, thinks about architecture, and interacts with the user. The Main Agent's **CLI Engine Type (e.g., Copilot vs. Claude) is fixed for the lifetime of a specific logical session**, but the end-user can freely hot-swap the **Model** (e.g., swapping `claude-3-opus` to `claude-3.5-sonnet`) mid-conversation without dropping context.
* **Worker Agents (牛马)**: Sub-agents operating on their own isolated `cli_session_id`. They handle context-heavy "dirty work" (e.g., reading 100 files, running compilations, brute-force debugging) without polluting the Main Agent's context window. They can be paused, resumed, or discarded cleanly.

#### 2.2 The Sub-Agent Formula (牛马配方)
Capabilities and pipelines are no longer hardcoded in TypeScript. An Agent instance in Optimus is dynamically instantiated with a pure configuration formula:
`Agent = [CLI Engine] + [Session ID] + [System Prompt/Persona] + [Working Dir]`
* **CLI Engine**: `claude_code` or `copilot_cli`.
* **Session ID**: The physical thread ID that binds the Agent's memory lifecycle.
* **System Prompt**: An initial payload granting its persona and rigid goals (e.g., "You are an automated code-reviewer...").
* **Working Directory**: Dictates what context and local Config/MCP tools it will inherit upon boot.

#### 2.3 Dynamic Skill & MCP Binding (Hot-Swappable)
Because underlying Agents operate via CLI initialization sequences, tools (MCP) and Skills (instructions) are bound at the **Workspace / Directory Environment** layer.
If you install a new enterprise database MCP in the workspace, *even long-running existing sessions instantly acquire the new capability on their next execution loop*. The Agent simply wakes up, re-scans the environment, sees the new tools, and proceeds to use them seamlessly.

#### 2.4 Recursive Delegation (Swarm Capability)
The architecture achieves a natural Multi-Agent Swarm structure. By giving the Main Agent a dedicated `delegate_task` MCP tool, the PM Agent can autonomously:
1. Receive a high-level task from the human.
2. Evaluate and call `delegate_task` to spin up specialized Worker Agents (e.g., assigning ID `sub_frontend_01` to build a UI component, or `sub_qa_01` to test it).
3. Collect the workers' outputs asynchronously.
4. Return a synthesized final summary back to the human.
This delegation loop eliminates the need for manual UI micro-management by the user.



### 3. Bottom Layer: CLI Adapter Layer (System Hooks)
Node.js sub-processors invoking official tools (e.g., `@github/copilot`, `claude-code`) via continuous `child_process.spawn`.
*   **Timeout-Free Execution**: Large language models functioning as "Coding Agents" execute independent, multi-step sub-routines (e.g., inspecting files, semantic searches). We use `timeout: 0` alongside unbounded I/O streams allowing these local scripts infinite runtime to conclude their autonomous loops natively.

## 🧗 Development Roadmap

### Phase 1: MVP Scaffolding ✅
*   [x] Run `npx yo code` to generate a Typescript extension.
*   [x] Register the `OptimusCode.chatView` component inside the Activity Bar.
*   [x] Abstract a `child_process` wrapper utilizing `spawn` to successfully hijack binaries while forcing `TERM=dumb`, avoiding color code leaks.

### Phase 2: Complete the Streaming Loop ✅
*   [x] Construct an `AgentAdapter` interface binding multiple concurrent models.
*   [x] Add continuous byte-stream updates via VS Code inter-process message passing (`postMessage`).
*   [x] Translate OS-level model errors into user-friendly diagnostic UI elements. 

### Phase 3: Dual Execution Strategy & Mode-based Agent Filtering ✅
*   [x] Refactor `PersistentAgentAdapter` to support dual-mode: non-interactive (`-p`) for plan/ask/auto, persistent daemon for agent mode.
*   [x] Add `modes` field to `AgentAdapter` interface and configuration schema, enabling per-agent mode control.
*   [x] Executor dropdown in UI filtered to show only agents supporting `agent` mode.
*   [x] Max 3 concurrent agent selection enforced in the Webview.

### Phase 4: The Pivot to "Thin UI" & Delegated State ✅
*   [x] Remove heavy multi-turn context parsing from the extension layer.
*   [x] Let standard `claude_code` and `copilot_cli` tools track state via standard CLI `--continue` / `--resume` arguments.
*   [x] Standardize all CLI tool integrations via Model Context Protocol (MCP).

### Phase 5: Swarm Architecture & Multi-Agent Delegation
  *   [x] Expose `delegate_task` MCP tool for Main agent recursive invocation.
  *   [ ] Provide robust tracking map (Session Tree) for `Logical Session ID` -> `Multiple Physical CLI Session IDs`.
  *   [ ] Handle graceful spin-up and teardown logic of specialized dummy Worker Agents ("牛马").

### The "Virtual Software Company" & Blackboard Pattern (SOP)
To ensure the Orchestrator truly acts as a Chief Architect (老板/包工头), we elevate the architecture into a **Virtual Software Company / Multi-Tier Swarm**. This prevents the "telephone game" (context loss) and ensures scalable, manageable multi-agent collaboration.

1. **Adaptive Hierarchy (弹性折叠架构)**: 
   - **Simple Tasks**: The Orchestrator handles small fixes directly or delegates to a single Worker instantly.
   - **Epic Tasks**: The Orchestrator dynamically summons a "PM/Tech Lead" Agent to analyze requirements, write PRDs, and break down tickets before any coding starts.
2. **The "Blackboard" Pattern (Artifact-Driven Handoff)**: 
   - Instead of passing massive prompts back and forth (which degrades context), agents communicate via a Shared Blackboard—typically markdown files in the workspace (e.g., `PLANNING.md`, `TASKS.todo`). 
   - The PM writes to the Blackboard; the Worker reads the Blackboard. The Human (You) can audit and modify the Blackboard at any time to steer the entire Swarm instantly.
3. **Team Assembly & Dispatch**:
   - The Orchestrator binds specialized `role_prompt`s to different workers (e.g., "You are an expert QA engineer").
   - Workers are dispatched via the `delegate_task` MCP tool, pointing them to specific sections of the Blackboard.
4. **Review, Circuit Breakers & Integration**:
   - The PM/Orchestrator acts as Reviewer, checking the Worker's output (via `git diff`, test results, or linter outputs).
   - **Circuit Breaker**: If a Worker fails/hallucinates repeatedly (e.g., >3 retries on the same sub-task), the PM halts the loop and escalates to the Human to avoid infinite loops and token waste.
   - Once all Blackboard tickets are resolved, the Orchestrator delivers the final integrated product.

---
*"In the holy trinity of the Architect (You), the Code Bee (Copilot), and the Reviewer (Claude), you just press the button and sip your coffee."*
## UI/UX Philosophy
- **Tool-Call Mental Model**: The Multi-Agent Council execution should be presented to the user visually as 'Tool Calls' (e.g., hidden inside <details> blocks on success). Do not present complex dashboards or raw multi-agent logs as equal peers to standard conversation messages. Always mimic the minimal, conversational UX standards seen in GitHub Copilot and Claude to reduce the user's cognitive load.

## Configuration & Context Management
- **The \.optimus/\ Directory**: To maintain a Single Source of Truth (SSOT) across all multi-agent backends (Copilot, Claude, etc.), the orchestrator uses the \.optimus/\ directory in the target workspace.
  - \.optimus/rules.md\: The primary instructions file. Optimus injects these rules into every agent prompt at runtime via `<project-rules>` tags — no file synchronization required. Both planner and executor prompts receive the rules fresh each turn through `SharedTaskStateManager.readRulesMd()`.
  - \.optimus/memory.md\: **Long-term agent memory hot cache** (OpenClaw-inspired). Injected into every agent prompt via `<project-memory>` tags alongside rules. Executors can emit `<memory-update>` blocks to persist cross-task discoveries (user preferences, architectural decisions, recurring patterns). The orchestrator extracts these blocks and appends them to the file automatically. Human-readable and editable.
  - *Future Extensibility*: This directory is designed to scale natively, capable of hosting future context payloads like \.optimus/tasks.md\ (for task queues) or deeper per-entity memory under \.optimus/memory/\.
