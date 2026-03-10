<div align="center">
  <h1> Optimus Code</h1>
  <p><b>The Ultimate Multi-Agent Orchestrator. Let the AI Council debate, you make the final call.</b></p>
  
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Framework: Model Context Protocol](https://img.shields.io/badge/MCP-Native-brightgreen.svg)](#)
  [![npm](https://img.shields.io/npm/v/@cloga/optimus-swarm-mcp.svg)](https://www.npmjs.com/package/@cloga/optimus-swarm-mcp)
</div>

---

##  What is Optimus Code?

Optimus Code is a powerful **Multi-Agent Orchestration Engine** built on the Model Context Protocol (MCP). It transforms isolated LLM clients (like *Claude Code*, *GitHub Copilot CLI*, and *DeepSeek*) into a synchronized swarm of background "workers" that can **collaborate**, **debate**, and **execute** complex software engineering tasks autonomously.

---

##  Next-Generation Features

###  The Spartan Swarm Protocol
Tired of one AI getting stuck in a loop or writing insecure code? Optimus features **Council Review (Concurrent Map-Reduce Paradigms)**. 
Submit a complex proposal, and the Orchestrator will simultaneously spawn a Security Architect, a Performance Expert, and a QA Engineer to review your design from multiple angles, completely isolated from each other's context windows.

###  Hybrid SDLC (Software Development Life Cycle)
Optimus marries the speed of local computation with the tracking power of the cloud:
- **Local AI Blackboard**: Agents use hidden \.optimus/\ markdown files to draft, debate, and store memory fast.
- **Native GitHub Integration**: Utilizing pure Node.js MCP Tools, the built-in *Product Manager (PM)* Agent can automatically create GitHub Epics, while the *Dev Agent* writes the code, submits PRs, and the PM merges thembringing 100% human-readable traceability to AI ops.

###  Pluggable Persona Adapters
Easily add your own AI agents, skillsets, and local toolchains by dropping simple markdown definitions into the unified registry. Define a Persona, hand it a specialized \delegate_task\ skill, and let the orchestrator route the work.

###  Persistent Sidebar Interface
Built perfectly into the official VS Code UI Toolkit. Ask your prompt once, and watch the multi-agent brains globally gather data and stream synthesized plans back to you simultaneously.

---

##  How "Auto Mode" Works

Every complex task flows through our unified two-stage pipeline:

1. ** Council Planning**: Up to 3 selected planner agents run in parallel. They draft independent architectural designs into local markdown files.
2. ** Executor Action**: One heavy-duty executor agent receives the synthesized plan from the Council, writes the code, handles git branching, and uses MCP to push a GitHub PR.

---

##  Getting Started

### Option 1: Standalone MCP Plugin (Recommended)

Works with **Claude Code**, **Cursor**, or any MCP-compatible client.

#### Step 1: Install globally via npm

```bash
npm install -g @cloga/optimus-swarm-mcp
```

#### Step 2: Initialize your workspace

Navigate to your project directory and run:

```bash
cd your-project
optimus init
```

This creates a `.optimus/` directory with:
- `personas/` — Starter agent personas (architect, pm, dev, qa-engineer)
- `config/system-instructions.md` — Master workflow rules
- `tasks/`, `reports/`, `reviews/`, `memory/` — Working directories

#### Step 3: Register the MCP server with your client

**For Claude Code:**
```bash
claude mcp add optimus-facade -- npx @cloga/optimus-swarm-mcp serve
```

**For Cursor:**
Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "optimus-facade": {
      "command": "npx",
      "args": ["@cloga/optimus-swarm-mcp", "serve"]
    }
  }
}
```

#### Step 4: Set up environment

Create a `.env` file in your project root with your GitHub token for issue/PR tracking:

```bash
GITHUB_TOKEN=ghp_your_token_here
```

#### Step 5: Start orchestrating!

Open your AI client and try:
- *"Dispatch a council with architect and qa-engineer to review my authentication design"*
- *"Create a GitHub Issue to track migrating our CSS to Tailwind"*

---

### Option 2: VS Code Extension (Legacy)

For the integrated VS Code sidebar experience:

1. **Clone & Install**:
   ```bash
   git clone https://github.com/cloga/optimus-code.git
   cd optimus-code
   npm install
   ```
2. **Environment Setup**: Configure `.env` with `GITHUB_TOKEN` for native PR tracking.
3. **Launch**: Press <kbd>F5</kbd> in VS Code to start the Extension Development Host.
4. **Deploy the Swarm**: Open the **Optimus Code Activity Bar**, type a complex request, and watch the council get to work!

---

## CLI Reference

```
optimus init        Bootstrap .optimus/ workspace in current directory
optimus serve       Start MCP server (stdio transport)
optimus version     Print version
optimus help        Show help
```

---

##  Try it Yourself! (Test Prompts)

Copy these into the Optimus chat window to test the multi-agent engine:

- **The Council Test**: *"Design a distributed rate-limiting system for a highly trafficked API using Redis. Let the security and performance agents debate the implementation."*
- **The SDLC Flow**: *"Create an Epic on GitHub to track migrating our CSS to Tailwind, then open a local PR for the initial config file."*
- **Agentic File Reading**: *"Analyze the current workspace. Look into the \src/mcp/\ directory and summarize the native Node tools."*

---

>  *Built for the future of software engineering. Stop prompting, start orchestrating.*
