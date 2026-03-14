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
  const dirs = ['config', 'skills', 'agents', 'tasks', 'reports', 'reviews', 'memory', 'state', 'system', 'specs', 'results'];
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

  // 5. Inject system-instructions reference into IDE client config files
  const { injectSystemInstructions } = require('../lib/inject');
  const injectResult = injectSystemInstructions(cwd);

  if (injectResult.created.length > 0) {
    console.log('\n📝 Created IDE instruction files:');
    for (const f of injectResult.created) console.log(`  + ${f}`);
  }
  if (injectResult.injected.length > 0) {
    console.log('\n🔗 Injected Optimus instructions into existing files:');
    for (const f of injectResult.injected) console.log(`  → ${f}`);
  }
  if (injectResult.replaced.length > 0) {
    console.log('\n🔄 Updated stale instruction blocks:');
    for (const r of injectResult.replaced) {
      const ver = r.from != null ? `(v${r.from} → v${r.to})` : '(updated)';
      console.log(`  → ${r.path} ${ver}`);
    }
  }
  if (injectResult.skipped.length > 0) {
    console.log('\n⏭️  Already configured:');
    for (const f of injectResult.skipped) console.log(`  ✓ ${f}`);
  }
  if (injectResult.errors.length > 0) {
    console.log('\n⚠️  Warnings:');
    for (const e of injectResult.errors) console.log(`  ! ${e}`);
  }

  console.log('\n✅ Workspace initialized! Your AI development team is ready.');
  console.log('\n📋 What happened:');
  console.log('   • Created .optimus/ with agent roles, skills, and config');
  console.log('   • Configured MCP server connection for your IDE');
  console.log('   • Injected Optimus instructions into IDE config files');
  console.log('\n🚀 Next steps:');
  console.log('   1. Restart your IDE (or run "Developer: Reload Window" in VS Code)');
  console.log('   2. Open your AI assistant and try one of these prompts:');
  console.log('');
  console.log('   💬 "Run roster_check to see what agents are available"');
  console.log('   💬 "Help me build [your feature] — use the Optimus swarm to delegate the work"');
  console.log('   💬 "Create a GitHub Issue for [task] and delegate it to the right specialist"');
  console.log('');
  console.log('   📖 Full protocol: .optimus/config/system-instructions.md');
  console.log('');
};
