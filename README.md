# Optimus Code 

> *The Ultimate Multi-Agent Orchestrator. Let models debate, you make the final call.*

##  What is Optimus Code?

Optimus Code is a VS Code extension that acts as an orchestration engine. Rather than being just another tool that sends prompts directly to an API, it transforms various LLM clients into background "workers" via an extensible **Adapter Pattern**. 

It provides a **persistent Chat View in the sidebar**, where you can type your prompts. The engine will summon multiple AI brains globally, gather their architectural plans, and present them in the chat panel simultaneously.

##  Features

*   **Sidebar Chat Interface:** Built with official VS Code UI Toolkit.
*   **Multi-Agent Generation:** Asks Gemini, Claude, and Copilot for their solutions and streams them back to you in one place.
*   **Extensible Adapter System:** Easily add your own AI agents (Doubao, Kimi, DeepSeek etc.) by implementing a simple Interface without touching the core UI code.

##  Getting Started (Developer Guide)

1. Clone this repository and install dependencies:
   `ash
   npm install
   ` 
2. Ensure you have the necessary CLI tools installed (gh copilot and @anthropic-ai/claude-code).
3. Press F5 in VS Code to start debugging.
4. Open the **Optimus Code Activity Bar** on the left.
5. Start chatting and watch the multi-agent council provide their plans!

## 🧪 Recommended Test Prompts (Copy & Paste)

When running the extension locally via F5, try pasting these prompts into the Optimus Code sidebar chat to test the side-by-side capabilities of the different configured agents:

### 1. Algorithm & Code Quality
> "Write a robust, type-safe deep clone function in TypeScript. Include comments explaining how you handle circular references and special objects like Date or Regex."
*Tests raw coding ability and TypeScript syntax formatting.*

### 2. System Architecture
> "Design a distributed rate-limiting system for a highly trafficked API. Explain the components, the storage layer (e.g., Redis), and provide a basic Node.js implementation example."
*Compares how different models plan macro-architecture and structure long-form Markdown.*

### 3. Frontend / UI Generation
> "Give me a single-file HTML/JS/CSS implementation of a sleek Kanban board column that accepts dragged items. Use modern Flexbox."
*Tests the Markdown rendering in your VS Code Webview (specifically for large code blocks).*

### 4. Agentic Local Workspace Reading (e.g., Claude Code CLI)
> "Analyze the current workspace. Look into the `src/` directory and summarize what this VS Code extension does."
*Tests infinite-timeout streaming and whether the underlying CLI tool correctly utilizes local file-reading skills.*
