#!/usr/bin/env node

/**
 * Optimus Swarm CLI
 * 
 * Commands:
 *   optimus init       - Bootstrap a .optimus/ workspace in current directory
 *   optimus upgrade    - Upgrade skills, roles, and config from plugin source
 *   optimus serve      - Start the MCP server (stdio transport)
 *   optimus memory     - Manage user-level cross-project memory
 *   optimus version    - Print version
 */

const path = require('path');
const fs = require('fs');

const command = process.argv[2];

switch (command) {
  case 'init':
    require('./commands/init')();
    break;

  case 'upgrade':
    require('./commands/upgrade')();
    break;

  case 'go':
    Promise.resolve(require('./commands/go')()).catch(error => {
      console.error(error.message);
      process.exit(1);
    });
    break;

  case 'memory':
    require('./commands/memory')();
    break;

  case 'serve':
    // Launch the MCP server directly
    require(path.join(__dirname, '..', 'dist', 'mcp-server.js'));
    break;

  case 'version': {
    const pkgV = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(`optimus-swarm v${pkgV.version}`);

    // Build date from compile-time metadata
    const buildMetaPath = path.join(__dirname, '..', 'dist', 'build-meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(buildMetaPath, 'utf8'));
      console.log(`Build date:   ${meta.buildDate}`);
    } catch {
      console.log(`Build date:   unknown`);
    }

    // Skills from installed package
    const skillsDir = path.join(__dirname, '..', 'skills');
    try {
      const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
      console.log(`Skills (${skills.length}):   ${skills.join(', ')}`);
    } catch {
      console.log(`Skills:       none found`);
    }
    break;
  }

  case '--version':
  case '-v': {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(`optimus-swarm v${pkg.version}`);
    break;
  }

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`
Optimus Swarm CLI — Universal Multi-Agent Orchestrator (MCP)

Usage:
  optimus init        Bootstrap .optimus/ workspace in current directory
  optimus go          Launch Copilot CLI for a registered Optimus project
  optimus upgrade     Upgrade skills, roles, and config from plugin source
  optimus memory      Manage user-level cross-project memory
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
