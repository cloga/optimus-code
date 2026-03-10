● Read optimus-code\.optimus\PROPOSAL_github_blackboard.md
  └ 19 lines read

---

## PM Critique — T3 (Zero-Shot Outsource) | Role: `pm`
### Proposal: Migrate Agent Blackboard to GitHub Issues & Pull Requests

---

### Executive Summary

This proposal trades a fast, controllable, zero-dependency local system for a cloud-mediated coordination layer that introduces latency, rate-limit exposure, credential risk, and significant DX friction — **without a clearly justified need**. The value proposition is weak unless the primary goal is external visibility or team-scale collaboration.

---

### Critical Findings

#### 1. 🔴 Architectural Bottleneck — GitHub API as Inner Loop

The most fundamental flaw: **API round-trip latency (~100–500ms per call) multiplied across every micro-task coordination event will destroy development velocity.** A local file read is sub-millisecond. A GitHub Issue comment write + read cycle is not.

For a swarm of agents performing dozens of small coordination handoffs per epic, this creates a *latency cliff*. A task that completes in 2 seconds locally could take 30+ seconds over GitHub API, especially under rate limits.

**Risk level: HIGH. This is a showstopper for any real-time feedback loop.**

---

#### 2. 🔴 Security Risk — Overprivileged Autonomous Agents

Granting autonomous AI agents `repo:write` + PR-create permissions introduces a severe blast radius:

- A malfunctioning or prompt-injected agent can push branches, open PRs against any ref, commit secrets, or modify CI/CD workflow files (`.github/workflows/`)
- If the agent token is stored in `.optimus/` config and that path is ever committed, the token is leaked
- GitHub Actions workflows triggered by agent-created PRs could execute arbitrary code with elevated runner permissions
- No mention of branch protection rules, required reviews, or scoped fine-grained PATs

**Recommendation: At minimum, require fine-grained PATs scoped to a single repo, `contents:write` + `pull_requests:write` only, stored in the OS credential store, never in files.**

---

#### 3. 🟡 State Management — Race Conditions & Rate Limits

The proposal silently inherits GitHub's rate limit model:
- REST API: 5,000 req/hr per token (unauthenticated: 60)
- A busy swarm of 4 agents polling for task updates can exhaust this within an hour of active work

Additionally, **there is no locking mechanism on GitHub Issues.** Two agents reading the same issue comment thread and both deciding to act on the same task creates a classic TOCTOU race condition. The current file-based blackboard, while primitive, can use filesystem locks.

**No mention of optimistic locking, etags, conditional requests, or webhook vs polling strategy.**

---

#### 4. 🟡 DX Friction — Merge Gate Interrupts Flow

The proposal introduces a mandatory human interaction point (PR merge) in what is currently a fully autonomous local loop. This is positioned as a feature, but from a DX standpoint:

- Users must context-switch to GitHub UI to approve code that was previously visible directly in their editor
- "Merge" is binary — no partial acceptance of agent-generated code without editing the PR or requesting changes
- VS Code integration (GitLens, GitHub PR extension) helps but adds tooling dependency

**This is acceptable for *macro* epics but catastrophic for micro-tasks like variable renames or test fixture generation.**

---

#### 5. 🟢 Genuine Value — Audit Trail & Team Visibility

The proposal does have legitimate merit:

- GitHub Issues provide a persistent, searchable, shareable audit trail of agent decisions
- PRs give human engineers a review gate with inline diff commentary
- CI/CD integration enables automated test gates before merge
- Works across machines and collaborators (unlike local `.optimus/` files)

These benefits are **real but applicable only at the epic/feature boundary**, not for every agent micro-coordination event.

---

### Verdict

| Dimension | Score | Notes |
|---|---|---|
| Performance | ❌ | API latency kills inner loop |
| Security | ⚠️ | Requires strict PAT scoping & secret hygiene |
| State Consistency | ⚠️ | No locking; rate limit risk |
| DX | ⚠️ | Merge gate adds friction for small changes |
| Audit/Visibility | ✅ | Clear win for long-lived epics |

---

## ✅ Recommendation: **HYBRID**

**Local Blackboard for micro-task coordination. GitHub for macro-epic boundaries.**

Concretely:

| Layer | Storage | Rationale |
|---|---|---|
| Agent-to-agent coordination (task queue, status flags) | Local SQLite / `.optimus/` files | Speed, zero rate limits, lockable |
| Code changes | Git branch (local) → GitHub PR | Review gate with CI, only at epic completion |
| Epic definitions & user requirements | GitHub Issues | Visibility, searchability, human-readable audit |
| QA feedback on final output | PR inline comments via GitHub API | Appropriate at merge boundary |

**Reject** the proposal as written (pure GitHub migration).  
**Accept** a hybrid where GitHub Issues track epics and PRs gate final delivery, but all intra-swarm micro-coordination remains local. This preserves speed, limits credential exposure, and gives the user a clean review interface without interrupting every sub-task.

---

*— T3 (`pm`), Spartan Swarm Protocol*


> [LOG] 
Total usage est:        1 Premium request
API time spent:         37s
Total session time:     44s
Total code changes:     +0 -0
Breakdown by AI model:
 claude-sonnet-4.6       40.0k in, 1.5k out, 19.1k cached (Est. 1 Premium request)