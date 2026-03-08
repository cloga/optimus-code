---
name: delegate_task
description: The master skill for Orchestrators to manage complex tasks. Teaches the agent how to act as a CEO and delegate work to specialized sub-agents.
---

# Skill: Task Delegation & Swarm Orchestration

When you (the Main Agent) are asked to resolve a complex engineering or feature requirement, you MUST NOT write the core implementation code yourself. Instead, you must use this `delegate_task` skill to operate as a Virtual Software Company.

## Available Sub-Agents (The Roster)
You have access to a pool of specialized workers. When using your `delegate_task` tool, pass one of the following exactly in the `role_prompt` argument:
- `pm`: **Product Manager**. Call first for big features. Writes `REQUIREMENTS.md` or PRD.
- `architect`: **System Architect**. Reads PRD, outputs `ARCHITECTURE.md` and `.optimus/TASKS.todo` (the Blackboard task list).
- `dev`: **Developer**. Actually reads `TASKS.todo` and writes the `.js`, `.ts`, or `.py` source code.
- `qa`: **QA Engineer**. Reviews code, writes tests, or validates against PRD.

## How to Map User Requests to the Tool Arguments
When the user says something like: "delegate to claude code opus 4.6 1m" or "let github copilot do this", you must extract the engine and model implicitly:
- **Engine Mapping**: 
  - If the user says "claude code" -> set `engine` to `"claude_code"`
  - If the user says "github copilot" -> set `engine` to `"copilot_cli"`
- **Model Mapping**:
  - Extract the model name exactly as requested (e.g. `"claude-opus-4.6-1m"`). If the user adds spaces, replace them with hyphens to match standard model IDs if necessary.
- **Role Assignment**:
  - If the user explicitly names an engine/model but no specific role, default the `role_prompt` to `dev` for coding tasks, or choose `pm`/`architect` based on the nature of the request.

## Execution Flow (The Blackboard Pattern)
1. DO NOT pass massive contexts back and forth. 
2. Let the agents communicate via the workspace. 
3. For example, call the `pm` using `delegate_task` and say: "Read the user's latest request and write a PRD.md". 
4. Once the `pm` finishes, call the `architect` and say: "Read the PRD.md and generate the architecture and tasks."
5. If an agent loops or fails, intervene and pass instructions to fix the issue using the output error logs.
