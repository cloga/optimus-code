# Proposal: MCP Service Abstraction Layer (Blackboard & GitHub)

## 1. Problem Statement
Currently, our Swarm workers interact with their underlying LLM engines via a robust `Adapter` abstraction layer (e.g., `ClaudeCodeAdapter.ts`, `GitHubCopilotAdapter.ts`). 

However, we lack a similar unified abstraction for operating stateful services:
- **The Blackboard** (shared task state, T1 project memory, `.optimus/` directory).
- **GitHub** (Issues, PRs, Comments).

Right now, if an agent wants to update project memory or create a GitHub issue, the mechanism is loosely defined. The user raised a critical point: **"Agents should only interact with our MCP; the MCP should implement an abstraction layer for Blackboard and GitHub, just like we did for the CLIs."**

## 2. Proposed Architecture: MCP Service Abstraction
We propose creating an internal Abstraction Layer inside the Optimus MCP Server. The AI Agents will **only** call standardized MCP tools. The MCP server will handle the underlying complex operations.

### A. Blackboard Abstraction (`mcp-blackboard`)
Instead of an Agent running raw bash commands like `echo "..." >> .optimus/agents/architect.md`, it uses MCP tools:
- `blackboard_read(key)`
- `blackboard_append(key, content)` 
- `blackboard_update_state(task_id, status)`

*The Abstraction handles: File I/O, Atomic Locks (preventing concurrent Swarm workers from corrupting files), and namespace isolation.*

### B. GitHub Abstraction (`mcp-github`)
Instead of the Agent writing Node.js scripts to call the GitHub API (which lacks auth context natively), it uses:
- `github_create_issue(title, body)`
- `github_update_issue(id, state)`
- `github_link_task(issue_id, local_task_id)`

*The Abstraction handles: Authentication, API routing, and mapping Markdown bodies to GitHub's REST/GraphQL structures.*

## 3. Questions for the Council
1. **Internal vs. External MCP**: Should we build the GitHub abstraction internally within our `mcp-server.ts`, or should we mount an external standard `github-mcp-server` and just pass it through?
2. **Blackboard Atomicity**: How should the `mcp-blackboard` implement atomic locks for concurrent Swarm workers (e.g., two T1 agents appending memory simultaneously)?
3. **Agent Interfaces**: Does enforcing that "Agents only interact with our MCP" fully decouple the Agent prompt from the OS/File System, and is that a desirable strict boundary?