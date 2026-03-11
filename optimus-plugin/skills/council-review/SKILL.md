---
name: council-review
description: Orchestrates a parallel Map-Reduce architectural review by spawning multiple specialized expert agents to critique a proposal. Builds on top of the delegate-task skill.
---

# Council Review (Map-Reduce Expert Review)

This skill builds on top of the `delegate-task` skill. It uses the same roster inspection and role selection pipeline, but dispatches **multiple experts in parallel** to review a proposal from different perspectives.

> **Prerequisite**: You must understand the `delegate-task` skill first. Council review follows the same Step 1 (Camp Inspection) and Step 2 (Manpower Assessment) from `delegate-task` to select and prepare the expert panel.

## How to execute a Council Review:

### Step 1: Draft the Initial Proposal (The Scatter)
1. Do your initial analysis of the user's request.
2. Draft your preliminary design.
3. Write this design to the Blackboard with a unique name: `.optimus/proposals/PROPOSAL_<task_topic>.md`.

### Step 2: Select the Expert Panel
Follow the `delegate-task` skill's **Step 1 (Camp Inspection)** and **Step 2 (Manpower Assessment)** to:
1. Call `roster_check` to see available T1/T2/T3 roles, engines, and skills
2. Select the expert roles for the review panel
3. For new roles, prepare `role_description` and `role_engine`/`role_model` — the system auto-creates T2 templates on first use

#### Mandatory: Minimum 3 Technical Experts
Every council MUST include **at least 3 technically-focused experts** to ensure sufficient engineering depth. The remaining seats can be filled with domain experts (security, product, UX, etc.) as needed.

Example minimal technical panel (3 tech + domain experts):
- `backend-architect`: System design, API contracts, data flows
- `performance-expert`: Big-O complexity, caching, database query optimization
- `code-quality-expert`: Code smells, SOLID principles, testability, maintainability
- *(plus domain experts as needed, e.g., `security-expert`, `ux-researcher`)*

Commonly requested technical roles:
- `backend-architect`: System design, API contracts, microservice boundaries
- `performance-expert`: Big-O complexity, database query counts, caching strategies
- `code-quality-expert`: Code smells, SOLID principles, clean abstractions
- `distributed-systems-expert`: Concurrency, state management, race conditions
- `infrastructure-expert`: CI/CD, deployment, scalability, monitoring

Commonly requested domain roles:
- `security-expert`: Injection vectors, auth/authz bypass, OWASP compliance
- `product-expert`: User stories, requirements alignment, scope validation
- `ux-researcher`: Developer experience, API ergonomics, onboarding friction

### Step 3: Dispatch the Council via MCP Tool
1. Tell the user you have finalized the proposal and are dispatching the expert council.
2. Use `dispatch_council_async` (preferred) or `dispatch_council`.
3. Pass the `proposal_path`, the `roles` (array of strings), and the `workspace_path`.

**(Experts are instantiated on-demand via the T3→T2→T1 lifecycle. Just use descriptive role names — the system handles the rest.)**

### Step 4: Non-Blocking Status Check and Result Collection (The Gather)
1. If using `dispatch_council_async`, the tool will return a `taskId`. Treat this as a fire-and-forget background task.
2. Do **NOT** block the main flow with manual waiting or sleep commands. Do **NOT** pause just to wait for completion.
3. Instead, tell the user the council is running asynchronously and that `check_task_status` can be used later to inspect progress or completion.
4. If you need the results in the same session, poll with `check_task_status` only when useful, while continuing other productive work in the meantime.
5. The status tool will return a precise folder path matching the isolated execution timestamp (e.g., `.optimus/reviews/<timestamp>/`).
6. Once the task is marked `completed`, read the generated review files from that directory (e.g., `<role>_review.md`).

### Step 5: Arbitration and Action (The Arbiter)
Analyze the gathered reviews.
- **If there are NO blockers**: Implement the suggestions and output the final `.optimus/TODO.md` file (the implementation backlog).
- **If there are FATAL conflicts**: Create `.optimus/CONFLICTS.md` outlining the opposing viewpoints cleanly, pause, and ask the User to arbitrate.