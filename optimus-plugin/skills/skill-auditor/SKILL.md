---
name: skill-auditor
description: Audits new or modified skills for Optimus compliance before deployment. Use this skill whenever reviewing a skill that has been created or changed — check file paths, MCP tool references, structural quality, and error handling. Also use when doing a quality sweep of all skills in the project.
---

# Skill Auditor

Validates that skills meet Optimus standards before they ship. Think of this as a
linter for SKILL.md files — it catches problems that would cause runtime failures
or confuse agents.

## When to audit

- After creating a new skill (via `skill-creator` or manually)
- After modifying an existing skill
- Before a release to verify all skills are consistent
- When an agent reports a skill-related failure

## What to check

### 1. File structure

The skill must live at `.optimus/skills/<skill-name>/SKILL.md`. The directory name
must be lowercase, hyphenated, and match the `name` field in frontmatter.

```
✅  .optimus/skills/data-migration/SKILL.md
❌  .optimus/skills/DataMigration/skill.md
❌  .optimus/skills/data-migration.md  (no subdirectory)
```

### 2. YAML frontmatter

Required fields:
- `name`: Must match the directory name
- `description`: Should be specific about WHEN to trigger, not just WHAT it does.
  A good description is slightly "pushy" — it tells the model to use this skill
  even in borderline cases.

```yaml
# Bad — too vague
description: Helps with database tasks.

# Good — tells the model when to trigger
description: Manages database migration workflows including schema changes,
  seed data, and rollbacks. Use whenever the user mentions migrations, schema
  updates, database versioning, or Flyway/Liquibase.
```

### 3. MCP tool accuracy

Every tool name referenced in the skill must actually exist in the MCP server.
Current valid tools:

| Tool | Purpose |
|------|---------|
| `vcs_create_work_item` | Create Issue / Work Item |
| `vcs_create_pr` | Create Pull Request |
| `vcs_merge_pr` | Merge Pull Request |
| `vcs_add_comment` | Comment on Issue or PR |
| `vcs_update_work_item` | Update Issue state |
| `vcs_list_work_items` | List work items with filters |
| `roster_check` | List available agents/roles/skills |
| `delegate_task` / `delegate_task_async` | Dispatch work |
| `dispatch_council` / `dispatch_council_async` | Multi-expert review |
| `check_task_status` | Poll async task |
| `append_memory` | Save learnings |

Red flags:
- `github_create_issue` → replaced by `vcs_create_work_item`
- `github_create_pr` → replaced by `vcs_create_pr`
- Any tool name not in the table above → likely hallucinated

### 4. Error handling

Skills that reference MCP tools should include recovery guidance. At minimum:
- What to do on auth/credential errors (401/403)
- What to do on invalid parameters
- When to halt vs. retry

### 5. Writing quality (per skill-creator guidelines)

- Explain the WHY, not just impose rules. Heavy-handed MUSTs and NEVERs are a
  yellow flag — reframe as reasoning when possible.
- Include at least one concrete example showing correct usage.
- Keep the skill under 500 lines. If approaching the limit, split into
  reference files in the skill's subdirectory.
- Anti-patterns section should describe real mistakes, not hypothetical ones.

## Audit output

After reviewing, report:
1. **Pass/Fail** for each check
2. **Specific fixes** needed (with line references if possible)
3. **Severity**: blocking (must fix before use) vs. advisory (improve later)

## Syncing audited skills

If working on the `optimus-code` repository, remember to sync changes to both:
- `.optimus/skills/<name>/SKILL.md` (host project)
- `optimus-plugin/skills/<name>/SKILL.md` (ships to users)
