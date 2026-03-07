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

### 2. Middle Layer: The Orchestrator Engine & Configuration Manager
The core state-machine and pipeline logic:
*   **Dynamic Setting Injection**: End-users control the `optimusCode.agents` array inside their `settings.json`. By pairing `github-copilot` or `claude-code` Adapters with varying `model` endpoints (e.g. `gpt-5.4`, `claude-opus-4.6`, `gemini-3-pro`), instances inject seamlessly.
*   **Parallel Streaming Router**: Uses strict interfaces (`invoke(prompt, onUpdate)`) bridging output logs (`stdout` and `stderr`) simultaneously towards the UI, keeping high throughput without deadlocks.

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

### Phase 3: Conflict Synthesis (Upcoming)
*   [ ] Read `vscode.window.activeTextEditor` to inject live context automatically.
*   [ ] Allow models to "Review" another model's specific markdown artifact output and point out flaws.
*   [ ] Inject synthetic block replacements back into the workspace utilizing `WorkspaceEdit`.

---
*"In the holy trinity of the Architect (You), the Code Bee (Copilot), and the Reviewer (Claude), you just press the button and sip your coffee."*