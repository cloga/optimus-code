---
name: feature-dev
description: End-to-end feature development — from requirements to merged code. Use when the user asks to build a feature, implement a change that touches multiple files, add a new capability, or do anything that benefits from understanding the codebase before coding. Even if the user says "just add X", use this skill if X requires understanding existing patterns.
---

# Feature Development

Build features the right way: understand the codebase first, clarify ambiguities
before designing, design before coding, review before merging. Each phase
produces a concrete artifact that feeds the next — no phase operates on
assumptions.

Why this order matters: coding without understanding the codebase produces code
that fights existing patterns. Designing without clarifying requirements produces
architecture that solves the wrong problem. Merging without review lets bugs ship.

## Required Tools

| Tool | Used In | Purpose |
|------|---------|---------|
| `delegate_task` | Phase 1, 4 | Sync delegation to PM and dev |
| `delegate_task_async` | Phase 2-6 handoff | Master hands off to PM for autonomous phases |
| `dispatch_council` | Phase 2, 3, 5 | Parallel expert exploration / design / review |
| `vcs_create_work_item` | Phase 1 | Create tracking issue before work starts |
| `vcs_create_pr` | Phase 4 | Dev creates PR (does NOT merge yet) |
| `vcs_merge_pr` | Phase 5 | PM merges after review passes |
| `vcs_add_comment` | Phase 6 | Update work item with summary |
| `roster_check` | Before delegation | Verify roles and skills exist |

## Required Roles

| Role | Used In | Purpose |
|------|---------|---------|
| `product-manager` | Phase 1-6 | Orchestrates the entire workflow |
| `code-explorer` | Phase 2 | Traces codebase execution paths and patterns |
| `code-architect` | Phase 3 | Designs implementation approaches |
| `senior-full-stack-builder` | Phase 4 | Implements the chosen architecture |
| `code-reviewer` | Phase 5 | Reviews code quality, bugs, conventions |

## Required Skills (for dev in Phase 4)

| Skill | Purpose |
|-------|---------|
| `git-workflow` | Branch → build → PR workflow (no merge — PM merges after review) |

## How it works

Master Agent talks to the user, then hands everything to PM. PM runs the rest
autonomously — exploring the codebase, designing architecture, delegating
implementation, and reviewing quality. The user doesn't need to be involved after
Phase 1.

### Session Continuity Rule

When the same role appears in multiple phases, **reuse the same agent instance**
by passing its `session_id`. This preserves project context across phases:

- Phase 1 returns a PM `session_id` → use it for Phase 2-6 handoff
- If a `code-explorer` from Phase 2 is also useful in Phase 5 review, pass its `session_id`
- Phase 4 dev's `session_id` should be reused if re-delegating for fixes after review

How to implement this:
1. After each `delegate_task` or `dispatch_council` completes, capture the `session_id` from the result
2. Store it in the requirements doc or as a local variable
3. Pass it via `session_id` parameter in subsequent `delegate_task` calls to the same role
4. For `dispatch_council`, the system auto-manages sessions per role

This ensures agents accumulate project understanding across phases rather than
starting fresh each time.

### Issue Lineage Rule (MANDATORY)

After you create your Epic's GitHub Issue (e.g., #N via `vcs_create_work_item`), ALL subsequent `delegate_task`, `delegate_task_async`, and `dispatch_council` calls in this workflow MUST include `parent_issue_number: N`. This creates a visible parent→child tree in GitHub so the user can trace the full delegation chain.

Example:
- PM creates Issue #150 for this feature
- PM delegates to dev: `delegate_task({ ..., parent_issue_number: 150 })`
- Dev's auto-created sub-issue will reference "Parent Epic: #150"
- PM dispatches council: `dispatch_council({ ..., parent_issue_number: 150 })`
- Each reviewer's auto-created sub-issue will also reference "#150"

Failure to pass `parent_issue_number` breaks traceability and is considered a protocol violation.

```
User ↔ Master Agent
           │
           ├─ Phase 1 (sync): Master ↔ product-manager — align on requirements
           │   → capture PM session_id
           │
           └─ Phase 2-6 (async): product-manager runs autonomously (same session_id)
                ├─ 2. Explore (council sync → code-explorer ×2-3)
                ├─ 3. Design (council sync → code-architect ×2-3)
                ├─ 4. Implement (delegate sync → senior-full-stack-builder) → capture dev session_id
                ├─ 5. Review + Merge (council sync → code-reviewer ×3)
                │   → if fixes needed, reuse dev session_id from Phase 4
                └─ 6. Summarize and close
```

---

## Phase 1: Requirements Alignment

**Master ↔ product-manager (delegate_task, sync)** · Output: requirements doc

Master sends the user's request to PM. PM reads it and asks back:
- What's unclear or underspecified?
- What edge cases need decisions?
- What scope is in vs. out?
- What existing behavior must not break?

Master answers from user context (PM does NOT talk to the user directly).
PM writes a requirements doc at `.optimus/tasks/requirements_<feature>.md`
that's complete enough for all downstream work.

After this phase, Master hands off to PM via `delegate_task_async` for Phase 2-6.

### Pre-Existing Tracking Issue

If your prompt header contains a "## Tracking Issue" section with an existing Issue number (e.g., #N), that Issue was auto-created by the system to track this task. In that case:
- **DO NOT** create a new Issue via `vcs_create_work_item`
- Use #N as your Epic Issue for all sub-delegations (`parent_issue_number: N`)
- You can also check the `OPTIMUS_TRACKING_ISSUE` environment variable as a fallback

This prevents duplicate Issues from being created for the same task.

---

## Phase 2: Codebase Exploration

**product-manager → code-explorer ×2-3 (dispatch_council, sync)** · Output: enriched requirements doc

PM calls:
```
dispatch_council(
  proposal_path: ".optimus/tasks/requirements_<feature>.md",
  roles: ["code-explorer", "code-explorer", "code-explorer"],
  parent_issue_number: <issue_number>,
  workspace_path: "<project root>"
)
```

Tailor each explorer's focus in the proposal. Example prompts to include:
- "Trace [feature area] execution paths. List 5-10 key files."
- "Map architecture and integration points for [affected components]."
- "Identify patterns, conventions, and risks in [relevant modules]."

PM reads explorer reports and all key files they identify, then updates the
requirements doc with project context: patterns to follow, files to touch, risks.

---

## Phase 3: Architecture Design

**product-manager → code-architect ×2-3 (dispatch_council, sync)** · Output: chosen architecture

PM calls:
```
dispatch_council(
  proposal_path: ".optimus/tasks/requirements_<feature>.md",  // enriched with project context
  roles: ["code-architect", "code-architect", "code-architect"],
  parent_issue_number: <issue_number>,
  workspace_path: "<project root>"
)
```

Each architect designs from a different angle:
- **Minimal**: smallest diff, maximum reuse
- **Clean**: best abstractions, long-term maintainability
- **Pragmatic**: best balance of speed and quality

PM reads all proposals, picks the best fit (or synthesizes a hybrid), and
documents the decision with rationale.

---

## Phase 4: Implementation

**product-manager → senior-full-stack-builder (delegate_task, sync)** · Output: open PR

PM calls:
```
delegate_task(
  role: "senior-full-stack-builder",
  task_description: "<chosen architecture + requirements + key files>",
  required_skills: ["git-workflow"],
  parent_issue_number: <issue_number>,
  output_path: ".optimus/reports/implementation_<feature>.md",
  workspace_path: "<project root>",
  context_files: ["<requirements doc>", "<architecture review files>"]
)
```

Dev creates a branch, implements, builds, verifies, and **creates a PR but does
NOT merge**. The PR stays open for review in Phase 5.

---

## Phase 5: Quality Review + Merge

**product-manager → code-reviewer ×3 (dispatch_council, sync)** · Output: merged or fixed

PM calls:
```
dispatch_council(
  proposal_path: ".optimus/reports/implementation_<feature>.md",
  roles: ["code-reviewer", "code-reviewer", "code-reviewer"],
  parent_issue_number: <issue_number>,
  workspace_path: "<project root>"
)
```

Three reviewers, three lenses:
- **Quality**: simplicity, DRY, readability, elegance
- **Correctness**: logic errors, edge cases, security
- **Conventions**: project patterns, naming, error handling

PM reads all reviews and ranks issues by severity:
- **Critical issues found** → PM delegates back to dev for fixes, then re-reviews
- **Clean** → PM merges the PR via `vcs_merge_pr`

---

## Phase 6: Summary

**product-manager** · Output: VCS work item update

PM documents:
- What was built and the problem it solves
- Key architecture decisions and why
- Files created/modified
- Suggested follow-ups (tests, docs, related features)

Updates the VCS work item via `vcs_add_comment`.
