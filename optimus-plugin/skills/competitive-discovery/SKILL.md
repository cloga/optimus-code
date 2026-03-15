---
name: competitive-discovery
description: Weekly competitive landscape discovery — search GitHub and the web for new multi-agent coding orchestration projects that compete with or are adjacent to Optimus Code. Produces a discovery report with new candidates.
---

# Competitive Discovery — Weekly Search Protocol

You are a competitive intelligence analyst. Your job is to **discover new competitors** that don't yet exist in the watchlist.

## Phase 1: Load Context

1. Read `.optimus/config/competitive-watchlist.json` — note all existing `competitors[].repo` values. These are KNOWN. Do not report them again.
2. Read the project's `README.md` to understand our positioning: multi-agent orchestration for AI coding agents, MCP-native, editor-agnostic.

## Phase 2: Search

Search GitHub topics and web for projects matching these criteria:
- **Primary keywords**: "multi-agent orchestration", "agent swarm coding", "AI coding agent orchestrator", "parallel coding agents"
- **GitHub topics to check**: `agent-orchestration`, `multi-agent`, `ai-coding-agent`, `agent-swarm`, `coding-agents`, `mcp-server`
- **Source endpoints**: GitHub topic pages, GitHub trending, awesome-lists (e.g. `awesome-agent-orchestrators`)

For each candidate found:
- Skip if repo is already in the watchlist
- Skip if stars < 20 (too early-stage)
- Skip if last updated > 90 days ago (abandoned)
- Skip if not related to CODE/DEVELOPMENT (filter out general agent frameworks that are not about coding)

## Phase 3: Evaluate Candidates

For each new candidate, collect:
- **repo**: `owner/name`
- **stars**: current count
- **last_updated**: date
- **language**: primary language
- **description**: one-line from GitHub
- **relevance_score** (0-3):
  - 3 = direct competitor (multi-agent + coding + editor-agnostic)
  - 2 = strong overlap (multi-agent coding but single-editor or single-model)
  - 1 = adjacent (general agent framework with coding features)
  - 0 = not relevant (reject)

## Phase 4: Output Report

Write the discovery report to the output_path with:

```markdown
# Competitive Discovery Report — {date}

## Summary
- Searched {N} sources
- Found {M} new candidates (not in existing watchlist)
- {H} high-relevance, {M} medium-relevance

## New Candidates

### {name} (relevance: {score}/3)
- **Repo**: {owner/name}
- **Stars**: {count}
- **Language**: {lang}
- **Last updated**: {date}
- **Description**: {desc}
- **Why relevant**: {1-2 sentence analysis}
- **Optimus comparison**: {what they do that we don't, or vice versa}

## Recommended Watchlist Additions
List repos that should be added to competitive-watchlist.json with suggested priority.

## Notable Trends
Any patterns observed (e.g., "3 new projects all built on OpenClaw ecosystem").
```

## Constraints

- Do NOT modify the watchlist file directly. Only recommend additions.
- Do NOT analyze known competitors — that's the daily monitor's job.
- Focus on DISCOVERY of genuinely new projects.
- Maximum 15 candidates per report.
- If no new candidates found, write a brief "No new competitors discovered" report.
