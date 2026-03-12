---
name: git-workflow
description: Standard unified VCS workflow — every code change must go through a branch, PR, and merge for traceability.
---

# Unified VCS Workflow

<purpose>
Every code change must be traceable via a branch and Pull Request. No direct commits to `master`.
</purpose>

<tools_required>
- `vcs_create_work_item`
- `vcs_create_pr`
- `vcs_merge_pr`
- `vcs_add_comment`
- Terminal (for `git` commands)
</tools_required>

<rules>
  <rule>NEVER use the `gh` CLI. Use MCP tools and local `git` only.</rule>
  <rule>NEVER use legacy `github_*` MCP tools. Use `vcs_*` equivalents.</rule>
  <rule>NEVER commit directly to `master` or `main`.</rule>
  <rule>Every change MUST have a PR — this is the traceability guarantee.</rule>
  <rule>ALWAYS switch back to `master` after pushing a feature branch.</rule>
</rules>

<instructions>

<step number="1" name="Identify or Create Tracking Issue">
First, check if a Tracking Issue already exists:
- Look for a "## Tracking Issue" section in your prompt header — it contains the pre-created Issue number
- Check the `OPTIMUS_TRACKING_ISSUE` environment variable
If a Tracking Issue exists, use it. Do NOT create a duplicate.
If none exists, create one via `vcs_create_work_item`.
Capture the Issue ID (e.g., `#113`). Do not proceed without one.
</step>

<step number="2" name="Branch, Commit and Push">
Using local terminal commands:
1. `git checkout -b feature/issue-<ID>-<short-description>`
2. Stage and commit: `git commit -m "feat: <description>, fixes #<ID>"`
3. Push: `git push -u origin <branch-name>`
</step>

<step number="3" name="Verify Before PR">
Before creating a PR, you MUST verify your changes:
1. If the project has a build step (e.g., `npm run build`, `dotnet build`), run it and confirm zero errors.
2. If test scripts exist (e.g., `npm test`), run them and confirm all pass.
3. If neither exists, at minimum review the diff (`git diff HEAD~1`) to sanity-check your changes.
Do NOT create a PR with broken builds or failing tests.
</step>

<step number="4" name="Create Pull Request">
Invoke `vcs_create_pr` with `title`, `head`, `base` (master), and `body` containing `Fixes #<ID>`.
</step>

<step number="5" name="Merge Pull Request">
Invoke `vcs_merge_pr` to merge the PR into master. Use `merge_method: "squash"` for clean history.
</step>

<step number="6" name="Workspace Reversion">
Run `git checkout master && git pull` to sync the merged changes locally.
</step>

</instructions>

<error_handling>
- **401/403 Credential Error**: Halt and instruct user to verify `GITHUB_TOKEN` or `ADO_PAT`.
- **Comment Type Error**: `vcs_add_comment` requires `item_type: "workitem"` or `"pullrequest"`.
- **Merge Conflict**: DO NOT force push. Halt and request intervention.
</error_handling>
