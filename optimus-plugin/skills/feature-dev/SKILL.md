---
name: feature-dev
description: Guided 6-phase feature development workflow. Use when the user requests a new feature, complex implementation, or multi-file change. Master Agent communicates requirements and clarifying questions with the user, then delegates to PM who orchestrates exploration, architecture, implementation, and review.
---

# Feature Development Workflow

A structured 6-phase approach to building features. Master Agent handles user
communication, PM handles technical orchestration.

## Orchestration Model

```
User ↔ Master Agent (Phase 1: requirements + questions)
           │
           └→ delegate_task_async → PM (Phase 2-6)
                ├─ Phase 2: delegate_task (sync) → code-explorer
                ├─ Phase 3: dispatch_council (sync) → code-architect ×2-3
                ├─ Phase 4: delegate_task (sync) → senior-dev
                └─ Phase 5: dispatch_council (sync) → code-reviewer ×3
```

---

## Phase 1: Requirements & Clarifying Questions (Master Agent ↔ User)

**Who**: Master Agent talks directly with the user. NOT delegated.

**Goal**: Gather enough context so PM can work independently.

1. Understand what the user wants built — the problem, expected behavior, constraints
2. Proactively identify ambiguities that will block downstream work:
   - Edge cases and error handling expectations
   - Integration points with existing code
   - Scope boundaries (what's in vs. out)
   - Performance requirements
   - Backward compatibility concerns
3. Ask the user **all questions in one organized list** — avoid back-and-forth drip
4. Once answers are collected, bundle everything into a clear task description for PM

**Output**: A comprehensive task description that includes the feature request
AND all clarified requirements. PM should be able to work without asking the
user anything.

---

## Phase 2: Codebase Exploration (PM → code-explorer, sync)

**Who**: PM delegates to `code-explorer` using `delegate_task` (synchronous).

**Goal**: Understand the relevant codebase before designing.

PM delegates with a prompt like:
- "Explore the codebase to understand [feature area]. Trace execution paths,
  map architecture layers, identify patterns and key files."

PM reads the explorer's report and synthesizes key findings:
- Existing patterns and conventions
- Key files and integration points
- Dependencies and potential risks

---

## Phase 3: Architecture Design (PM → code-architect ×2-3, council sync)

**Who**: PM uses `dispatch_council` (synchronous) with 2-3 `code-architect` roles.

**Goal**: Design the implementation approach.

Each architect gets a different focus:
- **Minimal changes**: Smallest diff, maximum reuse
- **Clean architecture**: Maintainability, elegant abstractions
- **Pragmatic balance**: Speed + quality

PM reads all architecture proposals, selects the best approach (or synthesizes
a hybrid), and documents the chosen design.

---

## Phase 4: Implementation (PM → senior-dev, sync)

**Who**: PM delegates to `senior-dev` using `delegate_task` (synchronous).

**Goal**: Build the feature.

PM provides the dev with:
- The chosen architecture from Phase 3
- Key files identified in Phase 2
- All clarified requirements from Phase 1
- Required skills: `["git-workflow"]`

The dev will:
1. Create a feature branch
2. Implement the chosen architecture
3. Build and verify
4. Create and merge PR

---

## Phase 5: Quality Review (PM → code-reviewer ×3, council sync)

**Who**: PM uses `dispatch_council` (synchronous) with 3 `code-reviewer` roles.

**Goal**: Ensure code quality.

Each reviewer focuses on a different dimension:
- **Simplicity & DRY**: Code quality and maintainability
- **Bugs & Correctness**: Logic errors, edge cases, security
- **Conventions**: Project patterns and standards

If critical issues found → PM delegates back to `senior-dev` for fixes.
If clean → proceed to summary.

---

## Phase 6: Summary (PM)

**Who**: PM wraps up.

**Goal**: Document what was accomplished.

PM summarizes:
- What was built
- Key decisions made
- Files modified
- Suggested next steps (tests, docs, follow-ups)

Updates the VCS work item via `vcs_add_comment` with the completion summary.
