# architecture Proposal: Agnostic Agent Instructions & Continuous Core Memory

## Context
Currently, our master system instructions (including the 'Issue First' protocol) are being stored in \.github/copilot-instructions.md\. The user has correctly identified that this tightly couples our workflow to GitHub Copilot, violating our goal of becoming a universal, standalone Claude Code MCP plugin.

Furthermore, we need a mechanism where the plugin can 'continuously evolve', solidifying newly learned project experiences automatically into its core system context.

## Core Questions for the Council
1. **Instruction Location**: Where and how should we store the master instructions inside the \.optimus/\ directory so that it is agnostic to the LLM UI client (Claude Code, Copilot, Cursor)? 
2. **Context Injection**: Since Claude Code doesn't automatically read \copilot-instructions.md\, how should our MCP server serve these agnostic instructions? (e.g., via a specific \get_system_context\ MCP tool, or as a resource?)
3. **Continuous Evolution (Memory)**: How should we structure \.optimus/knowledge/\ or \.optimus/memory/\ to automatically capture project experience and integrate it into the global agent workflow?

Please provide a technical design for the \.optimus\ scaffolding and the injection mechanism.