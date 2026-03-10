<div align="center">
  <h1> Optimus Code</h1>
  <p><b>The Ultimate Multi-Agent Orchestrator. Let the AI Council debate, you make the final call.</b></p>
  
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Framework: Model Context Protocol](https://img.shields.io/badge/MCP-Native-brightgreen.svg)](#)
</div>

---

##  What is Optimus Code?

Optimus Code isn't just another chat wrapper. It is a powerful **VS Code Orchestration Engine** that transforms isolated LLM clients (like *GitHub Copilot CLI*, *Claude Code*, and *DeepSeek*) into a synchronized swarm of background "workers".

By injecting the **Model Context Protocol (MCP)** and a highly advanced local blackboard architecture, Optimus allows entirely different AI models to **collaborate**, **debate**, and **execute** complex software engineering tasks autonomously right inside your editor.

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

Are you ready to orchestrate the Swarm? 

1. **Clone & Install**:
   \\\ash
   git clone https://github.com/cloga/optimus-code.git
   cd optimus-code
   npm install
   \\\
2. **Environment Setup**: Ensure you have CLI tools (like \@anthropic-ai/claude-code\) and your \.env\ configured with \GITHUB_TOKEN\ for Native PR tracking.
3. **Launch the Engine**: Press <kbd>F5</kbd> in VS Code to start the Extension Development Host.
4. **Deploy the Swarm**: Open the **Optimus Code Activity Bar** on the left, type a complex request (e.g., *"Refactor our auth system"*), and watch the council get to work!

---

##  Try it Yourself! (Test Prompts)

Copy these into the Optimus chat window to test the multi-agent engine:

- **The Council Test**: *"Design a distributed rate-limiting system for a highly trafficked API using Redis. Let the security and performance agents debate the implementation."*
- **The SDLC Flow**: *"Create an Epic on GitHub to track migrating our CSS to Tailwind, then open a local PR for the initial config file."*
- **Agentic File Reading**: *"Analyze the current workspace. Look into the \src/mcp/\ directory and summarize the native Node tools."*

---

>  *Built for the future of software engineering. Stop prompting, start orchestrating.*
