# Optimus Code 🚀

> *The Ultimate Multi-Agent Orchestrator. Let models debate, you make the final call.*

## 🌟 Project Genesis

This project was born out of a brainstorming session in early 2026. We realized that any single Language Model (LLM) possesses inherent limitations. Some excel at deep code autocompletion and syntax due to native editor integrations, while others offer unparalleled macroscopic architectural planning but involve context-breaking copy/pasting.

How do we force top-tier models from mega-corporations to work together and "debate" without incurring dual API costs?

**The Core Concept: Hijacking the OS CLI Layer.**
Since these autonomous Coding Agents act as closed ecosystems, they refuse to be subservient servers to one another.
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
  * **Session ID (Episodic Memory / 物理记忆记忆体)**: The physical thread ID that binds the Agent's episodic memory and execution lifecycle to a dedicated SQLite/LevelDB database.
  * **System Prompt/Persona (Core Identity / 人格记忆)**: An initial payload granting its rigid rules, expertise, and goals (e.g., from `.optimus/personas/*.md`).

#### 2.3 Dynamic Skill Binding (Hot-Swappable)
Because underlying Agents operate via CLI initialization sequences, tools and Skills (instructions) are bound at the **Workspace / Directory Environment** layer.
If you install a new enterprise plugin in the workspace, *even long-running existing sessions instantly acquire the new capability on their next execution loop*. The Agent simply wakes up, re-scans the environment, sees the new tools, and proceeds to use them seamlessly.

#### 2.4 Recursive Delegation (Swarm Capability)
The architecture achieves a natural Multi-Agent Swarm structure. By giving the Main Agent a dedicated `delegate_task` tool, the PM Agent can autonomously:
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
*   [x] Standardize all CLI tool integrations via Process IPC and structured tool output.

### Phase 5: Swarm Architecture & Multi-Agent Delegation
  *   [x] Expose `delegate_task` tool for Main agent recursive invocation.
  *   [ ] Provide robust tracking map (Session Tree) for `Logical Session ID` -> `Multiple Physical CLI Session IDs`.
  *   [ ] Handle graceful spin-up and teardown logic of specialized dummy Worker Agents ("牛马").

### The "Virtual Software Company" & Blackboard Pattern (SOP)
To ensure the Orchestrator truly acts as a Chief Architect (老板/包工头), we elevate the architecture into a **Virtual Software Company / Multi-Tier Swarm**. This prevents the "telephone game" (context loss) and ensures scalable, manageable multi-agent collaboration.

1. **Adaptive Hierarchy (弹性折叠架构)**: 
   - **Simple Tasks**: The Orchestrator handles small fixes directly or delegates to a single Worker instantly.
   - **Epic Tasks**: The Orchestrator dynamically summons a Master Agent (PM/Tech Lead) to analyze requirements and orchestrate the Swarm.
2. **The "Blackboard" Pattern (Artifact-Driven Handoff)**: 
   - Instead of passing massive conversational prompts back and forth (which poisons context), all sub-agents communicate purely via reading and writing Markdown files in the workspace (e.g., dynamically named `.optimus/PROPOSAL_<topic>.md`, `TODO.md`).

#### Spartan Swarm (斯巴达虫群) & MCP Facade Architecture
As the project evolves, the multi-agent topology has definitively transitioned into a disciplined, highly autonomous engineering workforce known as the **Spartan Swarm (斯巴达虫群)**. 

**Strategic Pivot (2026-03)**: The project has shifted its primary focus entirely to the **MCP (Model Context Protocol) Server as the absolute underlying API layer**. The earlier custom VS Code Extension frontend is now considered just a "Thin Client"—a downstream consumer of this MCP foundation. By focusing solely on the MCP API, our Swarm Orchestrator becomes universally compatible not just with our extension, but with official Copilot Edits, standard Claude Code, Cursor, and any other IDE supporting the open MCP standard.

To bypass the limitations of Stateful CLI Coding Agents (which are designed for human interaction and struggle with stdin/stdout hijacking, long-connection management, and DB write-locks), Optimus employs this **Orchestrator MCP Facade**.

1. **The Core MCP Engine (`spartan-swarm` API)**: Instead of directly hacking CLI backends tightly coupled to VS Code UI components, we package our swarm orchestrator as a standalone, global MCP Server (`optimus-plugin`).
2. **Master Agent (纯粹调用)**: A Master Agent (whether inside Copilot, Claude CLI, or Web) purely executes standard JSON Tool Calls (e.g., `dispatch_council` or `delegate_task`) across the MCP wire, completely oblivious to how jobs are physically executed locally.
3. **The Facade Server (提线木偶大师)**: Our Node.js MCP server receives these RPC calls. It acts as the ultimate controller, spinning up isolated, stateless CLI subprocesses (Headless Workers) under the hood. It strictly enforces the Singleton Worker Rule and parses all outputs.
4. **Thin UI Decoupling**: Because the heavy lifting (concurrency, logging, error handling, worker spawning) is entirely encapsulated within the Local MCP Node daemon, front-end chat views no longer need to parse messy XML tags or manage state. They just render standard MCP tool invocation JSONs.

#### The Spartan Registry: Expert Definition & Routing (专家定义与路由调度)
In the MCP Facade paradigm, the Master Agent commands the Swarm by roles (e.g., `["security", "db-tyrant"]`), but it doesn't need to know *how* those experts are built. The Node.js MCP Controller uses a **Three-Tier Cascade Assembly (三层级联装配策略)** to construct the expert's ultimate System Prompt. Rather than a simple mutual exclusion (fallback), the tiers can optionally merge to form a deeply contextualized worker:

1. **T3 - Zero-Shot Dynamic Base (临时动员兵 - 底层兜底)**: The Controller always generates a baseline identity string: `"You are a specialized expert: <role>. Analyze objectively from your domain's perspective."` This guarantees that even completely made-up roles (e.g., `graphql-performance-specialist`) will snap into the correct behavioral frame.
2. **T2 - Built-in Plugin Agents (斯巴达正规军 - 核心纪律)**: The Controller checks the plugin's deployed `agents/` directory (e.g., `optimus-plugin/agents/<role>.md`). If found, it appends these universally standardized rules (e.g., OWASP top 10 for `security`) to the payload. These represent our general-purpose "Industry Best Practices."
3. **T1 - Local Project Personas (本地领域专家 - 顶层覆写)**: Finally, it checks the workspace for `.optimus/personas/<role>.md`. If found, these local rules are appended last (carrying the highest LLM attention weight). This allows a specific repo to override or augment the generic T2 expert (e.g., *"As a DB Tyrant, in THIS project, you must enforce the internal XYZ ORM dialect over standard SQL"*).

**(Important Note)**: While the actual filesystem readout logic (Cascade Resolution) resides natively inside the MCP `worker-spawner.js` code to maintain deterministic fallback behavior, it is strongly driven by the **Master Agent's Skill prompts** (e.g., instructing the LLM that it CAN dynamically invent new roles to trigger T3 generation). This ensures standard tooling API semantics while offering complex routing behavior.

**The Assembly Outcome**: The final Worker Prompt is fundamentally a concatenation: `[T3 Role Injection] + [T2 General Practices] + [T1 Local Overrides]`. This allows a locally defined `.optimus/personas/security.md` to be extremely short (just mentioning a specific local auth bug caveat), while still inheriting the 500-line global security prowess from T2.

#### Swarm Autonomous Evolution (自主进化与动态招募机制)
Crucially, the entire Spartan Registry is **not statically hardcoded by humans**. It is a dynamic ecosystem driven entirely by the Master Agent's autonomy. In the beginning, a project may exist with ZERO predefined roles—everything starts as a generic T3. 

The Master Agent governs the lifecycle of these personas autonomously:
1. **Dynamic Recruitment (T3 临时征用)**: When faced with a novel problem, the Master Agent calculates the necessary domain expertise and invents a role title (e.g., `dispatch_council(roles: ["webgl-shader-guru"])`). It relies on the T3 Zero-Shot fallback to test this new worker directly on the battlefield. 
2. **Project-Scoped Solidification (T1 本地提拔)**: If the Master Agent notices project-specific idiosyncrasies causing the T3 worker to fail or hallucinate, it uses file I/O to synthesize and write a `.optimus/personas/webgl-shader-guru.md` (T1). It has successfully promoted the temporary worker to a project-aware, disciplined local expert.
3. **Global Abstraction & Promotion (T2 通用固化与复用)**: Once the Master Agent recognizes that a newly refined T1 expert possesses highly reusable, standard-industry logic that transcends the current project (e.g., a pristine `react-hooks-reviewer`), it has the autonomy to migrate or extract those universal principles into the globally scoped Plugin directory (e.g., `optimus-plugin/agents/react-hooks-reviewer.md` - the T2 layer). 

Through this pipeline (T3 -> T1 -> T2), the Swarm self-organizes. It drafts its own domain armies based strictly on what succeeds in production, transferring localized trauma into global institutional memory automatically.

This routing completely abstracts prompted-persona-engineering away from the Master Agent. It simply orders the MCP Tool: `"Spawn a db-tyrant"`, and the Facade assembles the smartest available configuration for that role before executing the worker thread.

#### The Epic Task Lifecycle (Swarm Topologies)
When a massive refactoring or architectural task is triggered, the Orchestrator utilizes two distinct topologies:

3. **Phase A: Map-Reduce Council Review (并发专家会审 - Validation & Design)**
   - *Topology: Parallel Consensus (1-to-Many-to-1).*
   - **Scatter (发散)**: Master Agent drafts an initial proposal dynamically (e.g., `.optimus/PROPOSAL_auth.md`). The Orchestrator parallel-spawns multiple specialized CLI workers (e.g., Security, Database, Refactoring experts) at the exact same time, pointing them to the specific proposal file.
   - **Model Diversity (模型多样性)**: To prevent groupthink and systemic blind spots, the Orchestrator should intentionally dispatch different foundation models to different experts if configured. For example, routing the `security-expert` to Claude 3.5 Sonnet (for strict rules) and the `refactoring-architect` to OpenAI o1 (for out-of-the-box structural thinking).
   - **Isolate**: Each expert analyzes the proposal and writes strictly formatted reviews to dedicated isolated artifacts (e.g., `.optimus/reviews/<timestamp>/security_review.md`).
   - **Gather (收敛)**: The Master waits for all processes to exit (`Promise.all`), digests the reviews, and generates the final actionable `.optimus/TODO.md` (or pauses to generate `CONFLICTS.md` for human arbitration).

4. **Phase B: Task Delegation & Pipeline (串行流水线执行 - Execution)**
   - *Topology: Sequential Pipeline (Waterfall).*
   - Once the `.optimus/TODO.md` blueprint is finalized, the Orchestrator uses the `delegate_task` tool to assign execution work.
   - Sub-agents are dispatched sequentially to do the heavy lifting. A "Dev" worker reads the first unchecked ticket, writes the actual implementation code, and exits. Then a "QA" worker reads the diff, runs tests, and ticks the box `[x]`.
   
5. **The Singleton Worker Rule & Circuit Breakers**:
   - **Singleton Identity**: A `--session-id` represents exactly ONE virtual worker with its own physical SQLite memory. **A specific session identity cannot do two tasks concurrently** (avoids DB lock/memory corruption). To run parallel identical roles, you must clone them (e.g., `--session-id dev-1`, `--session-id dev-2`).
   - **Circuit Breaker**: If a Worker hallucinates or errors repeatedly on the same sub-task (>3 retries), the PM halts the loop and escalates to the Human to avoid infinite loops and token waste.

---
*"In the holy trinity of the Architect (You), the Code Bee (Copilot), and the Reviewer (Claude), you just press the button and sip your coffee."*
## UI/UX Philosophy
- **Tool-Call Mental Model**: The Multi-Agent Council execution should be presented to the user visually as 'Tool Calls' (e.g., hidden inside <details> blocks on success). Do not present complex dashboards or raw multi-agent logs as equal peers to standard conversation messages. Always mimic the minimal, conversational UX standards seen in GitHub Copilot and Claude to reduce the user's cognitive load.

## Configuration & Context Management
**The Multi-Tiered Memory & Blackboard System**: To maintain a "Single Source of Truth" (SSOT) across all multi-agent backends (Copilot, Claude, etc.), we explicitly split memory into **Static Persona Configs (人格/经验记忆)** managed as plain text, and **Dynamic Flow State (事件/短期记忆)** managed via the underlying CLI's native SQLite stores mapped to `--session-id`. 

Crucially, Optimus Code distinguishes between **Local (Project-Scoped)** and **Global (Optimus-Scoped)** dimensions:

#### 1. Local Workspace Project Plane (`<workspace>/.optimus/`)
- **Local Blackboard (`.optimus/PROPOSAL.md`, `TODO.md`)**: The artifact-driven communication bus confined to the specific project being edited.
- **Local Memory (`.optimus/memory.md`)**: Long-term agent memory hot cache specific to this codebase's architecture and quirks.
- **Local Rules & Personas (`.optimus/rules.md`, `.optimus/personas/`)**: Configurations that override generic behaviors strictly for this repository.

#### 2. Global Optimus OS Plane (`~/.optimus/` or Plugin Global Cache)
Because the Master Agent acts as an autonomous entity roaming across *all* your projects, it requires a global brain to sync learnings cross-repo.
- **Global Memory (`~/.optimus/global_memory.md`)**: Persistent user preferences (e.g., "The CEO always prefers React functional components", "Never use tabs, only 4 spaces"). The Master Agent reads this alongside local memory to maintain consistency across every workspace.
- **Global Blackboard (`~/.optimus/global_bus/`)**: Used for extreme multi-repo orchestration. If a backend API repo changes, the Master Agent can write an event to the Global Blackboard. When the frontend repo is opened, the local Master Agent reads the Global Blackboard and says: *"I see the Backend API updated its schemas 2 hours ago. Spawning a council to update our frontend types."*
- **Global Personas (`~/.optimus/personas/` or MCP `agents/`)**: The T2 "斯巴达正规军" (Spartan Regulars) layer. Agents promoted from Local to Global live here, ready to be dispatched into any new workspace.

---

## 🔌 Core Layer: The Spartan Swarm MCP API

To achieve true CLI independence, cross-IDE compatibility, and stateless concurrency, the Orchestrator has been officially re-architected as a standard MCP Server (`optimus-plugin`). **This MCP API is now the definitive foundation of the entire Optimus schema; UI plugins are purely optional secondary layers.**

### Directory Structure & Component Mapping
```text
optimus-plugin/
├── .claude-plugin/              
│   └── plugin.json              # Plugin manifest and definitions
├── .mcp.json                    # MCP Server definition (Registers the Node.js backend)
├── skills/                      # Northbound Layer: Cognitive behaviors for Master Agent
│   ├── council-review/SKILL.md  # Triggers `dispatch_council` tool
│   └── delegate-task/SKILL.md   # Triggers `execute_worker` tool
├── agents/                      # T2 Layer: Globally promoted Spartan Regulars
│   ├── security-expert.md       
│   └── refactoring-architect.md 
└── scripts/                     # Midplane & Southbound: The Controller & Spawner
    ├── mcp-server.js            # Extends Model Context Protocol
    ├── controller.js            # Implements T3->T1->T2 Cascade Assembly and Singleton Locks
    └── worker-spawner.js        # Spawns headless sub-CLI instances
```

### Functional Modules
1. **The Cognitive Layer (`skills/`)**: Overrides the Master Agent's behavior, teaching it to draft `PROPOSAL.md` and use the native MCP tools (like `roster_check` and `delegate_task`). 
2. **The MCP Facade Server (`scripts/mcp-server.js`)**: The "Marionette Controller" exposing stateless JSON schemas to the LLM while carrying the heavy burden of local concurrency, SQLite isolation (`--session-id`), and directory creation.
3. **The Headless Spawn Engine (`scripts/worker-spawner.js`)**: The underlying Node.js layer that hijacks I/O of tools like Claude Code or Copilot CLI, transforming them into "One-off Functions".

### The "Dumb Tools, Smart Skills" Paradigm (Architectural Principle)
During the transition to MCP, we discovered a core design pattern for Agentic systems: **Do not write complex state machines or routing logic in code (TypeScript/Node); write them in Prompts (Skills).**

* **Anti-Pattern (Hardcoded Logic)**: Building a massive `delegate_task` tool that automatically scans the directory, tries to guess what the user meant, runs an internal heuristics engine to pick a developer, and then spawns it. 
* **The Optimus Pattern**: The MCP layer provides highly atomic, "dumb" tools: `roster_check` (returns a text list of available personas) and `delegate_task` (executes a specific role with a specific task). The complex routing logic—the "3-Step Pre-Dispatch Doctrine" (Camp Inspection -> Manpower Assessment -> Deployment)—is written purely in natural language inside `skills/delegate-task/SKILL.md`.

This outsources the heavy computational routing to the Master Agent's LLM brain. It allows the Orchestrator to dynamically invent new titles (T3 Outsourcing) or make intelligent personnel decisions based on the actual conversation context, all without requiring a single line of traditional front-end control-flow code.
