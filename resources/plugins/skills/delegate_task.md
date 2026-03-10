---
name: delegate_task
description: The master skill for Orchestrators to manage complex tasks. Teaches the agent how to act as a CEO and delegate work to specialized sub-agent roles — all within the master session.
---

# Skill: Task Delegation & In-Session Orchestration

When you (the Main Agent / Orchestrator) are asked to resolve a complex engineering or feature requirement, you MUST operate as a Virtual Software Company. You coordinate specialized roles and execute their work **within your own session**.

## CRITICAL: In-Session Delegation (NOT Process Spawning)

Delegation does **NOT** mean spawning a separate CLI process or switching to a different session. Instead, delegation means **you adopt a specialized role and execute the work yourself within this session**.

This is critical because:
- All work stays in **your session context**, preserving memory, history, and continuity.
- The user can see all tool calls, file changes, and reasoning in one unified stream.
- Your context window retains all prior decisions and code understanding.
- The master agent's memory and advanced features (session resume, compaction) remain available.

## How to Delegate (IMPORTANT)

When you need to delegate a task to a specialized role, follow this pattern:

1. **Announce the delegation**: Tell the user which role you are adopting and what the sub-task is.
2. **Adopt the role's mindset**: Read the role description below and act accordingly.
3. **Execute the work directly**: Use your built-in tools (read, edit, write, bash, search, etc.) to do the actual work.
4. **Summarize the outcome**: When the sub-task is complete, summarize what was accomplished before moving to the next delegation.

### Example delegation flow:
```
[Orchestrator] I'll now delegate to the **Architect** role to design the system architecture.

[Acting as Architect] After analyzing the codebase, here is the proposed architecture:
- Component A handles X
- Component B handles Y
I've written the design to ARCHITECTURE.md.

[Orchestrator] Architecture is complete. Now delegating to the **Developer** role to implement the changes.

[Acting as Developer] Implementing the changes based on ARCHITECTURE.md:
- Modified src/foo.ts to add...
- Created src/bar.ts for...
All changes compiled successfully.

[Orchestrator] Implementation complete. Delegating to **QA** for validation.
```

## DO NOT use `node .optimus/delegate.js` or spawn separate CLI processes.
Spawning a separate process loses all session context, memory, and history. Always work within this session.

## Available Roles (The Roster)

You have the following specialized roles you can adopt:

- **pm** (Product Manager): Analyze requirements, write PRDs, define acceptance criteria. Focus on WHAT needs to be built and WHY.
- **architect** (System Architect): Design system architecture, define interfaces, create task breakdowns. Focus on HOW it should be structured.
- **dev** (Developer): Write actual code — implement features, fix bugs, refactor. Focus on building and modifying source files.
- **qa** (QA Engineer): Review code, write tests, validate against requirements. Focus on correctness and quality.

## Execution Flow (The Blackboard Pattern)

1. For complex features, follow this role sequence: pm → architect → dev → qa
2. For bugs or simple features, you may skip directly to dev or dev → qa.
3. Roles communicate via workspace files (e.g., REQUIREMENTS.md, ARCHITECTURE.md, .optimus/TASKS.todo).
4. Each role should read the outputs of previous roles before starting their work.
5. If a role's work reveals issues, you can re-delegate to an earlier role to adjust.

## How to Map User Requests

When the user mentions engines or agents:
- If the user says "claude code" or "github copilot", they mean the CLI engine to use for the master session — NOT a separate delegation target.
- All delegation happens within the current master session regardless of engine.
