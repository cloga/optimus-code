#!/usr/bin/env node

/**
 * `optimus upgrade` — Force-overwrite skills, canonical roles, and config
 * from the plugin source while preserving user agents and runtime data.
 */

const fs = require('fs');
const path = require('path');

function deepMergePreserveUser(template, user) {
  const result = { ...template };
  for (const key of Object.keys(user)) {
    if (typeof user[key] === 'object' && user[key] !== null && !Array.isArray(user[key])
        && typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = deepMergePreserveUser(result[key], user[key]);
    } else {
      result[key] = user[key];
    }
  }
  return result;
}

function mergeConfigFiles(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += mergeConfigFiles(srcPath, destPath);
    } else if (entry.name.endsWith('.json') && fs.existsSync(destPath)) {
      try {
        const template = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
        const user = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        const merged = deepMergePreserveUser(template, user);
        fs.writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf8');
        if (JSON.stringify(merged) !== JSON.stringify(template)) {
          console.log(`  ℹ️  ${entry.name}: preserved your existing config (organization, project, etc.)`);
        } else {
          console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)}`);
        }
      } catch (e) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)} (overwritten — parse error)`);
      }
      count++;
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)}`);
      count++;
    }
  }
  return count;
}

function copyDirForceOverwrite(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirForceOverwrite(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)}`);
      count++;
    }
  }
  return count;
}

module.exports = function upgrade() {
  const cwd = process.cwd();
  const optimusDir = path.join(cwd, '.optimus');
  const scaffoldDir = path.resolve(__dirname, '..', '..', 'scaffold');
  const pluginRoot = path.resolve(__dirname, '..', '..');

  // Pre-check: .optimus/ must exist
  if (!fs.existsSync(optimusDir)) {
    console.error('Error: No .optimus/ directory found. Run \'optimus init\' first.');
    process.exit(1);
  }

  // Print version
  const pkgPath = path.join(pluginRoot, 'package.json');
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  console.log(`\n🔄 Upgrading to optimus-swarm v${version}...\n`);

  let skillCount = 0;
  let roleCount = 0;
  let configCount = 0;

  // 1. Skills: FORCE OVERWRITE
  const skillsSrc = path.join(pluginRoot, 'skills');
  if (fs.existsSync(skillsSrc)) {
    console.log('📚 Upgrading skills...');
    skillCount = copyDirForceOverwrite(skillsSrc, path.join(optimusDir, 'skills'));
  }

  // 2. Roles: FORCE OVERWRITE plugin roles only (leave user-created roles untouched)
  const rolesSrc = path.join(pluginRoot, 'roles');
  if (fs.existsSync(rolesSrc)) {
    console.log('\n👥 Upgrading canonical roles...');
    roleCount = copyDirForceOverwrite(rolesSrc, path.join(optimusDir, 'roles'));
  }

  // 3. Config: MERGE (preserve user values in JSON files)
  const configSrc = path.join(scaffoldDir, 'config');
  if (fs.existsSync(configSrc)) {
    console.log('\n⚙️  Upgrading system config...');
    configCount = mergeConfigFiles(configSrc, path.join(optimusDir, 'config'));
  }


  // 4.5 System scaffold: ensure meta-crontab and cron-locks are present
  const systemSrc = path.join(scaffoldDir, 'system');
  if (fs.existsSync(systemSrc)) {
    console.log('\n\u23f0 Upgrading system scheduler config...');
    const destSystem = path.join(optimusDir, 'system');
    if (!fs.existsSync(destSystem)) fs.mkdirSync(destSystem, { recursive: true });

    // meta-crontab.json: preserve user entries, only install if missing
    const crontabSrc = path.join(systemSrc, 'meta-crontab.json');
    const crontabDest = path.join(destSystem, 'meta-crontab.json');
    if (fs.existsSync(crontabSrc) && !fs.existsSync(crontabDest)) {
      fs.copyFileSync(crontabSrc, crontabDest);
      console.log('  \u2705 Installed default meta-crontab.json');
    } else if (fs.existsSync(crontabDest)) {
      console.log('  \u23ed\ufe0f  meta-crontab.json preserved (user config)');
    }

    // Ensure cron-locks directory exists
    const cronLocksDir = path.join(destSystem, 'cron-locks');
    if (!fs.existsSync(cronLocksDir)) {
      fs.mkdirSync(cronLocksDir, { recursive: true });
      fs.writeFileSync(path.join(cronLocksDir, '.gitkeep'), '');
      console.log('  \u2705 Created cron-locks directory');
    }
  }

  // 4. Agents: NEVER TOUCH
  console.log('\n⏭️  Agents preserved (runtime instances)');

  // 5. State/Tasks/Reports/Reviews/Memory: NEVER TOUCH
  console.log('⏭️  Runtime data preserved');

  // 6. .vscode/mcp.json: Re-generate spartan-swarm entry (always overwrite)
  const vscodeMcpDir = path.join(cwd, '.vscode');
  const vscodeMcpPath = path.join(vscodeMcpDir, 'mcp.json');
  if (!fs.existsSync(vscodeMcpDir)) {
    fs.mkdirSync(vscodeMcpDir, { recursive: true });
  }
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
      existing[key]['spartan-swarm'] = spartanEntry;
      fs.writeFileSync(vscodeMcpPath, JSON.stringify(existing, null, 4), 'utf8');
      console.log('\n🔌 Updated spartan-swarm entry in .vscode/mcp.json');
    } catch (e) {
      console.log('\n⚠️  Could not parse existing .vscode/mcp.json, skipping merge');
    }
  } else {
    const mcpConfig = { servers: { "spartan-swarm": spartanEntry }, inputs: [] };
    fs.writeFileSync(vscodeMcpPath, JSON.stringify(mcpConfig, null, 4), 'utf8');
    console.log('\n🔌 Generated .vscode/mcp.json (MCP server config for VS Code / Copilot)');
  }
  console.log(`   📍 MCP server path: ${distPath}`);

  // 7. Summary
  console.log(`\n✅ Upgrade complete: ${skillCount} skills, ${roleCount} roles, ${configCount} config files updated.`);
  console.log('   User agents and runtime data preserved.\n');
};
