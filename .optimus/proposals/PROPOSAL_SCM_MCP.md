# PROPOSAL: Generic SCM/VCS Integration MCP (Starting with GitHub)

## Objective
The goal is to design an architecture for a new MCP (Model Context Protocol) component that acts as an abstraction layer across different Source Control / Issue Management tools. 
While the underlying abstraction should support GitLab, Bitbucket, Azure DevOps in the future, the **V1 implementation will exclusively target GitHub**, leveraging the user's existing authenticated state to minimize setup.

## The "Happy Path" E2E Case to Support
The new MCP should enable the following lifecycle autonomously:
1. **Issue Creation**: Establish a GitHub Issue containing the `architect`'s proposal.
2. **Implementation & PR**: A `dev` or `pm` agent writes the code, commits it to a branch, and opens a Pull Request linked to the Issue.
3. **QA & Approval**: A `qa-engineer` agent reviews the PR diff, tests the changes, and leaves an "Approve" review on the Pull Request.

## Requirements from the Council
As a System Architect and a PM encountering this, please provide your design on:
1. **Tool Definitions**: What exact tools (functions) should this MCP expose to the Swarm? (e.g. `create_issue`, `create_pr`, `review_pr`). 
2. **Abstraction Strategy**: How should we structure the TypeScript interfaces so that adding GitLab later doesn't break the tools used by agents?
3. **Execution Steps**: Provide a step-by-step breakdown of how the agents orchestrate this "Happy Path" using the proposed MCP tools.