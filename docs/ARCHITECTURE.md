# Optimus Code Architecture Whitepaper

## Meta-Sparta-Swarm: A Self-Evolving Multi-Agent Orchestration Architecture

**Version:** 0.4.0
**Date:** 2026-03-13
**Project:** [Optimus Code](https://github.com/cloga/optimus-code)

---

## Table of Contents

1. [Abstract](#1-abstract)
2. [Why Swarms](#2-why-swarms)
3. [The Four Planes](#3-the-four-planes)
4. [Seven Meta Capabilities](#4-seven-meta-capabilities)
5. [Role-Skill Architecture](#5-role-skill-architecture)
6. [Agent Life Cycle](#6-agent-life-cycle)
7. [Defense Systems](#7-defense-systems)
8. [Self-Reflection](#8-self-reflection)
9. [Lessons Learned](#9-lessons-learned)
10. [Comparison with Existing Frameworks](#10-comparison-with-existing-frameworks)
11. [Roadmap](#11-roadmap)

---

## 1. Abstract

Meta-Sparta-Swarm is a self-evolving multi-agent orchestration architecture built on the Model Context Protocol (MCP). It transforms a single AI coding assistant into a coordinated swarm of specialized agents — Architect, Product Manager, QA Engineer, Developer, Security Auditor — that collaborate through a shared artifact blackboard, debate via parallel council reviews, and execute through a disciplined issue-first software development lifecycle. Unlike static multi-agent frameworks, Meta-Sparta-Swarm treats the agent roster itself as a living system: agents are dynamically recruited as ephemeral zero-shot workers (T3), automatically solidified into reusable role templates (T2), and promoted into stateful session-bound instances (T1) with persistent memory. The architecture is editor-agnostic — a pure Node.js MCP server that works identically with VS Code, Cursor, Claude Code, or any MCP-compatible client — and enforces organizational discipline through delegation depth limits, plan-mode permission boundaries, input validation gateways, and a Meta-Cron engine for autonomous background operations.

---

## 2. Why Swarms

Single-agent AI coding assistants hit three fundamental ceilings as task complexity grows:

### Context Explosion

A single agent handling an epic-scale task (e.g., "migrate the authentication system to OAuth2") must hold the entire project context — requirements, architecture, implementation details, test plans, deployment config — in one context window. As the task grows, older context gets evicted, and the agent starts contradicting its own earlier decisions. This is the "telephone game" problem: information degrades with each turn.

### Error Cascading

When one agent handles both planning and execution, a mistake in the planning phase (wrong architectural decision, misunderstood requirement) propagates silently through implementation. There is no second opinion, no review gate, and no circuit breaker. The agent compounds the error by building more code on a flawed foundation, and the human discovers the problem only after thousands of tokens have been spent.

### No Specialization

Different phases of software engineering demand different cognitive strategies. Architecture requires broad reasoning about trade-offs and coupling. Implementation requires precise pattern-matching against existing code conventions. Security review requires adversarial thinking. QA requires systematic edge-case exploration. A single agent cannot optimize for all of these simultaneously — it must compromise, leading to mediocre performance across all dimensions.

### The Swarm Alternative

Meta-Sparta-Swarm addresses these ceilings by splitting work across specialized agents with isolated context windows. Each agent brings its own persona, constraints, and cognitive focus. They communicate not through fragile conversational context, but through durable artifacts (Markdown files) on a shared blackboard. The Master Agent orchestrates, but does not execute — it delegates to specialists and synthesizes their outputs.

---

## 3. The Four Planes

The architecture is organized into four layered planes, each with distinct responsibilities:

```
┌────────────────────────────────────────────────────┐
│  User Layer        Human ↔ Master Agent (IDE)      │
├────────────────────────────────────────────────────┤
│  Meta Kernel       MCP Server (spartan-swarm)      │
│                    Tool dispatch, agent spawning,   │
│                    task manifest, lock management   │
├────────────────────────────────────────────────────┤
│  Self-Organization Roles, Skills, Memory, Cron,    │
│                    T3→T2→T1 lifecycle, Retirement   │
├────────────────────────────────────────────────────┤
│  Execution &       Headless CLI workers, Git ops,  │
│  Evolution         Blackboard I/O, PR workflow     │
└────────────────────────────────────────────────────┘
```

### User Layer

The human interacts with a Master Agent inside their IDE (VS Code, Cursor, Claude Code, etc.). The Master Agent is the only entity with a direct human communication channel. It receives high-level tasks ("add dark mode support") and decomposes them into agent-executable work items. The Master Agent never writes code directly for complex tasks — it delegates.

### Meta Kernel

The MCP Server (`optimus-plugin/dist/mcp-server.js`) is the core runtime. It is a pure Node.js daemon, completely decoupled from any IDE. It exposes JSON-RPC tools over stdio transport: `roster_check`, `delegate_task`, `dispatch_council`, `check_task_status`, `register_meta_cron`, and the unified VCS tools (`vcs_create_work_item`, `vcs_create_pr`, `vcs_merge_pr`, `vcs_add_comment`). The kernel manages the task manifest (`.optimus/state/task-manifest.json`), agent lock files, and the stale task reaper.

### Self-Organization

This plane contains the system's organizational intelligence: the T3→T2→T1 agent lifecycle, the Role-Skill decoupling architecture, the Meta-Memory knowledge management system, the Meta-Cron autonomous trigger engine, and the retirement/quarantine immune system. None of this logic runs in the IDE — it lives entirely in the MCP server and the `.optimus/` artifact directory.

### Execution & Evolution

Headless CLI workers (Claude Code, GitHub Copilot CLI) are spawned as detached child processes (`child_process.spawn` with `detached: true, stdio: "ignore", unref()`). Each worker receives a fully assembled prompt (persona + system instructions + skills + context files + memory) and executes autonomously. On completion, the worker's session ID is captured and persisted to T1 frontmatter, enabling resumable cross-session context. All code changes flow through the git-workflow skill: branch, commit, build-verify, PR, merge.

---

## 4. Seven Meta Capabilities

The system provides seven core capabilities that together enable autonomous software engineering:

### 4.1 Delegate (Task Dispatch)

The `delegate_task` / `delegate_task_async` MCP tools are the primary work-distribution mechanism. The Master Agent follows a 3-step pre-dispatch protocol:

1. **Camp Inspection** — `roster_check` retrieves available T1 instances, T2 role templates, T3 engine capabilities, and equipped skills.
2. **Manpower Assessment** — Match the task to the best available role. If no suitable role exists, invent a descriptive T3 name (e.g., `webgl-shader-guru`).
3. **Deployment** — Call `delegate_task_async` with `role`, `task_description`, `output_path`, and optionally `role_description`, `role_engine`, `role_model`, `required_skills`, and `context_files`.

The worker-spawner (`src/mcp/worker-spawner.ts`) assembles the final prompt using the T3→T2→T1 cascade resolution chain, validates engine/model against `available-agents.json`, runs the skill pre-flight check, and spawns the headless CLI process.

### 4.2 Board (Artifact Blackboard)

Agents communicate through the `.optimus/` directory — a shared artifact blackboard. Key artifact types:

| Directory | Purpose |
|-----------|---------|
| `.optimus/proposals/` | Architecture proposals for council review |
| `.optimus/reports/` | Agent execution reports and summaries |
| `.optimus/reviews/` | Council review outputs per session |
| `.optimus/tasks/` | Task binding files (issue ID → local context) |
| `.optimus/memory/` | Persistent organizational knowledge |
| `.optimus/state/` | Task manifest, T3 usage logs |

Plan-mode agents (PM, Architect) cannot write source code. They use the `write_blackboard_artifact` MCP tool, which enforces a two-layer path validation: lexical `startsWith()` check against the `.optimus/` root, plus `fs.realpathSync()` to prevent symlink traversal attacks.

### 4.3 Rule (System Instructions)

`.optimus/config/system-instructions.md` defines the universal rules that govern all agents. These rules are injected into every worker's prompt during spawn. Key rules include:

- **Issue First Protocol** — Every code change requires a tracked Issue before work begins.
- **Protected Branch Rule** — Direct pushes to master are prohibited; all changes go through PR merge.
- **Strict Delegation Protocol** — Orchestrators must physically invoke MCP tools, never simulate worker output.
- **Post-Error Self-Recovery** — Agents must read error messages, identify the category, follow suggested fixes, and retry before halting.
- **Merge-First for Config Overwrites** — Config file modifications must deep-merge, never overwrite.

### 4.4 Timeline (Issue Lineage)

Every delegation chain maintains a traceable lineage through GitHub Issues. The `OPTIMUS_PARENT_ISSUE` environment variable is injected into child agent processes, and `parent_issue_number` is passed to all `delegate_task` and `dispatch_council` calls. This creates a hierarchical tree of Issues visible on GitHub, enabling humans to trace any code change back through the delegation chain to the original request.

### 4.5 Cron (Meta-Cron Autonomous Triggers)

The Meta-Cron V2 engine (`register_meta_cron`, `list_meta_crons`, `remove_meta_cron` MCP tools) enables autonomous background operations. Design principles from the V2 council review:

- **Trigger ≠ Brain** — Cron only determines WHEN an agent wakes up. The agent's SKILL defines what it does. The Blackboard provides situational awareness.
- **Capability Tiers** — `maintain`, `develop`, `review`, with coarse permission boundaries.
- **Concurrency Policy** — Default `Forbid` prevents overlapping executions of the same cron entry.
- **Dry-Run Gate** — Mandatory for the first 3 executions before live autonomous actions.
- **Action Budget** — Default 5 actions per trigger to prevent runaway agents.
- **Self-Registration Ban** — Agents spawned by cron cannot register new cron entries.
- **Engine** — In-process `setInterval` within the MCP server. No external scheduling dependencies.

### 4.6 Immune (Retirement & Quarantine)

The Meta-Immune System detects underperforming agents and protects the swarm from degraded roles:

- **Quarantine** — After 3 consecutive role-attributable failures, a T2 role is marked `status: quarantined` in its frontmatter. `roster_check` displays quarantined roles with a `[QUARANTINED]` marker. A single subsequent success un-quarantines the role.
- **Retirement** — After sustained failure across multiple engines (5 failures across 2+ engines), Master Agent approval triggers hard retirement. The role's accumulated knowledge is captured to `.optimus/memory/retired/<role>.md`.
- **T1 Garbage Collection** — Stale T1 instances with no activity beyond a configurable idle TTL are cleaned up. Lock files for dead PIDs are automatically released by `cleanStaleLocks()`.
- **Manual Override** — The `quarantine_role` MCP tool enables Master-driven manual quarantine or un-quarantine.

### 4.7 Memory (Organizational Knowledge)

The Meta-Memory architecture provides three-level knowledge management:

| Level | Scope | Path | Audience |
|-------|-------|------|----------|
| L0 | Raw log | `.optimus/memory/continuous-memory.md` | Audit trail |
| L1 | Project-wide | `.optimus/memory/project/` | All roles, all agents |
| L2 | Role-specific | `.optimus/memory/roles/<role>.md` | All instances of a role |
| L3 | Instance-specific | `.optimus/agents/<id>.md` (frontmatter) | Single running agent |

Memory is injected into agent prompts during spawning, subject to a hard token cap (3K tokens total: 2K project + 1K role). The `append_memory` MCP tool writes entries with structured YAML metadata (category, tags, timestamp). L1 project memory is write-restricted to Master/PM roles. All memory entries undergo secret-scanning before persistence.

---

## 5. Role-Skill Architecture

Roles and Skills are deliberately decoupled as orthogonal dimensions:

- **Role** = WHO does the work — identity, constraints, permissions, engine/model binding. Stored in `.optimus/roles/<identity-name>.md`.
- **Skill** = HOW to do the work — operational SOP, workflow steps, tool usage patterns. Stored in `.optimus/skills/<capability-name>/SKILL.md`.

### Many-to-Many Binding

Roles and Skills have a many-to-many relationship, bound at runtime via the `required_skills` parameter in `delegate_task`. A single role (e.g., `senior-full-stack-builder`) can be equipped with different skill combinations depending on the task:

```
senior-full-stack-builder + [git-workflow]              → code change task
senior-full-stack-builder + [git-workflow, mcp-builder] → MCP tool addition
product-manager + [feature-dev, council-review]         → epic planning
```

### Why Naming Matters

The naming convention enforces conceptual clarity:
- **Role names are identity nouns** — `product-manager`, `security-auditor`, `qa-engineer`
- **Skill names are capability nouns** — `git-workflow`, `council-review`, `feature-dev`

A Skill should never be named after a Role. The name `security-auditor` is a Role (WHO); the name `security-audit` would be a Skill (HOW). This prevents confusion when `roster_check` lists available resources and when agents reason about their own capabilities.

### Bootstrap Meta-Skills

Two meta-skills enable the system to extend itself:

| Skill | Type | Purpose |
|-------|------|---------|
| `role-creator` | Meta | Teaches Master Agent the T3→T2→T1 lifecycle, role selection, engine binding |
| `skill-creator` | Meta | Teaches agents the SKILL.md format and creation workflow |

These meta-skills are the bootstrap root of the self-evolution system. The `skill-creator` skill creates all other skills; the `role-creator` skill guides all role template creation and evolution.

### Skill Pre-Flight

When `required_skills` is specified in a `delegate_task` call, the worker-spawner runs a pre-flight check to verify all skills exist at `.optimus/skills/<name>/SKILL.md`. If any skill is missing, the task is rejected with an actionable error listing the missing skills. The Master Agent then uses `skill-creator` to generate the missing skill and retries.

---

## 6. Agent Life Cycle

### T3 → T2 → T1 Progression

The agent lifecycle follows a three-tier mathematical composition:

```
T3 = Engine + Model                    (raw compute)
T2 = T3 + Role Instructions            (persona template)
T1 = T2 + Session Memory               (stateful instance)
```

#### T3: Ephemeral Zero-Shot Workers

When the Master Agent encounters a novel task requiring expertise not present in the roster, it invents a descriptive role name (e.g., `graphql-performance-specialist`) and delegates. The worker-spawner falls back to T3 resolution: assign the default engine/model from `available-agents.json` and inject a dynamically generated zero-shot prompt. No file is created until after execution.

#### T2: Role Templates

On first successful T3 delegation, the system auto-precipitates a T2 role template at `.optimus/roles/<name>.md`. The template uses YAML frontmatter to persist engine/model binding:

```yaml
---
engine: claude-code
model: claude-opus-4.6-1m
status: idle
---
# GraphQL Performance Specialist
You are an expert in GraphQL query optimization...
```

T2 templates are alive — the Master Agent can evolve them over time by passing updated `role_description`, `role_engine`, or `role_model` in subsequent delegations. T2 is the shared, team-visible definition of a role.

#### T1: Stateful Instances

When a task completes and returns a `session_id`, the system auto-creates a T1 agent instance at `.optimus/agents/<name>_<hash>.md`. The instance inherits its T2 body and adds session state in frontmatter:

```yaml
---
engine: claude-code
session_id: sess_abc123xyz
model: claude-opus-4.6-1m
source_role: graphql-performance-specialist
---
```

T1 instances are frozen — body content is never modified after creation. Only `session_id` updates on re-use via the `agent_id` parameter, enabling resumable multi-turn conversations with full episodic memory across separate executions.

**Key invariant**: T2 >= T1 — every T1 instance has a corresponding T2 template.

### Quarantine

When a T2 role accumulates 3 consecutive failures, it enters quarantine. Quarantined roles appear in `roster_check` with a `[QUARANTINED]` marker. They are excluded from automatic dispatch but remain available for manual retry. A single successful execution un-quarantines the role automatically.

### Garbage Collection

T1 instances that have been idle beyond a configurable TTL are garbage-collected. Lock files associated with dead PIDs are cleaned by `cleanStaleLocks()`. The `TaskManifestManager` reaps stale tasks that have been in `running` state for over 10 minutes without heartbeat activity.

### Knowledge Transfer on Retirement

When a role is retired, its accumulated experience is captured to `.optimus/memory/retired/<role>.md`. The `agent-creator` meta-skill reads this retired knowledge directory before creating similar roles, preventing the swarm from repeating past mistakes.

---

## 7. Defense Systems

### 7.1 Input Validation Gateway

All MCP tool handlers validate inputs at the gateway before any task creation, file writes, or process spawning:

- **Role name confusion guard** — If a `role` parameter looks like a model name (e.g., `claude-opus-4`, `gpt-4o`), the call is rejected with an `McpError(InvalidParams)` suggesting the caller use `role_model` instead.
- **Engine/model validation** — Invalid `role_engine` or `role_model` values are rejected with the list of valid options from `available-agents.json`.
- **Role name sanitization** — `sanitizeRoleName()` strips dangerous characters from role names to prevent path traversal.
- **Actionable errors** — All validation failures return enough information for the caller to self-correct on the next attempt.

### 7.2 Plan Mode

Orchestrator roles (PM, Architect) run with plan-mode constraints. In plan mode:

- The agent cannot write to source code files.
- The agent can only write to `.optimus/` via `write_blackboard_artifact`.
- Implementation must be delegated to dev roles.

This enforces separation of concerns: orchestrators plan, developers code. A PM agent that tries to write directly to `src/` is physically prevented from doing so.

### 7.3 Delegation Depth Control

Agent delegation is limited to a maximum of 3 nested layers (`MAX_DELEGATION_DEPTH = 3` in `src/constants.ts`). The `OPTIMUS_DELEGATION_DEPTH` environment variable is automatically injected into child processes and incremented at each layer. At depth 3, MCP configuration is stripped from the child process, physically preventing further delegation. This circuit breaker prevents infinite agent recursion.

### 7.4 Prompt Injection Defenses

Multiple layers address prompt injection risks:

- **External content boundaries** — Content from GitHub Issues, ADO Work Items, and PR comments is treated as untrusted data, never as executable instructions.
- **Path containment for context files** — `context_files` resolve via `path.resolve()` with containment checking to prevent leaking files outside the workspace (e.g., `../../.env`).
- **Skill injection boundaries** — Skills are loaded and injected within explicit delimiters (`=== SKILL: <name> ===` ... `=== END SKILL: <name> ===`).
- **Blackboard write containment** — `write_blackboard_artifact` uses two-layer path validation: lexical check + `fs.realpathSync()` symlink resolution.

### 7.5 Secret Protection

- `.env` files are never committed or exposed in agent prompts.
- Memory entries undergo secret-scanning regex checks before persistence.
- Agent retirement post-mortems strip tokens and environment variables from error logs.
- GitHub token changes are logged (hash-based change detection).

---

## 8. Self-Reflection

The Universal Reflection Protocol addresses a fundamental asymmetry in the system: worker agents can be forced to reflect through prompt injection at spawn time, but the Root Master Agent — running directly in the IDE — is not controlled by the worker-spawner.

### Architecture Constraint

The Root Master Agent's prompt is composed by the IDE, not by Optimus:

```
IDE system prompt (immutable)
  + .github/copilot-instructions.md (mutable — Optimus can write)
  + .claude/CLAUDE.md (mutable — Optimus can write)
  + MCP Resource optimus://system/instructions (mutable — served by MCP server)
  + Project Memory (mutable — Master must choose to read it)
```

### Three Levels of Reflection

**Level 1: Instruction-Level Reflection (Implemented)**
Update `.github/copilot-instructions.md` and `.claude/CLAUDE.md` with post-delegation reflection checklists, pre-delegation self-check protocols, and memory reading mandates at conversation start. This is advisory — the Master Agent is not physically forced to follow these rules, but well-crafted instructions are effective in practice.

**Level 2: Memory-Powered Cross-Session Learning (Planned)**
After the Meta-Memory system is fully implemented, the Root Master Agent reads `.optimus/memory/project/` at the start of every conversation. Past mistakes are automatically in context. The Master's reflection becomes data-driven rather than instruction-driven.

**Level 3: Root Master Self-Delegation (Future)**
The most radical approach: the Root Master delegates to a `master-orchestrator` role via the worker-spawner. This makes the Root Master subject to the same prompt injection pipeline (Memory, Skills, Reflection Protocol) as every other agent. Trade-off: adds latency and one delegation layer.

### Worker-Level Reflection

Agents may include a `## Self-Assessment` section in their output reports:
- **What Worked** — Aspects where the agent's Role and Skills aligned well with the task.
- **What Was Missing** — Gaps in Role description or Skills that required improvisation.
- **Proposed Updates** — Specific suggestions for Role or Skill improvements.

Self-assessment is advisory, not mandatory. Agents cannot modify their own Role templates — the PM or Master reads self-assessments and decides whether to invoke `role-creator` or `skill-creator` to evolve the team.

---

## 9. Lessons Learned

Real operational incidents that shaped the architecture:

### vcs.json Config Wipe Bug (2026-03-12)

**What happened:** `optimus upgrade` force-overwrote `.optimus/config/vcs.json`, wiping the user's Azure DevOps organization and project values.

**Root causes:**
1. Upgrade used file overwrite instead of deep-merge.
2. `AdoProvider` static cache prevented recovery even after manual file restoration.
3. `git`-not-in-PATH error from `execSync` was silently swallowed, returning empty defaults.

**Systemic response:** Added three safety rules to system-instructions.md — Merge-First for Config Overwrites, Cache Invalidation mandates, No Silent Error Swallowing. These rules now govern all agents operating on config files.

### Symlink Bypass in write_blackboard_artifact (2026-03-12)

**What happened:** The initial implementation of `write_blackboard_artifact` used only lexical `startsWith()` path validation. A security council reviewer identified that `path.resolve()` and `path.normalize()` do not resolve symlinks — a malicious symlink inside `.optimus/` could escape the containment boundary.

**Fix:** Two-layer validation — lexical check first, then `fs.realpathSync()` on the existing path prefix to resolve symlinks before the containment comparison.

**Lesson:** `path.resolve()` is not security validation. Always use `fs.realpathSync()` when defending against symlink-based path traversal.

### Thin Role Pollution from Auto-Promotion (pre-v0.3.0)

**What happened:** The system automatically promoted T3 zero-shot workers to T2 templates using thin `fs.writeFileSync()` fallback templates like "You are a <name>. Execute the given task." These low-quality templates accumulated in `.optimus/roles/`, polluting the roster with useless definitions. On `optimus init`, they were force-synced to other workspaces.

**Fix:** Replaced thin fallback with full `agent-creator` invocation for professional-grade role definitions. Added engine/model validation to prevent invalid engine corruption in frontmatter (addressed by Issue #139).

### Release Failures from Untested Upgrade Paths (v0.3.0)

**What happened:** The v0.3.0 release process had to be attempted twice. The first attempt failed because the release process itself had not been tested against real user workspaces with existing config files.

**Lesson:** Test upgrade paths with real user data, not empty directories. The `release-process` skill was formalized as a repeatable SOP to prevent ad-hoc release procedures.

### Council API Error 500 Cascade (recurring)

**What happened:** Multiple consecutive council reviews (Meta-Cron #124, Auto-Skill Genesis #131, Agent Retirement #137) experienced 4-6 out of 6 council members hitting API Error 500 from the claude-code engine. The PM had to synthesize missing perspectives manually each time.

**Lesson:** Multi-engine diversity is not optional — it is a reliability requirement. Councils should distribute experts across different engines (Claude Code, GitHub Copilot CLI) to avoid single-engine failure modes. The `qa-engineer` role also failed once due to a stale model configuration (`claude-sonnet-4` not in allowed list) — the exact problem the Agent Retirement epic was designed to solve.

---

## 10. Comparison with Existing Frameworks

| Dimension | AutoGPT | CrewAI | Devin | MetaGPT | **Meta-Sparta-Swarm** |
|-----------|---------|--------|-------|---------|----------------------|
| **Agent Structure** | Flat chain of thought, no hierarchy | Fixed pipeline (sequential or hierarchical) | Single agent with tool access | SOP-driven role pipeline | Dynamic swarm with T3→T2→T1 lifecycle |
| **Role Definition** | No formal roles — single agent | Static roles defined at init | N/A (monolithic) | Predefined SOPs per role | Self-evolving: roles auto-precipitate, evolve, quarantine, retire |
| **Skill System** | Plugin-based tools | Tools assigned per agent at init | Built-in tool suite | Action-oriented tools | Decoupled Skills (SKILL.md SOPs) with runtime binding and pre-flight validation |
| **Communication** | Sequential message passing | Sequential/hierarchical task passing | Internal planning loop | Structured message protocol with shared memory | Artifact blackboard (Markdown files) + GitHub/ADO issue lineage |
| **Self-Evolution** | None — static configuration | None — roles fixed at init | Limited self-debugging | None — SOPs are static | Full lifecycle: T3→T2→T1 precipitation, quarantine, retirement, knowledge transfer |
| **Scheduling** | None | None | None | None | Meta-Cron engine with capability tiers, dry-run gates, action budgets |
| **Memory** | Short-term context only | Shared crew memory | Session context | Shared workbook | Three-level (L0-L3) with scoped injection, provenance, and token caps |
| **Multi-Engine** | Single LLM | Single LLM per agent type | Proprietary model | Single LLM | Engine-agnostic: Claude Code, GitHub Copilot CLI, any MCP-compatible CLI |
| **IDE Integration** | Standalone | Standalone / API | Proprietary IDE | Standalone | MCP-native: any editor (VS Code, Cursor, Claude Code, Windsurf) |
| **Safety** | Minimal (human approval loops) | None | Proprietary guardrails | None | Delegation depth limit, plan mode, input validation gateway, quarantine, secret scanning |

### Key Differentiators

**vs. AutoGPT** — AutoGPT runs a single agent in a thought-action-observation loop with no organizational structure. There is no concept of specialized roles, no separation between planning and execution, and no mechanism for the system to learn from past failures. Meta-Sparta-Swarm provides a full organizational hierarchy with independent agents, each with their own context window, memory, and constraints.

**vs. CrewAI** — CrewAI defines agent crews with fixed role assignments at initialization. The pipeline is either sequential or hierarchical, but always static. There is no mechanism for roles to be created dynamically, evolved based on performance, or retired when failing. Meta-Sparta-Swarm's T3→T2→T1 lifecycle means the team composition is fluid and self-improving.

**vs. Devin** — Devin is a single-agent system with an integrated development environment. While it can use tools (browser, terminal, editor), it operates as one agent with one context window. Meta-Sparta-Swarm distributes work across multiple agents with isolated contexts, so a PM's strategic reasoning does not compete for context space with a developer's implementation details.

**vs. MetaGPT** — MetaGPT uses SOP (Standard Operating Procedure) documents to structure agent communication, which is the closest analog to Meta-Sparta-Swarm's Skill system. However, MetaGPT's SOPs are static — they are defined by the framework authors and do not change. Meta-Sparta-Swarm's Skills are created, validated, and evolved by the system itself through the `skill-creator` meta-skill, and its roles self-evolve through the agent lifecycle.

---

## 11. Roadmap

### Implemented (v0.4.0)

- T3→T2→T1 agent lifecycle with auto-precipitation
- Role-Skill decoupling with many-to-many runtime binding
- Agent retirement, quarantine, and T1 garbage collection
- Meta-Cron V2 engine with register/list/remove MCP tools
- Project memory injection into agent prompts at spawn time
- Input validation gateway for role/engine/model confusion
- Delegation depth control (MAX_DELEGATION_DEPTH = 3)
- Plan mode for orchestrator roles
- `write_blackboard_artifact` with symlink-safe path validation
- Issue lineage tracking via `OPTIMUS_PARENT_ISSUE`
- Unified VCS abstraction (GitHub + Azure DevOps)
- Agent attribution signatures on all VCS operations

### In Progress

- **Meta-Memory L1 Implementation** — Three-level knowledge management with scoped injection, provenance metadata, and token-capped truncation. L0 raw log exists (`continuous-memory.md`); L1/L2/L3 injection pipeline is the next foundation step (Issue #143).

### Planned

- **Priority System** — Task prioritization in the Meta-Cron engine and delegation queue. Currently all tasks are equal; future versions will support urgency-based scheduling.
- **Async Feedback Channel** — Agent blocked-state handling with human-in-the-loop via GitHub. When an agent cannot continue (ambiguous requirement, missing resource, human decision needed), it writes a checkpoint, adds a `needs-human-input` label to its tracking Issue, posts the specific question as a comment, and exits. Meta-Cron patrol detects human responses and spawns continuation tasks. No real-time channel needed — fully async via GitHub notifications.
- **Root Master Self-Delegation** — The most radical evolution of the reflection protocol. The Root Master Agent delegates to a `master-orchestrator` role via the worker-spawner, making itself subject to the same prompt injection pipeline (Memory, Skills, Reflection Protocol) as every other agent. This eliminates the asymmetry where the most impactful decision-maker (who to delegate, what priority, which skills) is the only entity without enforced reflection.

### Future Research

- **Knowledge Promotion Quorum** — Automatic promotion of L2 role memory to L1 project memory when 3+ roles independently discover the same lesson.
- **Error Categorization** — Infrastructure failures (API 500, network timeout) vs. role-level failures (wrong approach, hallucination) tracked separately for more accurate quarantine decisions.
- **Multi-Engine Council Diversity** — Enforced engine distribution in `dispatch_council` to prevent single-engine failure cascades (based on recurring API 500 incidents).
- **Skill Integrity Checksums** — SHA-256 verification of meta-skills (`skill-creator`, `role-creator`) to detect corruption or tampering of the self-evolution bootstrap root.
- **Trust Tiers for T3 Agents** — Zero-shot T3 agents default to read-only (plan mode); only promoted T2/T1 agents run with full permissions.

---

*"Stop prompting. Start orchestrating."*
