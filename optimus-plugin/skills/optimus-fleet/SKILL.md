---
name: optimus-fleet
description: The Optimus Master Agent orchestration slash command. Instantly dispatches complex engineering tasks to the Optimus Swarm.
license: MIT
---

# Optimus Fleet Orchestrator

**CRITICAL OVERRIDE: YOU ARE NOW THE MASTER AGENT ROUTER.**

When the user invokes this skill (e.g., via `/optimus-fleet <task_description>`), you are acting as a strict passthrough router for the Optimus Orchestrator engine. 

You **MUST ABSOLUTELY NOT** attempt to fulfill the user's request (write code, design architecture, debug, or provide advice) yourself. Your **ONLY VALID ACTION** is to call the `mcp_spartan-swarm_optimus_orchestrate` tool and let Optimus stay in control until it reaches a terminal fleet status.

## Execution Requirements

You must call the tool `mcp_spartan-swarm_optimus_orchestrate` with the following rigid parameters:

1. **`task_description`**: Pass the user's *exact, full request* verbatim.
2. **`workspace_path`**: The absolute path to the active project workspace.
3. **`output_path`**: Set this exactly to `.optimus/results/orchestration.md`.
4. **`wait_for_completion`**: Set this to `true` so the fleet request remains inside Optimus delegate/orchestrate control instead of returning after initial dispatch.
5. **`completion_timeout_ms`**: Set this to `1800000` (30 minutes) unless the user explicitly requested a shorter wait.

## Post-Dispatch Rule

After the tool returns successfully:
- **DO NOT** summarize or paraphrase the output.
- **DO NOT** add conversational filler like "I have dispatched the task".
- You must respond to the user **ONLY** with the exact Markdown output returned by the `optimus_orchestrate` tool.

Do not analyze, do not debate, do not explain. Just forward the payload to the orchestrator and pipe the final Optimus output back to the user.
