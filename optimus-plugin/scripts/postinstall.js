#!/usr/bin/env node

/**
 * postinstall hook for @anthropic-ai/optimus-swarm-mcp
 * 
 * After npm install, this script provides guidance on how to register
 * the MCP server with Claude Code.
 */

const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const serverPath = path.join(pluginRoot, 'dist', 'mcp-server.js');

console.log(`
╔══════════════════════════════════════════════════════════════╗
║        🤖 Optimus Swarm MCP Plugin — Installed!            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  To register with Claude Code, run:                          ║
║                                                              ║
║    claude mcp add optimus-facade node ${serverPath}          ║
║                                                              ║
║  To bootstrap a workspace with Optimus personas/skills:      ║
║                                                              ║
║    npx optimus init                                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
