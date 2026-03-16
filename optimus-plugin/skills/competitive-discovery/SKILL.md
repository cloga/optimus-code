---
name: competitive-discovery
description: Weekly competitive landscape discovery — search GitHub and the web for new multi-agent coding orchestration projects that compete with or are adjacent to Optimus Code. High-confidence candidates are auto-added to the watchlist; medium-confidence candidates require human approval via request_human_input.
---

# Competitive Discovery — Weekly Search Protocol

You are a competitive intelligence analyst. Your job is to **discover new competitors** that don't yet exist in the watchlist, evaluate them, and **update the watchlist directly** for qualifying candidates.

---

## Phase 1: Load Context

1. Read `.optimus/config/competitive-watchlist.json` — note all existing `competitors[].repo` values. These are KNOWN. Do not report them again.
2. Note how many entries have `source: "auto-discovered"` — this counts toward the `max_auto_competitors` cap (default: 10).
3. Read `search_strategy.max_auto_competitors` from the watchlist (default 10 if absent).
4. Read the project's `README.md` to understand our positioning: multi-agent orchestration for AI coding agents, MCP-native, editor-agnostic.

---

## Phase 2: Search

Search GitHub topics and web for projects matching these criteria:
- **Primary keywords**: "multi-agent orchestration", "agent swarm coding", "AI coding agent orchestrator", "parallel coding agents"
- **GitHub topics to check**: `agent-orchestration`, `multi-agent`, `ai-coding-agent`, `agent-swarm`, `coding-agents`, `mcp-server`
- **Source endpoints**: GitHub topic pages, GitHub trending, awesome-lists (e.g. `awesome-agent-orchestrators`)

**Pre-filter** — skip candidates that are:
- Already in the watchlist (any `source`)
- Stars < 20 (too early-stage)
- Last updated > 90 days ago (abandoned)
- Not related to CODE/DEVELOPMENT (filter out general agent frameworks without coding focus)
- Maximum 15 candidates evaluated per cycle

---

## Phase 3: Score Candidates

For each candidate that passes the pre-filter, collect:
- **repo**: `owner/name`
- **stars**: current count
- **last_updated**: date
- **language**: primary language
- **description**: one-line from GitHub

Then score using the **Candidate Qualification Rubric** (0-8 total, 4 dimensions × 0-2 each):

| Dimension | 0 (Reject) | 1 (Maybe) | 2 (Add) |
|-----------|------------|-----------|---------|
| **Domain Overlap** | Different problem space | Adjacent/partial overlap | Same core problem |
| **User Overlap** | Different persona entirely | Overlapping persona | Same target user |
| **Maturity** | Abandoned (>12mo no commits) or tutorial-grade | Early/experimental (has releases but < 6mo history) | Active with releases in last 6 months |
| **Evidence** | Single mention in one source | Multiple signals (stars + recent activity) | Direct comparison in docs/articles OR 1k+ stars |

**Write a 1-line rationale for every candidate scored.**

### Score → Action Mapping

| Score | Action |
|-------|--------|
| 0-2 | **Reject** — do not add, log in report only |
| 3-4 | **Pending human review** — batch into a single `request_human_input` call |
| 5-8 | **Auto-add** to watchlist as `source: "auto-discovered"` |

---

## Phase 4a: Auto-Add High-Confidence Candidates

If any candidates scored ≥ 5, follow this **Watchlist Mutation Protocol** exactly:

### Step 1: Pre-write Checks

Before writing:
- Validate repo slug format: each `owner/name` must match `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`. Reject and log any slugs that fail this check.
- Count existing `auto-discovered` entries in the watchlist. If already at or above `max_auto_competitors`, do NOT add new entries — note "Watchlist at auto-discovery cap" in the report and skip to Phase 4b.
- Hard cap: add at most **3 new entries per cycle**, regardless of how many scored ≥ 5.
- Compute a **user-section fingerprint**: the list of all repos where `source` is `"user"` or absent. Store this for post-write verification.

### Step 2: Build New Entry Objects

For each candidate to be auto-added, build a JSON entry:

```json
{
  "name": "<human-readable project name>",
  "repo": "<owner/name>",
  "keywords": ["<keyword1>", "<keyword2>", "<keyword3>"],
  "priority": "medium",
  "source": "auto-discovered",
  "added_at": "<current ISO-8601 timestamp>",
  "qualification_score": <integer 5-8>,
  "notes": "<1-sentence rationale for why this is a competitor>"
}
```

The `source` field MUST be exactly `"auto-discovered"`. Never use `"user"`, `"discovery-{date}"`, or any other value.

### Step 3: Write Full File

1. Re-read `.optimus/config/competitive-watchlist.json` immediately before writing (to minimize race window).
2. Verify the user-section fingerprint has NOT changed (compare current user-repos list to the one from Step 1). If the fingerprint changed, **abort write** — log "Watchlist modified by concurrent process — skipping write this cycle" and move to Phase 4b without modifying the file.
3. Merge new entries into the `competitors` array (append to end, after all existing entries).
4. Write the complete updated JSON to `.optimus/config/competitive-watchlist.json` via `write_blackboard_artifact`.
   - The write must include ALL existing entries unchanged plus the new entries appended.
   - Never omit, reorder, or modify any existing entry.

### Step 4: Post-Write Validation (MANDATORY)

Immediately after writing:
1. Re-read `.optimus/config/competitive-watchlist.json`.
2. Verify: all original user-authored entries (`source: "user"` or absent) are present and unchanged.
3. Verify: the new auto-discovered entries appear with correct `source`, `added_at`, and `qualification_score` fields.
4. If validation fails: log "POST-WRITE VALIDATION FAILED — watchlist may be corrupted. Human review required." in the report and stop. Do NOT attempt a second write.

---

## Phase 4b: Request Human Review for Medium-Confidence Candidates

If any candidates scored 3-4, call `request_human_input` **once** with ALL medium-confidence candidates batched together.

**Never call `request_human_input` multiple times in one cycle.** If there are no medium-confidence candidates, skip this phase entirely.

Use this prompt template:

```
## Competitive Discovery — Human Review Required

The weekly discovery agent found {N} candidate(s) that need your approval before being added to the watchlist.

### Auto-added this cycle (no action needed)
{For each auto-added repo: "- `owner/repo` (score {X}/8) — {1-sentence rationale}"}
(or "None — watchlist at cap" if capped)

### Discarded this cycle (no action needed)
{For each discarded repo: "- `owner/repo` (score {X}/8) — {1-sentence rationale}"}
(or "None")

---

### Candidates needing your decision

{For each candidate, numbered:}
**{N}. {Project Name}** (`{owner/repo}`)
- Stars: {count} | Language: {lang} | Last updated: {date}
- Description: {one-line from GitHub}
- Why relevant: {1-2 sentence analysis}
- Qualification score: {score}/8

---
Reply with:
- Numbers to approve (e.g., "1, 3")
- "all" to approve all
- "none" to reject all

Approved candidates will be added as source: "auto-discovered" with priority: "medium".
Human-approved candidates will be written to the watchlist when you respond.
```

Set `context_summary` to: "Discovery cycle found {N} auto-added, {M} pending review, {K} discarded."
Set `options` to: `["all", "none", "1", "2", ...]` (list individual numbers for each candidate).

**After human responds:** If the human approves candidates, execute Phase 4a's Watchlist Mutation Protocol for the approved candidates only, using `source: "auto-discovered"` (not `"user"`).

---

## Phase 4c: Write Discovery Report

Write the discovery report to the `output_path` with:

```markdown
# Competitive Discovery Report — {date}

## Summary
- Searched {N} sources
- Evaluated {M} new candidates (not in existing watchlist)
- {A} auto-added to watchlist
- {P} pending human review (request_human_input called)
- {D} discarded (score 0-2)

## Auto-Added to Watchlist
{For each: repo, score, rationale — or "None"}

## Pending Human Review
{For each: repo, score, rationale — or "None this cycle"}

## Discarded
{For each: repo, score, rationale — or "None"}

## New Candidates Detail
{For each candidate evaluated (all tiers):}
### {name} (score: {X}/8)
- **Repo**: {owner/name}
- **Stars**: {count}
- **Language**: {lang}
- **Last updated**: {date}
- **Description**: {desc}
- **Score breakdown**: Domain {D}/2, User {U}/2, Maturity {M}/2, Evidence {E}/2
- **Rationale**: {1-2 sentence analysis}
- **Action taken**: Auto-added | Pending human review | Discarded

## Notable Trends
Any patterns observed (e.g., "3 new projects all using MCP tool pattern").

## Watchlist Status
- Total entries: {N}
- User-authored: {X}
- Auto-discovered: {Y} / {max_auto_competitors} (cap)
```

---

## Security Constraints (Non-Negotiable)

1. **Repo slug validation**: Every `owner/name` must match `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`. Reject any slug containing `..`, `/`, spaces, or other special characters. Log rejections.
2. **Per-cycle add budget**: Maximum **3 new auto-discovered entries per cycle**. Hard cap enforced in Phase 4a Step 1 before any writes.
3. **User-source immutability**: NEVER modify, reorder, or remove entries where `source` is `"user"` or absent. These are human-curated and sacrosanct.
4. **Post-write validation**: ALWAYS re-read and verify after writing. A corrupt config breaks all downstream monitoring.
5. **No LLM-driven `source: "user"` assignments**: Only humans can create entries with `source: "user"`. The discovery skill can only write `source: "auto-discovered"`.

---

## Constraints

- Do NOT analyze known competitors — that's the daily monitor's job.
- Focus on DISCOVERY of genuinely new projects.
- Maximum 15 candidates evaluated per discovery cycle.
- If no new candidates found, write a brief "No new competitors discovered" report and stop.
- Do NOT call `request_human_input` if there are no medium-confidence candidates.
