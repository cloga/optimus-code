# Architecture Proposal: Distributing Optimus as a Pure Claude Code Plugin

## 1. Context & Paradigm Shift
**CRITICAL SHIFT:** The Optimus project is officially deprecating its identity as a "VS Code Extension". The core product is now a **100% Native Claude Code Plugin** (backed by the Model Context Protocol - MCP). 

Our goal is to allow any developer to install this plugin and immediately use the "Spartan Swarm", "Hybrid SDLC", and all Optimus tools directly from their terminal via the `claude` CLI.

## 2. The Packaging Problem
Currently, the MCP Server (`src/mcp/mcp-server.ts`) and our rich ecosystem of Prompts / Personas (`optimus-plugin/`, `.optimus/personas/`) live within our source repository. 

To distribute this to end-users, we need a concrete rollout architecture.

## 3. Architecture Questions for the Council
Please provide a technical distribution plan answering the following:

1. **Packaging Mechanism (`NPM` vs Standalone):** 
   Should this be published as an npm package (e.g., `npm i -g @optimus/mcp`)? If so, what should the `package.json` `bin` mapping look like? How do we strip out the legacy VS Code artifacts safely?

2. **Claude Code Integration (Registration):**
   How does a user tell their local Claude Code CLI to start using Optimus? Give the exact `claude mcp add` command or `.claude.json` configuration required.

3. **Asset Bootstrap (The `.optimus` directory):**
   Our system relies on `.optimus/personas/` and `skills/` existing in the user's workspace. If they install this globally, how do those assets get into their target repository? Do we need to expose an `optimus init` CLI command to scaffold these Markdown files?

Please supply the blueprint for making this a zero-friction Claude Code plugin.