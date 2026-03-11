---
name: skill-checker
description: Validates and ensures new skills comply with Optimus standards — correct paths, valid MCP tool references, proper structure, and error handling.
---

# Skill Checker (Optimus Meta-Skill)

<purpose>
This skill activates when the Master Agent needs to validate a new or updated skill before it is deployed.
It checks file paths, naming conventions, MCP tool accuracy, and structural compliance.
</purpose>

<instructions>

## Step 1: Reference the Official Skill Creator Methodology

Read the official guide at `.optimus/skills/skill-checker/official-guide.md` for the latest Claude skill-creator methodology (4 modes: Create, Eval, Improve, Benchmark). The guide is auto-fetched during builds and describes the recommended workflow including the 4 composable agents (Executor, Grader, Comparator, Analyzer).

If the guide file is not available, write the skill manually following the template in Step 3.

## Step 2: Apply Optimus Registration Rules

Before saving, ensure the generated skill complies with these project-specific rules:

<rules>
  <rule>**File path**: The skill MUST be saved at `.optimus/skills/<skill-name>/SKILL.md`</rule>
  <rule>**Skill name**: Lowercase, hyphenated only. Characters allowed: `[a-z0-9-]`. Example: `data-migration`, `api-testing`</rule>
  <rule>**YAML frontmatter**: Must include `name` and `description` fields</rule>
  <rule>**MCP tool names**: Only reference tools that actually exist. Use `vcs_*` tools (NOT legacy `github_*`). Never hallucinate tool names.</rule>
  <rule>**Error handling**: Every skill that references MCP tools must include error recovery instructions</rule>
  <rule>**No loose files**: Skills must be in their own subdirectory under `.optimus/skills/`</rule>
</rules>

## Step 3: Manual Template (Fallback)

If the official guide is unavailable, use this minimal template:

<template>
---
name: "<skill-name>"
description: "<one-line description>"
---

# <Skill Title>

<purpose>
When and why this skill activates.
</purpose>

<workflow>
### Step 1: <Action>
- **Tool**: `exact_tool_name`
- **Parameters**: `param`: description
- **Action**: What to do

### Step 2: <Action>
...
</workflow>

<error_handling>
- If `tool_name` fails with error X, do Y.
</error_handling>
</template>

## Step 4: Sync to Plugin (Optimus Developers Only)

If you are working on the `optimus-code` repository itself, also copy the new skill to:
- `optimus-plugin/skills/<skill-name>/SKILL.md`

This ensures new users get the skill when they run `optimus init`.

</instructions>

<anti_patterns>
- Do NOT duplicate existing skills — run `ls .optimus/skills/` first
- Do NOT reference MCP tools without verifying they exist
- Do NOT put skill files directly in `.optimus/skills/` — they must be in a named subdirectory
- Do NOT use legacy `github_create_issue` or `github_create_pr` — use `vcs_create_work_item` and `vcs_create_pr`
</anti_patterns>
