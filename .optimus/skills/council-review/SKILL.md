---
name: council-review
description: Orchestrates a parallel Map-Reduce architectural review by spawning multiple specialized expert agents to critique a proposal. Builds on top of the delegate-task skill.
---

# Council Review (Map-Reduce Expert Review)

<description>
This skill activates when complex architectural decisions, design proposals, or multi-faceted technical problems require expert review from multiple perspectives. It builds on the delegate-task skill to dispatch multiple experts in parallel, creating a Map-Reduce pattern for comprehensive analysis. Triggers include requests for architectural reviews, design critiques, technical feasibility assessments, or when multiple expert opinions are needed before implementation.
</description>

<workflow>
### Step 1: Proposal Preparation (The Scatter)
- **Tool**: File writing capability
- **Parameters**:
  - `file_path`: `.optimus/proposals/PROPOSAL_<task_topic>.md`
  - `content`: Initial analysis and preliminary design
- **Action**: Draft your initial analysis of the user's request and create a preliminary design proposal. Write this to the Blackboard with a unique, descriptive name that reflects the task topic. This proposal will serve as the foundation document for expert review.

### Step 2: Expert Panel Selection (Camp Inspection)
- **Tool**: `roster_check`
- **Parameters**:
  - `workspace_path`: Current project workspace path
- **Action**: Follow the delegate-task skill's roster inspection process to see available T1/T2/T3 roles, engines, and skills. Identify existing experts or prepare to create new ones. Every council MUST include at least 3 technically-focused experts for engineering depth, plus domain experts as needed.

### Step 3: Role Configuration and Preparation
- **Tool**: None (preparation step)
- **Parameters**: N/A
- **Action**: Select and configure the expert panel using these guidelines:
  - **Mandatory Technical Experts (minimum 3)**: backend-architect, performance-expert, code-quality-expert, distributed-systems-expert, infrastructure-expert
  - **Optional Domain Experts**: security-expert, product-expert, ux-researcher, compliance-expert
  - For new roles, prepare role_description and role_engine/role_model parameters
  - Ensure diverse perspectives are represented for comprehensive review

### Step 4: Council Dispatch
- **Tool**: `dispatch_council_async`
- **Parameters**:
  - `proposal_path`: Path to the proposal file created in Step 1
  - `roles`: Array of expert role names (strings)
  - `workspace_path`: Current project workspace path
- **Action**: Dispatch the expert council using the async tool (preferred). Tell the user the proposal is finalized and experts are being dispatched. The system will instantiate experts on-demand via the T3→T2→T1 lifecycle using descriptive role names.

### Step 5: Non-Blocking Result Collection (The Gather)
- **Tool**: `check_task_status`
- **Parameters**:
  - `taskId`: The task ID returned from dispatch_council_async
- **Action**: Treat the council as a fire-and-forget background task. Do NOT block the main flow with waiting or sleep commands. Instead, inform the user the council is running asynchronously. Use check_task_status only when useful while continuing other productive work. Once marked 'completed', read the generated review files from the returned directory path.

### Step 6: Arbitration and Decision Making (The Arbiter)
- **Tool**: File writing capability for outcomes
- **Parameters**:
  - `file_path`: `.optimus/TODO.md` or `.optimus/CONFLICTS.md`
  - `content`: Implementation backlog or conflict resolution document
- **Action**: Analyze the gathered expert reviews and determine next steps:
  - **No blockers**: Implement suggestions and create final implementation backlog (`.optimus/TODO.md`)
  - **Fatal conflicts**: Create conflicts document (`.optimus/CONFLICTS.md`) outlining opposing viewpoints and ask user to arbitrate
</workflow>

<error_handling>
- If `roster_check` fails, THEN proceed with T3 role creation using descriptive names, but document the roster limitation.
- If `dispatch_council_async` fails with role creation error, THEN retry with simplified role descriptions or fallback to individual `delegate_task_async` calls for each expert.
- If proposal file creation fails, THEN use a temporary file path and inform the user of the alternative location.
- If `check_task_status` fails or times out, THEN document the limitation and provide manual instructions for checking `.optimus/reviews/<timestamp>/` directories.
- If expert reviews conflict irreconcilably, THEN create detailed conflict documentation rather than attempting forced consensus.
</error_handling>

<anti_patterns>
- Do not use synchronous `dispatch_council` unless user explicitly requests blocking execution — always prefer async.
- Do not block the conversation waiting for council completion — maintain session responsiveness.
- Do not skip the mandatory minimum of 3 technical experts — insufficient technical depth leads to poor decisions.
- Do not create councils with only domain experts — technical feasibility must be validated.
- Do not enter tight polling loops with `check_task_status` — use sparingly and continue other work.
- Do not simulate or predict expert outputs yourself — let the actual experts provide their reviews.
- Do not proceed with implementation if fatal conflicts exist without user arbitration.
- Do not create vague or generic expert roles — use specific, descriptive role names for better results.
</anti_patterns>

## Expert Panel Guidelines

### Mandatory Technical Experts (minimum 3)
- `backend-architect`: System design, API contracts, microservice boundaries, data flows
- `performance-expert`: Big-O complexity, database query optimization, caching strategies
- `code-quality-expert`: Code smells, SOLID principles, testability, maintainability
- `distributed-systems-expert`: Concurrency, state management, race conditions
- `infrastructure-expert`: CI/CD, deployment, scalability, monitoring

### Common Domain Experts (as needed)
- `security-expert`: Injection vectors, auth/authz bypass, OWASP compliance
- `product-expert`: User stories, requirements alignment, scope validation
- `ux-researcher`: Developer experience, API ergonomics, onboarding friction
- `compliance-expert`: Regulatory requirements, audit trails, data governance

## Synchronous Execution Rule
**CRITICAL**: You MUST use `dispatch_council_async` by default. The synchronous `dispatch_council` tool should ONLY be used if the user explicitly and specifically requests blocking/synchronous execution. Always default to async-first, non-blocking delegation.