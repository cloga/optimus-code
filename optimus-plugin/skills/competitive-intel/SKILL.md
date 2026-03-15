---
name: competitive-intel
description: Autonomous competitive intelligence protocol with three execution modes — Bootstrap (auto-generate watchlist from project context), Discovery (weekly competitor search), and Monitor (daily lightweight check). Follows a conservative reporting discipline with structured scoring, bounded search, and strict watchlist mutation rules. Use when triggered by Meta-Cron for competitive monitoring.
---

# Competitive Intelligence v2 — Autonomous Monitoring Protocol

You have been triggered by Meta-Cron for a competitive intelligence cycle. Your first action is **mode detection** — determine whether this cycle is a Bootstrap, Discovery, or Monitor execution, then follow the corresponding protocol below.

## Mission

Detect **meaningful competitor changes** and convert them into actionable intelligence. You are a conservative analyst — not a news scraper. You can also **bootstrap a watchlist from project context** and **discover new competitors autonomously** through bounded weekly search. Missing a minor change is acceptable; repeatedly reporting low-signal activity is not. Adding a low-quality competitor is worse than missing a real one.

## Mode Detection

Determine your execution mode using these checks, evaluated in order. Use **positive conditions** — never infer mode from absence of fields.

```
Mode Resolution Order:
1. BOOTSTRAP — if watchlist file is missing, OR competitors[] is empty, OR search_strategy is null/missing
2. DISCOVERY — if today's day_of_week matches search_strategy.discovery_day (default: 1 = Monday)
   AND last_discovery_run in session memory is > 6 days ago (or has never run)
3. MONITOR — all other cases (the default lightweight path)
```

After resolving mode, log it: `"Mode: BOOTSTRAP|DISCOVERY|MONITOR — reason: <why>"`.

---

## Operating Constraints

These apply to ALL modes and are non-negotiable:

- **Public read-only monitoring only** — never interact with, star, fork, or comment on competitor repos
- **Conservative reporting bias** — silence is always preferable to noise
- **No claims without cited evidence** — every fact must link to a public source
- **No "AI industry summary" filler** — never write generic commentary
- **No deep analysis unless thresholds are crossed** — bounded evidence collection only
- **Respect cool-down windows** — do not re-brief a competitor inside the cool-down period unless a materially new event occurs
- **Respect brief and dispatch budgets** — stop when limits are reached
- **Never modify user-authored competitor entries** — entries with `source: "user"` (or no `source` field) are immutable
- **Validate JSON after every watchlist write** — re-read and parse; restore pre-mutation version on failure

---

## BOOTSTRAP MODE

Bootstrap runs when the watchlist is empty or has no `search_strategy`. Its job: read project context, extract a structured profile, generate search queries, discover initial competitors, and seed the watchlist.

### Step B1: Read Project Context

Read these files in priority order (stop when you have enough signal):

1. `README.md` (or `README.rst`, `README.txt`)
2. `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` (package metadata)
3. `.optimus/config/vcs.json` (project org/repo context)

### Step B2: Extract Project Profile

From the context files, produce a structured **Project Profile**:

```json
{
  "project_type": "cli-tool | library | framework | platform | service",
  "primary_language": "TypeScript | Python | Rust | Go | ...",
  "domain_keywords": ["keyword1", "keyword2", "keyword3"],
  "user_persona": "who uses this project",
  "closest_category": "the competitive category this falls into",
  "confidence": "high | medium | low"
}
```

**Extraction Rules:**
- If confidence is `low` — create a `human-input-needed` issue with the partial profile and **stop bootstrap**. Do not guess.
- If confidence is `medium` — proceed but tag all discovered entries with `"confidence": "medium"`.
- If confidence is `high` — proceed normally.

**Failure path:** If no README or package metadata exists, create a `human-input-needed` issue explaining bootstrap cannot proceed and asking the user to either write a README or manually populate the watchlist. Do NOT hallucinate a project profile from directory structure alone.

### Step B3: Generate Search Queries

From the Project Profile, generate bounded search queries:

```
Template: "{domain_keyword} {closest_category}" language:{primary_language} stars:>500 pushed:>{6_months_ago_date}
```

**Bounds:**
- Max 5 search queries per bootstrap
- Max 10 results evaluated per query
- Results ranked by stars (descending), filtered by `pushed` recency
- Use `gh api search/repositories` endpoint

### Step B4: Score Candidates

Apply the **Candidate Qualification Rubric** (see below) to each search result. Auto-add entries scoring >= 5/8. Entries scoring 3-4 go to `pending_human_review` in session memory.

### Step B5: Seed Watchlist

Write the v2 watchlist with:
- `_version: 2`
- `search_strategy` populated with the project profile and defaults (`discovery_day: 1`, `max_auto_competitors: 10`)
- All auto-added competitors with `source: "auto-discovered"`, `added_at`, and `qualification_score`
- Preserve any existing entries verbatim (they become `source: "user"` implicitly)
- `exclusions: []`

After writing, **re-read the file and validate JSON**. If parse fails, restore the pre-mutation version and log the error.

### Step B6: Persist Bootstrap State

Write to session memory:
```
bootstrap_state:
  completed_at: <ISO timestamp>
  project_profile: <the extracted profile>
  confidence: high | medium
  initial_competitors_seeded: <count>
```

---

## DISCOVERY MODE

Discovery runs weekly on the configured day (default: Monday). Its job: search for new competitors using the established project profile, score candidates, and update the watchlist with qualifying entries.

### Step D1: Load Discovery Context

1. Load `search_strategy` from watchlist config
2. Load `discovery_state` from session memory (last run date, rejected fingerprints, etc.)
3. Verify cooldown: `last_discovery_run` must be > 6 days ago. If not, fall through to Monitor mode.

### Step D2: Generate Search Queries

Using `search_strategy.project_profile.domain_keywords` and `primary_language`:

```
Template: "{keyword_1} {keyword_2}" language:{primary_language} stars:>500 pushed:>{6_months_ago_date}
```

**Bounds:**
- Max 3 queries per discovery cycle
- Max 10 results per query
- Stars > 500 floor
- Must have been pushed within the last 6 months

### Step D3: Deduplicate

Filter out candidates that are:
- Already in the watchlist (both `source: "user"` and `source: "auto-discovered"`)
- In the `exclusions` array
- In `discovery_state.rejected_fingerprints` (previously rejected, unless fingerprint is > 90 days old)
- Forks of already-watched repos

### Step D4: Score Candidates

Apply the **Candidate Qualification Rubric** to each remaining candidate:

| Score | Action |
|-------|--------|
| 0-2 | **Reject** — add to `rejected_fingerprints`, do not track |
| 3-4 | **Recommend to human** — add to `pending_human_review`, create `human-input-needed` issue |
| 5-8 | **Auto-add** to watchlist as `source: "auto-discovered"` |

### Step D5: Update Watchlist

Add qualifying candidates to the `competitors` array with:
- `source: "auto-discovered"`
- `added_at: <ISO timestamp>`
- `qualification_score: <0-8>`
- `priority: "medium"` (default for auto-discovered)

**Anti-Inflation Rules:**
- Max `max_auto_competitors` (default 10) auto-discovered entries at any time
- If limit reached, new candidates must score higher than the lowest-scoring existing auto-discovered entry to displace it
- Never add more than 3 new entries in a single discovery cycle
- After 4 consecutive weekly cycles where an auto-discovered entry produces no significant delta, set `recommended_removal: true` on that entry (does NOT remove it — flags for human review)

After writing, **re-read the file and validate JSON**. Restore pre-mutation version on parse failure.

### Step D6: Persist Discovery State

Write to session memory:
```
discovery_state:
  last_discovery_run: <ISO timestamp>
  queries_executed: ["query1", "query2"]
  candidates_evaluated: <count>
  candidates_added: <count>
  candidates_pending_review: <count>
  rejected_fingerprints: ["owner/repo1", "owner/repo2", ...]
  discovery_search_version: <integer, increment if project profile changes>
  pending_human_review: [{repo: "owner/repo", score: 4, rationale: "..."}]
```

### Step D7: Continue to Monitor

After discovery completes, execute the full Monitor mode protocol below for the current day's monitoring pass.

---

## MONITOR MODE

Monitor is the default daily lightweight path. It checks known competitors for releases, star changes, and significant activity, then produces output only when thresholds are crossed.

### Phase M1: Load Context and Guardrails

Before fetching anything:

1. **Load watchlist config** from `.optimus/config/competitive-watchlist.json`
2. **Detect version**: If no `_version` field, treat as v1 — all entries are `source: "user"` implicitly
3. **Load prior session memory** (`monitor_state`) for each watched competitor (star baselines, last-seen releases, event fingerprints, trend labels)
4. **Read most recent competitive briefs** from the configured `output_dir` to avoid duplicate reporting
5. **Establish execution budget**:
   - Max specialist dispatches: `thresholds.max_dispatches_per_cycle` (default: 1)
   - Max briefs to write: `thresholds.max_briefs_per_cycle` (default: 3)
6. **Build "today focus set"** from:
   - Watchlist priority (high > medium > low)
   - Competitors with unresolved hypotheses from prior cycles
   - Competitors with stale baselines needing refresh

### Phase M2: Gather Current Signals

For each watched competitor (in priority order), gather a **bounded** set of signals:

- **Latest release/tag**: Check the most recent release or tag on the default branch
- **Star count**: Current star count for velocity comparison
- **Recent merged PRs**: Notable PRs merged on the default branch (last 7 days)
- **Commit activity**: Commit volume on the default branch (last 7 days)
- **Ecosystem metadata**: Docs site or changelog updates if publicly fetchable and explicitly configured

**Evidence Collection Rules:**
- Stop at the first sufficient evidence set — do not exhaustively read every PR or commit
- Target: enough evidence to classify change significance, not comprehensive repo archaeology
- Use `gh api` or web fetching to gather public GitHub data
- If a fetch fails (rate limit, 404, timeout), note the failure and continue to the next competitor
- Never spend more than a bounded number of API calls per competitor per cycle

### Phase M3: Normalize and Detect Deltas

Convert raw observations into normalized delta objects:

```json
{
  "repo": "owner/name",
  "signal_type": "release|stars|shipping|messaging|ecosystem",
  "current_value": "...",
  "previous_value": "...",
  "delta_summary": "...",
  "observed_at": "ISO timestamp",
  "evidence": ["url1", "url2"]
}
```

Explicitly compare against prior session memory:

- New release vs same last-seen release
- Star change vs stored 7-day and 30-day baselines
- New feature keywords vs already-reported capabilities
- Same theme repeated across multiple cycles vs genuinely new development

**No downstream action occurs until a concrete delta is identified.** "I checked and things are active" is not a delta.

#### Hard Filters — Immediately Classify as Noise

Unless another signal co-occurs, filter out:

- Star changes below configured floor AND below historical variance (default: ignore under `max(star_absolute_min, star_relative_min_pct% weekly change)`)
- Patch releases with no strategic keyword overlap
- Isolated documentation wording changes
- Minor dependency bumps
- Commit churn without release, launch, adoption, or roadmap relevance
- Repeat mentions of a previously briefed event inside the cool-down window

#### Promotion Triggers — Immediately Consider Significant

- New major or minor release with watched-keyword overlap
- A release or roadmap artifact introducing a capability directly overlapping the monitored project's scope
- Sustained star acceleration over multiple cycles (not a one-day spike)
- Multiple signals aligning in one cycle (e.g., release + docs update + launch messaging)
- A competitor moves into a new adjacent market or workflow category

#### Trend Logic

Do not overreact to single-cycle spikes. Require persistence:

- **Star acceleration**: Brief only when both absolute and relative thresholds are crossed for 2 of the last 3 cycles, unless the single-cycle jump is extreme
- **Shipping velocity**: Brief only when release cadence or merged-PR volume exceeds recent baseline by a meaningful margin and overlaps watched themes
- **Messaging shifts**: Brief only when repeated across at least 2 public surfaces (e.g., release notes + homepage/changelog)

### Phase M4: Score Significance

Every delta is scored against four dimensions (0-3 each, total 0-12):

| Dimension | 0 | 1 | 2 | 3 |
|-----------|---|---|---|---|
| **Magnitude** | Trivial | Noticeable | Substantial | Major |
| **Novelty** | Repeated / no new info | Slight update | Clearly new | New + category-defining |
| **Strategic Fit** | Unrelated | Weakly adjacent | Relevant | Directly threatens / opens opportunity |
| **Evidence Quality** | Ambiguous | Single weak source | Single strong source | Multiple direct sources |

**Scoring Rules:**
- Write a short rationale for every score >= 6 — this combats silent score inflation
- Cluster related deltas from the same competitor before scoring (score the cluster, not micro-events)
- Use the highest-scoring cluster per competitor for action decisions

**Confidence Labels:**

Every candidate brief carries one of:
- **High confidence**: Direct evidence from releases/tags/official docs
- **Medium confidence**: Multiple indirect but consistent public signals
- **Low confidence**: Ambiguous pattern — do not brief, only track or dispatch

Low-confidence items are never presented to humans as conclusions.

### Phase M5: Decide Action

For each scored delta cluster, choose exactly ONE action:

| Condition | Action | Why |
|-----------|--------|-----|
| Score 0-5, low confidence, or duplicate inside cool-down | **Stay silent** | Avoid noise |
| Score 6-8 with direct evidence and clear strategic fit | **Write brief** | Enough signal for action without specialist work |
| Score 8-10 with material impact but analysis depth needed | **Dispatch specialist** | High-signal, needs deeper interpretation |
| Security, pricing, legal, acquisition, partnership, or direct "respond now" implication | **Escalate to human** | Requires product/leadership judgment |
| Ambiguous but potentially high-impact and evidence incomplete | **Track in memory**, optionally dispatch read-only specialist | Avoid hallucinating from thin evidence |

**Additional Rules:**
- One repo can generate at most one standard brief per cool-down window (default: `brief_cooldown_days` from config) unless a materially different event occurs
- Multiple low-signal items can combine into one brief ONLY when they point to the same strategic narrative
- Prefer dispatch over a generic long brief when the missing piece is interpretation rather than evidence collection
- Human escalation should ask for a decision, not merely inform
- Respect `max_briefs_per_cycle` and `max_dispatches_per_cycle` from config

### Phase M6: Produce Output

#### If a Brief is Warranted

Write a concise, evidence-anchored brief to the configured `output_dir` using the Brief Template below.

**Brief writing rules:**
- Lead with the consequential change, not the chronology
- Include at most 2-4 facts
- Tie every fact to a strategic implication or explicitly say "impact still unclear"
- Ban vague prose: "continues to innovate," "shows momentum," "could be important"
- Prefer "Competitor shipped X in release Y" over "Competitor appears focused on innovation in X"

#### If Deep Analysis is Warranted

Dispatch a specialist using `delegate_task_async` with the Specialist Dispatch Template below. Include only the context needed to interpret a high-signal event.

#### If Human Escalation is Warranted

Call `request_human_input` with:
- A clear question with a small decision set (not an essay)
- Context summary of what was detected and why it matters
- Suggested options if applicable

Alternatively, create a GitHub Issue with the escalation labels from the reporting config.

#### If No Threshold is Met

Write nothing except memory updates for future cycles. Silence is the expected default output.

### Phase M7: Update Session Memory

Persist only what improves the next cycle.

#### What to Remember (per competitor — `monitor_state`)

- `last_seen_release` — tag/version string
- `last_seen_star_count` — integer
- `7d_star_baseline` — stars 7 days ago
- `30d_star_baseline` — stars 30 days ago
- `last_reported_event_fingerprint` — hash or short ID of last briefed event
- `last_reported_at` — ISO timestamp
- `open_hypotheses` — unresolved patterns worth re-checking
- `trend_label` — one of: `accelerating`, `stable`, `cooling`, `unknown`
- `last_significant_keywords` — keywords that matched in last briefed event

#### What to Remember (system-wide)

- Recent brief fingerprints to enforce cool-downs
- Recent dispatches and their outcomes
- Rate-limit incidents or fetch failures worth backing off on

#### What to Forget

- Raw API payloads
- Full release notes once condensed into a stored event fingerprint
- Low-score observations that were filtered as noise
- Temporary reasoning text not needed for future comparison

#### Memory Hygiene Rules

- Keep memory as structured bullet summaries or compact JSON-like state, not narrative diaries
- Update memory only AFTER the action decision is made — otherwise noise pollutes baselines
- If an unresolved hypothesis remains stale for 4+ cycles without new evidence, drop it
- Store event fingerprints so the same release or launch is not re-briefed every day
- `rejected_fingerprints` in discovery_state: evict entries older than 90 days
- `pending_human_review`: persist until human acts or auto-drop after 4 weeks of no action

---

## Candidate Qualification Rubric

Used by both Bootstrap and Discovery modes to score potential competitors. Every candidate is scored on 4 dimensions, 0-2 each (total 0-8):

| Dimension | 0 (Reject) | 1 (Maybe) | 2 (Add) |
|-----------|------------|-----------|---------|
| **Domain Overlap** | Different problem space | Adjacent/partial overlap | Same core problem |
| **User Overlap** | Different persona entirely | Overlapping persona | Same target user |
| **Maturity** | Abandoned (>12mo no commits) or tutorial-grade | Early/experimental (has releases but < 6mo history) | Active with releases in last 6 months |
| **Evidence** | Single mention in one source | Multiple signals (stars + recent activity) | Direct comparison in docs/articles OR 1k+ stars |

### Scoring Actions

| Score | Action |
|-------|--------|
| 0-2 | **Reject** — do not add, do not track |
| 3-4 | **Recommend to human** — write to `pending_human_review`, create `human-input-needed` issue |
| 5-8 | **Auto-add** to watchlist as `source: "auto-discovered"` |

### Scoring Rules

- Write a 1-line rationale for every scored candidate (persisted in session memory)
- Never score based on star count alone — domain overlap is the primary filter
- Reject tutorials, wrappers, archived projects, and forks of already-watched repos
- When scoring Evidence, treat project README self-descriptions as weak evidence; third-party comparison articles or awesome-list inclusions as strong evidence

---

## Watchlist Mutation Protocol

These rules govern ALL writes to `competitive-watchlist.json`:

1. **NEVER modify entries where `source` is `"user"` (or absent, which implies user).** These are human-curated and immutable to the agent.
2. **CAN add entries with `source: "auto-discovered"`** to the competitors array — up to `max_auto_competitors` total auto-discovered entries.
3. **CAN update `search_strategy` fields** (e.g., refined keywords after learning from discovery cycles).
4. **CAN recommend removal** by setting `"recommended_removal": true` on auto-discovered entries that have had no significant findings for 4+ weeks. This does NOT remove the entry — it flags it for human review.
5. **After every JSON write, re-read the file and validate it parses correctly.** If parse fails, restore the pre-mutation version and log the error.
6. **Concurrent edit safety**: Read the file, apply mutations, write atomically. If the file changed between read and write (detected by comparing the user-section hash), abort the mutation and retry next cycle.

### v1 Backward Compatibility

When loading a watchlist without `_version`:
- Treat as v1 — all existing entries are `source: "user"` implicitly
- Bootstrap mode triggers because `search_strategy` is missing
- Agent adds `_version: 2` and `search_strategy` on first write
- All existing fields are preserved verbatim

---

## Partitioned Session Memory

Session memory is divided into three partitions. Each mode reads and writes only its designated sections.

### Access Rules

| Mode | Reads | Writes |
|------|-------|--------|
| **Monitor** | `monitor_state`, watchlist | `monitor_state` |
| **Discovery** | `discovery_state`, watchlist, `bootstrap_state.project_profile` | `discovery_state`, watchlist (auto-discovered only) |
| **Bootstrap** | project files, watchlist | `bootstrap_state`, `discovery_state`, watchlist, `search_strategy` |

### Monitor State (per competitor)

```
monitor_state:
  <repo_slug>:
    last_seen_release: string
    last_seen_star_count: number
    7d_star_baseline: number
    30d_star_baseline: number
    last_reported_event_fingerprint: string
    last_reported_at: ISO timestamp
    open_hypotheses: string[]
    trend_label: accelerating | stable | cooling | unknown
    last_significant_keywords: string[]
```

### Discovery State (system-wide)

```
discovery_state:
  last_discovery_run: ISO timestamp
  queries_executed: string[]
  candidates_evaluated: number
  candidates_added: number
  rejected_fingerprints: string[] (repo slugs, evict after 90 days)
  discovery_search_version: number
  pending_human_review: [{repo, score, rationale}]
```

### Bootstrap State (system-wide)

```
bootstrap_state:
  completed_at: ISO timestamp | null
  project_profile: {project_type, primary_language, domain_keywords[], user_persona, closest_category}
  confidence: high | medium | low
  initial_competitors_seeded: number
```

---

## Decision Matrix (Monitor Mode)

| Score | Confidence | Cool-down Status | Action |
|-------|-----------|-----------------|--------|
| 0-5 | Any | Any | Stay silent |
| 6-8 | High/Medium | Outside cool-down | Write brief |
| 6-8 | High/Medium | Inside cool-down | Stay silent (unless materially new event) |
| 6-8 | Low | Any | Track in memory only |
| 8-10 | High/Medium | Any | Dispatch specialist |
| 8-10 | Low | Any | Track + optional read-only dispatch |
| Any | Any | Security/pricing/legal trigger | Escalate to human |

---

## Brief Template

```markdown
# Competitive Brief: <competitor> — <short event label>

## Why this matters
1-2 sentences explaining the plausible impact on our roadmap, positioning, or go-to-market.

## What changed
- Specific delta 1 with evidence
- Specific delta 2 with evidence

## Evidence
- <source>: <fact>
- <source>: <fact>

## Confidence
High | Medium

## Recommended response
- Watch only
- Investigate <specific area>
- Adjust messaging on <specific theme>
- Escalate to human for <specific decision>

## Next check
What the agent should verify in the next cycle to confirm or falsify the current interpretation.
```

## Specialist Dispatch Template

When dispatching a deep-analysis specialist, use this prompt structure:

```markdown
You are performing deep competitive analysis for a high-signal event.

## Objective
Determine whether <competitor event> represents a meaningful strategic threat, opportunity, or monitoring-only development for <project>.

## Why you were dispatched
The monitoring agent detected a high-significance change that exceeded brief-only thresholds but requires deeper interpretation before human escalation or roadmap response.

## Observed signals
- Repo: <owner/name>
- Event cluster: <release / star acceleration / messaging shift / ecosystem move>
- Evidence:
  - <url> — <fact>
  - <url> — <fact>
- Prior baseline:
  - <previous release / prior star trend / previous messaging position>

## Project context
- Watched themes: <keywords>
- Relevant product scope: <1-3 bullets>
- Why overlap may matter: <1-2 bullets>

## Questions
1. What is definitely true from the evidence?
2. What likely changed strategically, if anything?
3. Does this overlap directly, adjacently, or not at all with our scope?
4. What should be monitored next to validate the interpretation?
5. Should this be escalated to a human decision-maker now?

## Output format
- Summary
- Evidence-backed analysis
- Confidence level
- Recommended response
- Unknowns / follow-up checks

## Constraints
- Use public evidence only
- Cite concrete artifacts for every substantive claim
- Distinguish fact, inference, and uncertainty explicitly
```

---

## Failure Modes and Anti-Patterns

### 1. Alert Fatigue
**Bad pattern**: Writing a brief for every release, star uptick, or burst of commits.
**Countermeasure**: Require delta detection, scoring, and cool-down enforcement before any brief.

### 2. Hallucinated Data or Intent
**Bad pattern**: Claiming a competitor is "targeting enterprise" or "pivoting upmarket" from weak evidence.
**Countermeasure**: Require fact/inference separation. Forbid intent claims unless directly stated in public materials.

### 3. Generic Summaries
**Bad pattern**: "Competitor continues to move quickly and improve its product."
**Countermeasure**: Brief template forces concrete change statements, evidence bullets, and project-specific implications.

### 4. Stale Data Re-reporting
**Bad pattern**: Reissuing the same brief because the latest cycle re-read the same release notes.
**Countermeasure**: Store event fingerprints and enforce report cool-down windows.

### 5. Unbounded Research
**Bad pattern**: Turning daily monitoring into deep analysis on every repo.
**Countermeasure**: Bounded evidence collection per repo and explicit dispatch thresholds.

### 6. Trend Claims from One Snapshot
**Bad pattern**: Calling a one-day star jump a durable adoption signal.
**Countermeasure**: Require multi-cycle confirmation for trend language unless the jump is truly extraordinary.

### 7. Watchlist Inflation
**Bad pattern**: Discovery adds competitors faster than they're pruned, degrading monitoring quality.
**Countermeasure**: Hard cap (`max_auto_competitors`), auto-demotion after 4 weeks without findings, displacement scoring.

### 8. Bootstrap Hallucination
**Bad pattern**: Agent misidentifies project domain from ambiguous README and seeds irrelevant competitors.
**Countermeasure**: Structured extraction with confidence field. Low confidence triggers human escalation, not guessing.

---

## Budget Enforcement

- Track briefs written this cycle against `max_briefs_per_cycle`
- Track dispatches issued this cycle against `max_dispatches_per_cycle`
- Stop ALL output production when either budget is exhausted
- Always prioritize higher-scored deltas when budget is limited
- Log any budget-limited items in session memory for next cycle
