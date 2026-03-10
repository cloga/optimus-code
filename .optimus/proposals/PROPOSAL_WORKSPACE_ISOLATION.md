# Architecture Proposal: Multi-Agent Git Worktree Isolations

## 1. The Concurrency Problem
When multiple autonomous agents (`dev`, `qa-engineer`) are executed concurrently by the Master Orchestrator via the Spartan Swarm, they share the same physical filesystem path (`c:\Users\lochen\optimus-code`). If they attempt to checkout different branches or mutate code simultaneously, Git state will conflict, the TS build will break, and tasks will suffer from race conditions.

## 2. Proposed Solution: `git worktree`
Instead of heavy "Docker-style" full repository cloning on every task (which consumes excessive disk I/O and time), we will utilize native `git worktree`.

### Strategy
1. **Master Directory:** The main workspace stays strictly on `master` or the current human-review branch.
2. **Agent Sandboxes:** The `Master Agent` will explicitly use `git worktree add ../optimus-isolated-task-<id> -b feat/task-<id>` to mount a new workspace folder seamlessly.
3. **Parallel Execution:** Agents will be passed the **absolute path to their temporary worktree mount** in the `delegate_task` payload rather than the root directory. They compile, run tests, and code completely unaffected by each other.
4. **Teardown:** Once the PR is submitted successfully, the `pm` or `Master Agent` destroys the worktree mount via `git worktree remove` and cleans up the branch.

## 3. Action Items for Implementation
- [ ] Create a `WorkspaceManager` class inside `src/managers/` to wrap `git worktree` CLI commands.
- [ ] Update the `delegate_task` MCP tool schema to optionally accept or automatically generate an isolated working directory.
- [ ] Write an integration test proving two synthetic agents can compile the project concurrently in separate directories.

## 4. Git Issue Link
*This proposal is tracked for human visibility at: https://github.com/cloga/optimus-code/issues/5*
