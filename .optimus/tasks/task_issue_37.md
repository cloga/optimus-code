# Issue Draft: Role-based Explicit Skill Binding for Agents 

**Title:** Feature: Role-based Explicit Skill Binding for Agents (T1/T2)

**Body:**

## Genesis / Why
Currently, agent skills (e.g., delegate_task) are hardcoded globally and injected into every agent's prompt via SharedTaskStateManager.ts. As we introduce more specialized skills like the new git-workflow, injecting all skills into every agent will blow up the context window and cause hallucination. We need a semantic, explicit binding mechanism where each role strictly defines the skills it requires.

## Proposed Design
1. **Extend Role Frontmatter**:
   Add a skills array constraint to the YAML frontmatter of T2 Role templates (optimus-plugin/roles/*.md):
   \\\yaml
   role: dev
   tier: T1
   skills:
     - delegate-task
     - git-workflow
   \\\
2. **Dynamic Skill Loader**:
   Refactor SharedTaskStateManager.ts (or worker-spawner.ts / the adapter layer) to parse the skills frontmatter array during agent instantiation.
3. **Prompt Injection**:
   For each skill listed, read the corresponding optimus-plugin/skills/<skill-name>/SKILL.md (or similar) and append it as \[SYSTEM: INJECTED SKILL - <name>]\ at the bottom of the System Prompt.

## Benefits
* **Token Efficiency**: Roles like \qa-engineer\ or \	echnical-writer\ won't carry unnecessary git/commit baggage.
* **Separation of Concerns**: Extensible "Skill Tree" architecture.
* **Removes Hardcoding**: Cleans up the current global hardcoded injection logic.

## Acceptance Criteria
- [ ] Role YAML supports \skills\ array.
- [ ] Agent bootstrap dynamically reads required skills.
- [ ] Global hardcoding of \delegate_task\ is removed.
- [ ] Non-applicable skills are not injected into the base LLM prompt.
