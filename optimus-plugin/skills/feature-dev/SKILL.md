---
name: feature-dev
description: End-to-end feature development — from requirements to merged code. Use when the user asks to build a feature, implement a change that touches multiple files, add a new capability, or do anything that benefits from understanding the codebase before coding. Even if the user says "just add X", use this skill if X requires understanding existing patterns.
---

# Feature Development

Build features the right way: understand the codebase first, clarify ambiguities
before designing, design before coding, and review before shipping. Each phase
produces a concrete artifact that feeds the next — no phase operates on
assumptions.

Why this order matters: coding without understanding the codebase produces code
that fights existing patterns. Designing without clarifying requirements produces
architecture that solves the wrong problem. Reviewing after merge is too late.

## Required Tools

| Tool | Used In | Purpose |
|------|---------|---------|
| `delegate_task` | Phase 1, 4 | Sync delegation to PM and dev |
| `delegate_task_async` | Phase 2-6 handoff | Async delegation to PM for autonomous phases |
| `dispatch_council` | Phase 2, 3, 5 | Parallel expert exploration / design / review |
| `check_task_status` | After async dispatch | Monitor PM progress |
| `vcs_create_work_item` | Phase 1 | Create tracking issue |
| `vcs_add_comment` | Phase 6 | Update work item with summary |
| `roster_check` | Before delegation | Verify roles exist |

## Required Roles

| Role | Used In | Purpose |
|------|---------|---------|
| `pm` | Phase 1-6 | Orchestrates the entire workflow |
| `code-explorer` | Phase 2 | Traces codebase execution paths and patterns |
| `code-architect` | Phase 3 | Designs implementation approaches |
| `dev` | Phase 4 | Implements the chosen architecture |
| `code-reviewer` | Phase 5 | Reviews code quality, bugs, conventions |

## Required Skills (for dev in Phase 4)

| Skill | Purpose |
|-------|---------|
| `git-workflow` | Branch → build → PR → merge workflow |

## How it works

Master Agent talks to the user, then hands everything to PM. PM runs the rest
autonomously — exploring the codebase, designing architecture, delegating
implementation, and reviewing quality. The user doesn't need to be involved after
Phase 1.

```
User ↔ Master Agent
           │
           ├─ Phase 1 (sync): Master ↔ PM — align on requirements
           │
           └─ Phase 2-6 (async): PM runs autonomously
                ├─ 2. Explore codebase (council → code-explorer ×2-3)
                ├─ 3. Design architecture (council → code-architect ×2-3)
                ├─ 4. Implement (delegate → dev)
                ├─ 5. Review quality (council → code-reviewer ×3)
                └─ 6. Summarize and close
```

---

## Phase 1: Requirements Alignment

**Master ↔ PM (sync)** · Output: requirements doc

Master sends the user's request to PM. PM reads it and asks back:
- What's unclear or underspecified?
- What edge cases need decisions?
- What scope is in vs. out?
- What existing behavior must not break?

Master answers from user context. PM writes a requirements doc at
`.optimus/tasks/requirements_<feature>.md` that's complete enough for all
downstream work. After this, no more user interaction.

---

## Phase 2: Codebase Exploration

**PM → code-explorer ×2-3 (council, sync)** · Output: enriched requirements doc

PM dispatches 2-3 explorers, each looking at a different angle of the codebase.
Tailor the prompts to the specific feature — don't use generic exploration:

- If building auth: "Trace the current auth flow from login to session creation.
  List 5-10 key files."
- If adding an API: "Map existing API patterns — routing, middleware, error
  handling. List key files."
- If modifying the build: "Trace the build pipeline and identify extension points.
  List key files."

The explorers will surface questions about how code works. PM answers these using
the requirements doc — providing business context the explorers lack.

After reading the explorer reports and the key files they identify, PM updates
the requirements doc with project context: which patterns to follow, which files
to touch, what risks exist.

---

## Phase 3: Architecture Design

**PM → code-architect ×2-3 (council, sync)** · Output: chosen architecture

PM sends each architect the enriched requirements doc. Each architect designs
from a different angle:
- **Minimal**: smallest diff, maximum reuse
- **Clean**: best abstractions, long-term maintainability
- **Pragmatic**: best balance of speed and quality

PM reads all proposals, picks the best fit (or synthesizes a hybrid), and
documents the decision with rationale. The chosen architecture specifies exactly
which files to create, modify, and how they connect.

---

## Phase 4: Implementation

**PM → dev (sync, with git-workflow)** · Output: merged PR

PM provides the dev with everything accumulated so far:
- Chosen architecture (Phase 3)
- Key files and patterns (Phase 2)
- Requirements and context (Phase 1)
- Required skills: `["git-workflow"]`

Dev creates a branch, implements, builds, verifies, creates PR, and merges.

---

## Phase 5: Quality Review

**PM → code-reviewer ×3 (council, sync)** · Output: clean or fix list

Three reviewers, three lenses:
- **Quality**: simplicity, DRY, readability, elegance
- **Correctness**: logic errors, edge cases, security
- **Conventions**: project patterns, naming, error handling

PM reads all reviews and ranks issues by severity. Critical issues go back to
dev for fixes (then re-review). Clean results move to summary.

---

## Phase 6: Summary

**PM** · Output: VCS work item update

PM documents:
- What was built and the problem it solves
- Key architecture decisions and why
- Files created/modified
- Suggested follow-ups (tests, docs, related features)

Updates the VCS work item via `vcs_add_comment`.
