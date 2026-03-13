#!/usr/bin/env node

/**
 * `optimus init` — Bootstrap a .optimus/ workspace in the current directory.
 * 
 * Copies starter personas, config, and creates required subdirectories.
 * Appends .optimus ignore entries to .gitignore if not already present.
 */

const fs = require('fs');
const path = require('path');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`  ✅ Created ${path.relative(process.cwd(), destPath)}`);
      } else {
        console.log(`  ⏭️  Skipped ${path.relative(process.cwd(), destPath)} (already exists)`);
      }
    }
  }
}

module.exports = function init() {
  const cwd = process.cwd();
  const optimusDir = path.join(cwd, '.optimus');
  const scaffoldDir = path.resolve(__dirname, '..', '..', 'scaffold');
  const pluginRoot = path.resolve(__dirname, '..', '..');

  console.log('\n🤖 Optimus Swarm — Initializing workspace...\n');

  // 0. Perform V3 Architecture Migrations
  const legacyPersonasDir = path.join(optimusDir, 'personas');
  const newAgentsDir = path.join(optimusDir, 'agents');
  if (fs.existsSync(legacyPersonasDir) && !fs.existsSync(newAgentsDir)) {
    try {
      fs.renameSync(legacyPersonasDir, newAgentsDir);
      console.log('  🔄 Migrated legacy .optimus/personas/ to .optimus/agents/');
    } catch(e) {
      console.error('  ⚠️ Failed to migrate legacy personas folder:', e.message);
    }
  }

  // 1. Create required subdirectories
  // Most agents are auto-generated at runtime via the T3→T2→T1 Cascade.
  // Only the PM (Master Agent) is pre-installed — it bootstraps the entire
  // workflow and cannot be dynamically generated since it's the entry point.
  const dirs = ['config', 'skills', 'agents', 'tasks', 'reports', 'reviews', 'memory', 'state', 'system'];
  for (const dir of dirs) {
    const dirPath = path.join(optimusDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`  📁 Created .optimus/${dir}/`);
    }
  }

  // 2. Copy scaffold config (system instructions — single source of truth)
  const configSrc = path.join(scaffoldDir, 'config');
  if (fs.existsSync(configSrc)) {
    console.log('\n⚙️  Installing system config...');
    copyDirRecursive(configSrc, path.join(optimusDir, 'config'));
  }


  // 2.1 Copy scaffold system config (meta-crontab, cron-locks)
  const systemSrc = path.join(scaffoldDir, 'system');
  if (fs.existsSync(systemSrc)) {
    console.log('\n\u23f0 Installing system scheduler config...');
    copyDirRecursive(systemSrc, path.join(optimusDir, 'system'));
  }

  // 2.5 Copy plugin roles as starter T2 templates.
  // These provide rich persona definitions for common roles (architect, pm, qa-engineer, etc.)
  // so that council reviews and delegations have meaningful agent context from day one.
  // Roles are only copied if they don't already exist (won't overwrite user customizations).
  const rolesSrc = path.join(pluginRoot, 'roles');
  if (fs.existsSync(rolesSrc)) {
    console.log('\n👥 Installing starter role templates (T2 personas)...');
    copyDirRecursive(rolesSrc, path.join(optimusDir, 'roles'));
  }

  // 3. Copy plugin skills — these are the CORE deliverable.
  // Skills teach the AI how to use MCP tools (dispatch_council, delegate_task, etc.)
  // Without these, the AI has tools but no instruction manual.
  const skillsSrc = path.join(pluginRoot, 'skills');
  if (fs.existsSync(skillsSrc)) {
    console.log('\n📚 Installing skills (MCP tool operation manuals)...');
    copyDirRecursive(skillsSrc, path.join(optimusDir, 'skills'));
  }

  // 3.5 Generate or merge .vscode/mcp.json for VS Code / Copilot users
  const vscodeMcpDir = path.join(cwd, '.vscode');
  const vscodeMcpPath = path.join(vscodeMcpDir, 'mcp.json');
  if (!fs.existsSync(vscodeMcpDir)) {
    fs.mkdirSync(vscodeMcpDir, { recursive: true });
  }
  // Resolve the actual dist path relative to this CLI package
  const distPath = path.resolve(pluginRoot, 'dist', 'mcp-server.js');
  const spartanEntry = {
    type: "stdio",
    command: "node",
    args: [distPath],
    env: {
      "OPTIMUS_WORKSPACE_ROOT": "${workspaceFolder}",
      "DOTENV_PATH": "${workspaceFolder}/.env",
      "PATH": "${env:PATH}"
    }
  };

  if (fs.existsSync(vscodeMcpPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(vscodeMcpPath, 'utf8'));
      const key = existing.servers ? 'servers' : 'mcpServers';
      if (!existing[key]) existing[key] = {};
      if (!existing[key]['spartan-swarm']) {
        existing[key]['spartan-swarm'] = spartanEntry;
        fs.writeFileSync(vscodeMcpPath, JSON.stringify(existing, null, 4), 'utf8');
        console.log('\n🔌 Merged spartan-swarm into existing .vscode/mcp.json');
      } else {
        console.log('\n⏭️  Skipped .vscode/mcp.json (spartan-swarm already configured)');
      }
    } catch (e) {
      console.log('\n⚠️  Could not parse existing .vscode/mcp.json, skipping merge');
    }
  } else {
    const mcpConfig = { servers: { "spartan-swarm": spartanEntry }, inputs: [] };
    fs.writeFileSync(vscodeMcpPath, JSON.stringify(mcpConfig, null, 4), 'utf8');
    console.log('\n🔌 Generated .vscode/mcp.json (MCP server config for VS Code / Copilot)');
  }
  console.log(`   📍 MCP server path: ${distPath}`);
  console.log('   💡 Users can change DOTENV_PATH to point to a different env file.');

  // 4. Append to .gitignore if needed
  const gitignorePath = path.join(cwd, '.gitignore');
  const optIgnorePath = path.join(scaffoldDir, '.gitignore-optimus');
  if (fs.existsSync(optIgnorePath)) {
    const ignoreEntries = fs.readFileSync(optIgnorePath, 'utf8');
    let existingIgnore = '';
    if (fs.existsSync(gitignorePath)) {
      existingIgnore = fs.readFileSync(gitignorePath, 'utf8');
    }
    if (!existingIgnore.includes('.optimus/reports/')) {
      fs.appendFileSync(gitignorePath, '\n# Optimus Swarm generated artifacts\n' + ignoreEntries);
      console.log('\n📝 Updated .gitignore with Optimus entries');
    }
  }

  // 5. Inject reference into existing AI client instruction files (do NOT create new ones)
  // Single source of truth: .optimus/config/system-instructions.md (also served via MCP Resource)
  const injectMarker = '<!-- optimus-instructions -->';
  const injectBlock = [
    injectMarker,
    '<!-- Auto-injected by optimus init — DO NOT EDIT this block -->',
    '## Optimus Swarm Instructions',
    '',
    'This project uses the [Optimus Spartan Swarm](https://github.com/cloga/optimus-code) multi-agent orchestrator.',
    'System instructions are maintained in `.optimus/config/system-instructions.md` and served via MCP Resource `optimus://system/instructions`.',
    '',
    'Please read and follow `.optimus/config/system-instructions.md` for all workflow protocols.',
    '<!-- /optimus-instructions -->',
  ].join('\n');

  let injected = [];

  // Claude Code: CLAUDE.md (only if it already exists)
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    if (!existing.includes(injectMarker)) {
      fs.appendFileSync(claudeMdPath, '\n\n' + injectBlock + '\n');
      injected.push('CLAUDE.md');
    }
  }

  // GitHub Copilot: .github/copilot-instructions.md (only if it already exists)
  const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
  if (fs.existsSync(copilotPath)) {
    const existing = fs.readFileSync(copilotPath, 'utf8');
    if (!existing.includes(injectMarker)) {
      fs.appendFileSync(copilotPath, '\n\n' + injectBlock + '\n');
      injected.push('.github/copilot-instructions.md');
    }
  }

  // Cursor: .cursor/rules/ (only if directory already exists)
  const cursorRulesDir = path.join(cwd, '.cursor', 'rules');
  if (fs.existsSync(cursorRulesDir)) {
    const cursorRulePath = path.join(cursorRulesDir, 'optimus.mdc');
    if (!fs.existsSync(cursorRulePath)) {
      fs.writeFileSync(cursorRulePath, injectBlock + '\n', 'utf8');
      injected.push('.cursor/rules/optimus.mdc');
    }
  }

  if (injected.length > 0) {
    console.log('\n🔗 Injected Optimus reference into existing client config(s):');
    for (const f of injected) console.log(`  → ${f}`);
  }

  console.log('\n✅ Workspace initialized! Your .optimus/ directory is ready.');
  console.log('   System instructions: .optimus/config/system-instructions.md (served via MCP Resource)');
  console.log('   Run `optimus serve` or configure your MCP client to start.\n');
};
