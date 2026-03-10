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
║  To register with any MCP Client (Goose, Cursor, Claude):    ║
║                                                              ║
║    Command: node                                             ║
║    Args:    ${serverPath}      ║
║                                                              ║
║  To bootstrap a workspace with Optimus agents/skills:        ║
║                                                              ║
║    npx optimus init                                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
