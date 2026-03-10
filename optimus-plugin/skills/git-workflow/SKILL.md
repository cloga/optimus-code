---
name: standard_pr_workflow
description: Executing standard Git branch creation, Pull Request generation, and Agile Issue tracking workflow.
triggers:
  - "PR"
  - "pull request"
  - "commit"
  - "push code"
  - "close issue"
---

# Git Workflow & Pull Request Skill (Standard SDLC)

You are operating under the strict **"Issue First" Hybrid SDLC Protocol**. It is an architectural violation to implement code and merge it straight to `master` without creating a PR or updating the tracking Issue.

## The Standard Protocol

When asked to "commit the code", "create a PR", or handle "code changes", you MUST execute the following exact sequence:

### 1. Identify or Create the Tracking Issue
Every code change must relate to a GitHub Issue (e.g., `#29`).
- If none exists, **use the MCP Tool `github_create_issue`** to create one. Pass `owner`, `repo`, `title`, `body`, and optionally `local_path`.
- Do not proceed until you have an Issue Number.

### 2. Branch, Commit & Push (local git only)
Local `git` commands are acceptable for branch management, staging, committing, and pushing. These are purely local operations.
- Branch: `git checkout -b feature/issue-<ID>-short-desc`
- Commit (Conventional Commits + Issue ref): `git commit -m "feat: Implement T1/T2 instantiation, closes #29"`
- Push: `git push -u origin <branch-name>`

**Never commit directly to `master`** for standard feature work unless explicitly overridden by the User (PM).

### 5. Create Pull Request (MUST use MCP Tool)
Create the PR and assign the corresponding tracking metadata.
- **You MUST use the MCP Tool `github_create_pr`** to create the Pull Request. **DO NOT** use `gh` CLI or manual terminal commands for this step. The system is configured with correct credentials internally.
- Use your registered MCP tool calls explicitly passing `owner`, `repo`, `title`, `head`, `base` (usually 'master'), and `body`.
- If the PR needs to be merged after checking, use the MCP Tool `github_merge_pr`.

### 6. Update Blackboard / T1 Memory
Once the PR is open, update the local Project Blackboard and/or the T1 Agent Memory `.optimus/agents/<your_role>.md` to record that the implementation is complete and pending review.

## Constraints & Error Handling
- **Missing Token / Auth Failures**: If an MCP GitHub tool fails with a token error, verify `GITHUB_TOKEN` is set in the environment. Do not loop endlessly. Report the exact error to the user and stop.
- **Merge Conflicts**: If the branch cannot be pushed cleanly, stop and ask the Architect or Developer to rebase. Do not forcefully overwrite origin.
- **Dirty Tree**: Stash or advise the user to review untracked files before creating a new branch.

## Forbidden Operations
- **DO NOT** use `gh` CLI (`gh pr`, `gh issue`, `gh api`, etc.) for any GitHub operations. All GitHub interactions MUST go through the project's MCP tools: `github_create_issue`, `github_create_pr`, `github_merge_pr`, `github_update_issue`, `github_sync_board`.
- Local `git` commands (`git add`, `git commit`, `git push`, `git checkout`, `git branch`) are permitted for local repository operations.