#!/usr/bin/env node

/**
 * `optimus upgrade` — Force-overwrite skills, canonical roles, and config
 * from the plugin source while preserving user agents and runtime data.
 */

const fs = require('fs');
const path = require('path');
const { writeClientMcpConfigs } = require('../lib/mcp-config');

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

  // 6. Refresh the local MCP bundle used by generated client configs
  const srcDistPath = path.resolve(pluginRoot, 'dist', 'mcp-server.js');
  const destDistDir = path.join(optimusDir, 'dist');
  const destDistPath = path.join(destDistDir, 'mcp-server.js');
  if (!fs.existsSync(destDistDir)) {
    fs.mkdirSync(destDistDir, { recursive: true });
  }
  if (fs.existsSync(srcDistPath)) {
    fs.copyFileSync(srcDistPath, destDistPath);
    const srcMapPath = srcDistPath + '.map';
    if (fs.existsSync(srcMapPath)) {
      fs.copyFileSync(srcMapPath, destDistPath + '.map');
    }
    // Patch self-reference path: compiled bundle uses __dirname-relative path written
    // for optimus-plugin/dist/ — fix it to resolve correctly from .optimus/dist/
    let distContent = fs.readFileSync(destDistPath, 'utf8');
    const patchedContent = distContent.replace(
      /join\(__dirname,\s*"\.\."\s*,\s*"\.\."\s*,\s*"dist"\s*,\s*"mcp-server\.js"\)/g,
      'join(__dirname, "mcp-server.js")'
    );
    if (patchedContent !== distContent) {
      fs.writeFileSync(destDistPath, patchedContent, 'utf8');
    }
  }
  writeClientMcpConfigs(cwd);
  console.log('\n🔌 Regenerated MCP client configs from .optimus/config/mcp-servers.json');
  console.log('   • VS Code / GitHub Copilot: .vscode/mcp.json');
  console.log('   • GitHub Copilot CLI:       .copilot/mcp-config.json');
  console.log('   • Claude Code:              .mcp.json');
  console.log('   📍 MCP server path: .optimus/dist/mcp-server.js');

  // 7. Ensure system-instructions references exist in IDE instruction files
  const { injectSystemInstructions } = require('../lib/inject');
  const injectResult = injectSystemInstructions(cwd);

  if (injectResult.created.length > 0) {
    console.log('\n📝 Created missing IDE instruction files:');
    for (const f of injectResult.created) console.log(`  + ${f}`);
  }
  if (injectResult.injected.length > 0) {
    console.log('\n🔗 Injected Optimus instructions into:');
    for (const f of injectResult.injected) console.log(`  → ${f}`);
  }
  if (injectResult.replaced.length > 0) {
    console.log('\n🔄 Updated IDE instruction files with latest Optimus guidance:');
    for (const r of injectResult.replaced) {
      const ver = r.from != null ? `(v${r.from} → v${r.to})` : '(updated)';
      console.log(`  → ${r.path} ${ver}`);
    }
  }
  if (injectResult.errors.length > 0) {
    console.log('\n⚠️  Injection warnings:');
    for (const e of injectResult.errors) console.log(`  ! ${e}`);
  }

  // 8. Ensure claude-agent-acp is installed (ACP is now the default for claude-code engine)
  const { execSync } = require('child_process');
  try {
    execSync('claude-agent-acp --version', { stdio: 'ignore', timeout: 5000 });
  } catch {
    console.log('\n📦 Installing claude-agent-acp (now default for claude-code engine)...');
    try {
      execSync('npm install -g @zed-industries/claude-agent-acp', { stdio: 'inherit', timeout: 60000 });
      console.log('  ✅ claude-agent-acp installed');
    } catch (e) {
      console.log('  ⚠️  Auto-install failed. Run manually: npm install -g @zed-industries/claude-agent-acp');
    }
  }

  // 9. Summary
  console.log(`\n✅ Upgrade complete: ${skillCount} skills, ${roleCount} roles, ${configCount} config files updated.`);
  console.log('   User agents and runtime data preserved.\n');
};
