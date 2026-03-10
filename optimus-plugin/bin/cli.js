#!/usr/bin/env node

/**
 * Optimus Swarm CLI
 * 
 * Commands:
 *   optimus init       - Bootstrap a .optimus/ workspace in current directory
 *   optimus serve      - Start the MCP server (stdio transport)
 *   optimus version    - Print version
 */

const path = require('path');
const fs = require('fs');

const command = process.argv[2];

switch (command) {
  case 'init':
    require('./commands/init')();
    break;

  case 'serve':
    // Launch the MCP server directly
    require(path.join(__dirname, '..', 'dist', 'mcp-server.js'));
    break;

  case 'version':
  case '--version':
  case '-v':
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(`optimus-swarm v${pkg.version}`);
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`
Optimus Swarm CLI — Multi-Agent Orchestrator for Claude Code

Usage:
  optimus init        Bootstrap .optimus/ workspace in current directory
  optimus serve       Start MCP server (stdio transport)
  optimus version     Print version

Docs: https://github.com/cloga/optimus-code
`);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'optimus help' for usage information.`);
    process.exit(1);
}
