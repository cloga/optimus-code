<div align="center">
  <h1> Optimus Code</h1>
  <p><b>The Ultimate Multi-Agent Orchestrator. Let the AI Council debate, you make the final call.</b></p>
  
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Framework: Model Context Protocol](https://img.shields.io/badge/MCP-Native-brightgreen.svg)](#)
</div>

---

##  What is Optimus Code?

Optimus Code is a powerful **Multi-Agent Orchestration Engine** built natively on the Model Context Protocol (MCP). It acts as a background daemon (Orchestrator) that transforms isolated IDEs (like *Claude Code*, *Cursor*, *Windsurf*) into a synchronized swarm of background workers that can **collaborate**, **debate**, and **execute** complex software engineering tasks autonomously.

> **Architecture Shift:** Optimus is a **pure MCP Server Plugin**, meaning it is 100% editor-agnostic. No VS Code extension required. It separates your **Data** (roles, skills, and memory in .optimus/) from the **Engine** (npx stream execution), ensuring zero-bloat.

---

##  Next-Generation Features

###  The Spartan Swarm Protocol
Tired of one AI getting stuck in a loop or writing insecure code? Optimus features **Council Review (Concurrent Map-Reduce Paradigms)**.
Submit a complex proposal, and the Orchestrator will simultaneously spawn a *Chief Architect*, a *PM*, and a *QA Engineer* to review your design from multiple angles, completely isolated from each other's context windows to prevent hallucination bleed.

###  Hybrid SDLC (Software Development Life Cycle)
Optimus marries the speed of local computation with the tracking power of the cloud:
- **Local AI Blackboard**: Agents use hidden \.optimus/\ markdown files and task queues to draft, debate, and store long-term memory fast.
- **Native GitHub Integration**: Powered by pure Node.js MCP Tools, the built-in *PM* Agent can automatically create GitHub Epics to secure tracking IDs, while the *Dev* writes code, submits PRs, and links them backbringing 100% human-readable traceability to AI operations.

###  Dynamic Role-Based Skill Binding
Easily add your own AI agents and tooling by dropping simple markdown definitions into your workspace. By editing the YAML frontmatter of a Persona (e.g., adding \skills: [git-workflow, delegate_task]\), the MCP daemon dynamically grants new tool-use capabilities to specific agents on the fly.

---

##  Getting Started: Zero-Install Deployment (Recommended)

Thanks to standard NPM architecture, you don't even need to globally install the code. Use standard 
px hooks to keep your project lightweight while always running the latest version!

### Step 1: Initialize the "Soul" (Workspace Config)
Navigate to your target project directory and run the initialization script:
`ash
npx -y github:cloga/optimus-code#main init
`
*Auto-Injection Magic:* This will create a local .optimus/ config folder holding your team's prompts, roles, and skills. It will also auto-detect your tools and transparently inject the PM system instructions directly into CLAUDE.md or .github/copilot-instructions.md.

### Step 2: Mount the "Body" (MCP Server)
Now, hook the Orchestrator Engine to your favorite AI terminal or IDE!

**For Claude Code:**
`ash
claude mcp add optimus-swarm npx -y github:cloga/optimus-code#main serve
`

**For Cursor / Windsurf / Roo Cline:**
Add this directly to your MCP Configuration settings (e.g., \.cursor/mcp.json\):
`json
{
  "mcpServers": {
    "optimus-swarm": {
      "command": "npx",
      "args": ["-y", "github:cloga/optimus-code#main", "serve"],
      "type": "stdio"
    }
  }
}
`

### Step 3: Set up GitHub Environment (Optional but Recommended)
For Issue tracking and PR magic, create a .env file in your project root with your GitHub PAT:
`ash
GITHUB_TOKEN=ghp_your_token_here
`

---

##  Alternative: Global Installation

If you prefer to have the binaries installed locally without npx fetching every time:

`ash
# 1. Install globally
npm install -g cloga/optimus-code#main

# 2. Init specific workspace
optimus init

# 3. Add to your MCP client
claude mcp add optimus-swarm optimus serve
`

---

## CLI Reference

`	ext
optimus init        Bootstrap .optimus/ workspace (rules, roles, skills) in current directory
optimus serve       Start the pure Node.js MCP server daemon (stdio transport)
optimus version     Print version
optimus help        Show help
`

---

##  Try it Yourself! (Test Prompts)

Once your MCP server is mounted, type these into your AI prompt window:

- **The Architect's Swarm**: *"Use the dispatch_council tool to summon the Chief Architect and QA Engineer to review our PROPOSAL.md."*
- **Task Delegation**: *"Use the delegate_task tool to assign the PM to create an Issue tracking the migration to Tailwind CSS."*
- **Roster & Capabilities Check**: *"Run roster_check to see what agents we have available for this project."*

---

>  *Built for the future of software engineering. Stop prompting, start orchestrating.*
