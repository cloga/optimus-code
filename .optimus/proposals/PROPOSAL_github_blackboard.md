# PROPOSAL: Migrate Agent Blackboard to GitHub Issues & Pull Requests

## 1. Context & Background
Currently, the Optimus Spartan Swarm utilizes a local, file-based "Blackboard" architecture. State, tasks, and memory are stored strictly within the local project workspace under `.optimus/` (e.g., `.optimus/tasks/`, `.optimus/reports/`). Agents interact by reading and writing files locally.

## 2. Proposed Architectural Shift
The user has proposed upgrading the Blackboard system to rely purely on GitHub infrastructure:
1. **Task Management (GitHub Issues)**: The Master Agent translates epic requirements into GitHub Issues. Sub-agents (`pm`, `architect`, `dev`, `qa`) read their task queues from the GitHub API, communicate via Issue Comments, and close issues upon completion.
2. **Code Implementation (GitHub PRs)**: Instead of the `dev` agent writing code mutations directly into the user's active local workspace, the agent will checkout a new branch via git, commit changes, and submit a GitHub Pull Request.
3. **QA & Review (GitHub Actions/CI)**: The `qa-engineer` agent intercepts the generated Pull Request, reviews the diff, leaves inline comments, and optionally runs Actions/CI before user approval.

## 3. Areas for Council Evaluation
Please review this proposal from your respective domains and provide critical feedback on:
- **Performance & Latency**: Impact on the local "inner loop" development speed. Is the GitHub API too slow for micro-task coordination?
- **Authentication & Security**: The risks of handing out full Repo-write and PR-create permissions to autonomous agents.
- **State Management**: Handling GitHub API rate limits and synchronization vs a simple local SQLite/File state.
- **Developer Experience (DX)**: Does this reduce user intervention, or increase overhead (having to click "Merge" on PRs instead of just seeing the code change in VS Code)?

**Recommendation required**: Should we reject, accept, or offer a hybrid architecture (e.g., local blackboard for micro-tasks, GitHub for macro-epics)?