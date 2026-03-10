---
name: council-review
description: Orchestrates a parallel Map-Reduce architectural review by spawning multiple specialized expert agents to critique a proposal.
---

This project utilizes an artifact-driven "Blackboard Pattern". The actual "Experts" are implemented by the underlying Optimus MCP Subsystem which spins up physically isolated, concurrent background CLI worker processes (The Spartan Workers).

## How to execute a Council Review:

### Step 1: Draft the Initial Proposal (The Scatter)
1. Do your initial analysis of the user's request.
2. Draft your preliminary design.
3. Write this design securely to the Blackboard as a markdown file. To prevent parallel conflicts from multiple requests running at the same time, give it a unique name per task: e.g., `.optimus/PROPOSAL_<task_topic>.md`.

### Step 2: Request the Council Dispatch via MCP Tool
1. Tell the user you have finalized the `PROPOSAL_<task_topic>.md` and are requesting the Orchestrator to dispatch the expert council.
2. You MUST use your available MCP tool `dispatch_council_async` (preferred) or `dispatch_council` to trigger the underlying concurrency engine.
3. Pass the `proposal_path` and the `roles` (array of strings) of the experts you want to summon.

**(Experts are instantiated entirely on-demand dynamically using the T3->T1->T2 Cascade Rule. Just use descriptive role names.)**

Commonly requested dynamic roles:
- `performance-expert`: Evaluates Big-O complexity, database query counts.
- `security-expert`: Checks for injection vectors, auth/authz bypass.
- `refactoring-architect`: Identifies code smelles, outlines clean abstractions.

### Step 3: Await and Read The Reviews (The Gather)
1. If using `dispatch_council_async`, the tool will return a `taskId`. Use the `check_task_status` tool in a loop (wait 10 seconds between checks) until the task is marked `completed`.
2. The tool (or status check) will return a precise folder path matching the isolated execution timestamp: (e.g., `.optimus/reviews/<timestamp>/`).
3. Once the tool returns success or is completed, read the generated review files from that directory (e.g., `<role>_review.md`).

### Step 4: Arbitration and Action (The Arbiter)
Analyze the gathered reviews.
- **If there are NO blockers**: Implement the suggestions and output the final `.optimus/TODO.md` file (the implementation backlog).
- **If there are FATAL conflicts**: Create `.optimus/CONFLICTS.md` outlining the opposing viewpoints cleanly, pause, and ask the User to arbitrate.