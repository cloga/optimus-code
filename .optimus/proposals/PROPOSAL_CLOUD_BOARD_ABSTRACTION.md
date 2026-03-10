# Proposal: Cloud Board Abstraction Layer

## 1. Background & User Insight
During the review of the MCP Service Abstraction, a critical product insight was raised regarding GitHub operations:
**"GitHub is fundamentally just a cloud Kanban/Blackboard. We need an abstraction layer instead of using a direct `github-mcp` because users might use other tools (Jira, GitLab, Linear). From the Swarm's perspective, it is merely the cloud index and storage for the Blackboard."**

Currently, our tools and internal concepts are hard-coupled to GitHub (e.g., `github_create_issue`, `github_sync_board`). If we bake `github_*` commands into the core Agent prompts, we permanently vendor-lock the framework.

## 2. Proposed Architecture: Pluggable Cloud Board

Instead of exposing GitHub-specific MCP tools to the Agents, we expose a **Cloud Board Interface**. The MCP Server routes these abstract commands to the active Provider (configured in `.optimus/config/`).

### A. The Agent Tool Boundary (Agnostic)
Agents solely interact with generic board tools:
- `cloud_board_create_ticket(title, body, type)`
- `cloud_board_update_ticket(ticket_id, status, comment)`
- `cloud_board_query_tickets(query_params)`

### B. The Integration Layer (Provider Pattern)
Inside `mcp-server.ts`, we implement an Adapter Pattern for the Cloud Board:
```typescript
interface CloudBoardProvider {
    createTicket(title: string, body: string): Promise<string>; // Returns standard ID
    updateTicketStatus(id: string, status: 'open' | 'in_progress' | 'closed'): Promise<void>;
    addComment(id: string, comment: string): Promise<void>;
}

// Implementations:
class GitHubBoardProvider implements CloudBoardProvider { /* ... */ }
class JiraBoardProvider implements CloudBoardProvider { /* ... */ }
class LinearBoardProvider implements CloudBoardProvider { /* ... */ }
```

### C. Relationship with Local Blackboard
- **Local Blackboard** (`.optimus/` SQLite or files) is the high-bandwidth, high-frequency *Subconscious Memory* of the project (ephemeral task states, agent memory, deep reasoning logs).
- **Cloud Board** (GitHub/Jira) is the low-bandwidth, human-readable *Conscious State* of the project (Epics, PRs, Bug reports, summaries).
- The `sync` operation pushes distilled local memory up to the Cloud Board.

## 3. Architecture Council Decisions (2026-03-10)

Following a Map-Reduce Swarm Council execution against this document, the following binding decisions were reached:

### A. Schema Normalization (Thick Abstraction)
The abstraction MUST hide provider-specific schemas (like Jira ADF vs GitHub Markdown). The MCP interface will expose a strict, simplified Enum for Agent operations:
- **Canonical Intent Types**: `task | bug | epic | question`. The underlying adapters (e.g., `GitHubBoardAdapter`, `JiraBoardAdapter`) are responsible for translating these into their native equivalents (e.g., a `bug` intent becomes a GitHub Issue with a `[bug]` label vs a Jira issue of type `Bug`).
- Agents MUST remain fully blind to the underlying provider to prevent generating platform-specific artifacts that cause vendor lock-in.

### B. ID Canonicalization & Portability
Providers returning raw IDs (`#29`, `PROJ-123`, `UUID`) create data fragility. The Abstraction Layer MUST return and accept a **Canonical ID** (a framework-assigned UUID stable across providers). The local Blackboard database will maintain an ID Mapping Table (`CanonicalID <-> ProviderNativeID`). This ensures zero ID breakage if the user migrates from GitHub to Linear.

### C. Safe Swarm Sync & Optimistic Concurrency
The Local Blackboard -> Cloud Board `sync` operation is a high-risk concurrency surface. Two sub-agents syncing at the same time can cause duplicate tickets or divergent states.
- The `sync` operation MUST require an **Idempotency Key** when executing `cloud_board_create_ticket`.
- State transitions (like `<status: in_progress>`) MUST execute with **Optimistic Concurrency Control** (e.g., requiring an ETag or `last_updated` field) to prevent Last-Writer-Wins data clobbering.
- This mandates that the local Blackboard layer transitions to a SQLite backend (using WAL mode) prior to or simultaneously with this implementation to handle local write locks.

### D. Ship Strategy (V1)
Our MVP / V1 integration will **ONLY ship with the GitHub Provider** implemented under the hood. However, the system instructions, tools, and agent prompts will be built **exclusively using the generic `cloud_board_*` interface**. This provides maximum MVP speed without compromising the zero vendor lock-in pledge.