● Read optimus-code\.optimus\PROPOSAL_github_blackboard.md
  └ 19 lines read

---

# Architectural Review: PROPOSAL_github_blackboard.md
**Reviewer Role:** System Architect (T3 — Zero-Shot Outsource)
**Date:** 2026-03-10

---

## Executive Summary

The proposal to migrate the Optimus Spartan Swarm Blackboard from a local file-based system to GitHub Issues/PRs is architecturally ambitious but introduces **critical systemic risks** that outweigh its benefits in the current form. A pure migration is not advisable. A carefully scoped hybrid is conditionally acceptable.

---

## Section-by-Section Critique

### 1. Performance & Latency — **BOTTLENECK (Severe)**

The core architectural concern is **coupling a tight, synchronous agent coordination loop to an external, rate-limited HTTP API**.

- The GitHub REST API has a **60 req/hour (unauthenticated) / 5,000 req/hour (authenticated)** ceiling. A moderately active swarm executing micro-tasks (polling for task status, posting comments, reading state) will exhaust this budget in minutes for any non-trivial session.
- GitHub GraphQL API helps but does not eliminate the rate-limit problem.
- **Round-trip latency** for `Issue.read → Comment.write → Issue.close` across a single micro-task is realistically 300–1,500ms per operation over network. A swarm orchestrating 50 sub-tasks could serialize to **75+ seconds of pure API wait time** — before any code is written.
- There is **no batch-write primitive** in GitHub Issues. Each status update is a discrete HTTP request. The local file blackboard (`write()`) is sub-millisecond.
- **Verdict:** GitHub Issues are designed for human-paced collaboration, not machine-paced micro-task loops. This is the most fundamental architectural mismatch in the proposal.

---

### 2. Authentication & Security — **HIGH RISK**

The proposal hand-waves over what is a significant attack surface expansion.

- Granting autonomous agents **`repo:write` + `pull_requests:write` scopes** via a PAT or GitHub App means a single prompt-injection attack, a jailbroken sub-agent, or a compromised secrets file could result in **arbitrary code being pushed to branches and PRs opened against the main repository**.
- There is no mention of:
  - **Branch protection rules** to prevent agents from pushing directly to `main`/`master`
  - **Required human reviewer** before merge (the proposal says "optionally" for CI/QA — this must be mandatory)
  - **Secret scanning** — agents generating code may inadvertently commit credentials; GitHub's native scanner is reactive, not preventive
  - **PAT rotation and minimal-scope token strategy** — the proposal does not define what scopes are actually needed, risking over-provisioned tokens
- The `dev` agent checking out branches and committing code locally before pushing means the agent also needs **local filesystem write access** — the proposal does not reduce the local trust surface, it adds a GitHub surface on top.
- **Supply chain risk:** If any agent framework dependency is compromised, adversarial commits to GitHub are now automated and may bypass human review if the "optional CI" path is taken.
- **Verdict:** Security requirements are underspecified. This cannot be accepted without a formal threat model, mandatory PR review gates, and minimal-scope token policies.

---

### 3. State Management & Synchronization — **RACE CONDITIONS (Critical)**

This is the most technically dangerous section of the proposal.

- **Multiple agents reading the same GitHub Issue queue simultaneously** with no distributed lock mechanism creates a classic TOCTOU (Time-of-Check/Time-of-Use) race. Two sub-agents could both read Issue #42 as "unassigned," both claim it via a comment, and both proceed to implement the same task.
- GitHub Issues have **no atomic claim/reserve primitive**. Simulating one via comments or labels requires a check-then-write pattern that is **inherently racy over HTTP**.
- Issue state transitions (`open → in_progress → closed`) driven by comment parsing are **fragile state machines** — a network timeout, a duplicate webhook delivery, or an out-of-order comment can corrupt state irreversibly.
- **Eventual consistency vs. required linearizability:** Agent coordination requires strong ordering guarantees. GitHub's API is eventually consistent (webhooks, search indexes). A task marked "closed" may not appear as closed to another agent polling the API for several seconds.
- The proposal does not address **idempotency** — if an agent retries a failed API call, does it create a duplicate issue, double-comment, or reopen a closed PR?
- **Verdict:** Replacing a linearizable local file/SQLite state machine with GitHub's eventually consistent, unordered comment streams is architecturally unsound for machine coordination without significant compensating infrastructure.

---

### 4. Developer Experience (DX) — **MIXED / Net Negative for Inner Loop**

- **Positive:** PR-based workflow brings code changes into the standard review pipeline, enables CI gating, and provides a permanent audit trail — a genuine improvement for macro-level deliverables (features, architectural changes).
- **Negative — Increased Friction:**
  - The user must now navigate GitHub UI to see what the swarm is doing, rather than watching `.optimus/` files update in VS Code.
  - Every swarm execution that produces code now requires a **manual merge action** (or auto-merge configuration), adding latency to the inner loop.
  - **Notification noise:** A busy swarm will generate dozens of GitHub Issues and PR notifications, polluting the user's GitHub notification stream.
  - **Debugging difficulty:** When an agent fails mid-task, diagnosing state requires cross-referencing GitHub Issue comments, PR review comments, Actions logs, and local filesystem state simultaneously.
- The proposal increases the **cognitive surface** that the user must monitor from 1 (local `.optimus/` directory) to 4 (local FS + Issues + PRs + Actions).
- **Verdict:** DX is improved for final deliverable review but degraded for day-to-day swarm operation and debugging.

---

## Identified Architectural Bottlenecks (Summary)

| Risk | Severity | Likelihood |
|---|---|---|
| GitHub API rate limit exhaustion during swarm execution | Critical | High |
| Race condition on Issue claim by concurrent agents | Critical | High |
| Over-permissioned agent tokens enabling unauthorized pushes | High | Medium |
| Eventual consistency causing stale task state | High | High |
| Prompt injection → adversarial automated commit | High | Medium |
| DX degradation from PR merge friction | Medium | Certain |
| Notification flood degrading user focus | Low | Certain |

---

## Recommendation: **HYBRID** (Conditional Accept)

**Reject** a pure GitHub-as-Blackboard architecture. The API constraints alone make it structurally unsuitable as a micro-task coordination bus.

**Accept a Hybrid architecture** with the following boundaries:

```
┌─────────────────────────────────────────────────────────┐
│  MACRO LAYER (GitHub)                                    │
│  • Epics → GitHub Issues (human-created or Master-Agent) │
│  • Feature branches → GitHub PRs (dev agent output)     │
│  • CI/QA gate → GitHub Actions (mandatory, not optional) │
│  • Audit trail, human approval required before merge     │
└─────────────────────────────────────────────────────────┘
            ▲ promotes to / triggers
┌─────────────────────────────────────────────────────────┐
│  MICRO LAYER (Local — current architecture retained)     │
│  • .optimus/tasks/ — SQLite or file-based task queue     │
│  • Agent-to-agent messaging via local file events        │
│  • State machine managed locally with atomic file ops    │
│  • No rate limits, no network latency, full control      │
└─────────────────────────────────────────────────────────┘
```

**Required conditions for the Hybrid to be acceptable:**

1. **Mandatory PR review gate** — no auto-merge; human approval always required for agent-authored PRs.
2. **Minimal-scope GitHub App token** — `contents:write` (branch-scoped), `pull_requests:write` only. No `admin` or `repo:delete` scopes. Rotate tokens per-session.
3. **Idempotency keys** on all GitHub API writes to handle retry-safe agent behavior.
4. **Distributed lock** (even a simple `.optimus/locks/` file-based mutex) before any agent transitions an Issue to "claimed" state.
5. **Rate limit budget allocation** — the Master Agent must track and reserve API quota, failing fast with backoff rather than silently dropping tasks.
6. **Single-writer principle** — only the Master Agent writes to GitHub. Sub-agents report locally; Master Agent publishes upstream. This eliminates concurrent-writer race conditions.

---

*Critique prepared by T3 System Architect under Spartan Swarm Protocol. Recommendation: HYBRID with conditions listed above.*


> [LOG] 
Total usage est:        1 Premium request
API time spent:         53s
Total session time:     1m 0s
Total code changes:     +0 -0
Breakdown by AI model:
 claude-sonnet-4.6       40.0k in, 2.3k out, 19.1k cached (Est. 1 Premium request)