#!/usr/bin/env node

/**
 * `optimus upgrade` — Force-overwrite skills, canonical roles, and config
 * from the plugin source while preserving user agents and runtime data.
 */

const fs = require('fs');
const path = require('path');
const { writeClientMcpConfigs, writeCopilotLaunchers } = require('../lib/mcp-config');
const { getProjectsRegistryPath, loadProjectRegistry, registerProject } = require('../lib/project-registry');
const {
  copyFileForce,
  disableProjectAvailableAgentsOverride,
  deepMergePreserveUser,
  getUserAvailableAgentsConfigPath,
  syncAvailableAgentsConfig,
} = require('../lib/available-agents-config');

const DISABLE_PROJECT_AVAILABLE_AGENTS_FLAG = '--disable-project-available-agents';

function mergeConfigFiles(srcDir, destDir, options = {}) {
  const skippedNames = new Set(options.skippedNames || []);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (skippedNames.has(entry.name)) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += mergeConfigFiles(srcPath, destPath, options);
    } else if (entry.name.endsWith('.json') && fs.existsSync(destPath)) {
      try {
        const template = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
        const user = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        const merged = deepMergePreserveUser(template, user);
        fs.writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf8');
        if (JSON.stringify(merged) !== JSON.stringify(template)) {
          if (!options.quiet) console.log(`  ℹ️  ${entry.name}: preserved your existing config (organization, project, etc.)`);
        } else {
          if (!options.quiet) console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)}`);
        }
      } catch (e) {
        fs.copyFileSync(srcPath, destPath);
        if (!options.quiet) console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)} (overwritten — parse error)`);
      }
      count++;
    } else {
      fs.copyFileSync(srcPath, destPath);
      if (!options.quiet) console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)}`);
      count++;
    }
  }
  return count;
}

function copyDirForceOverwrite(src, dest, quiet) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirForceOverwrite(srcPath, destPath, quiet);
    } else {
      fs.copyFileSync(srcPath, destPath);
      if (!quiet) console.log(`  🔄 Updated ${path.relative(process.cwd(), destPath)}`);
      count++;
    }
  }
  return count;
}

function upgradeProject(projectPath, pluginRoot, options = {}) {
  const quiet = options.quiet || false;
  const disableProjectAvailableAgents = options.disableProjectAvailableAgents || false;

  try {
    const optimusDir = path.join(projectPath, '.optimus');
    const scaffoldDir = path.join(pluginRoot, 'scaffold');

    if (!fs.existsSync(optimusDir)) {
      return { success: false, error: "No .optimus/ directory found. Run 'optimus init' first." };
    }

    // User-Level Directory for Universal Meta Skills and Roles
    const os = require('os');
    const userOptimusDir = process.env.OPTIMUS_USER_HOME || path.join(os.homedir(), '.optimus');
    const copilotSkillsDir = path.join(os.homedir(), '.copilot', 'skills');
    const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');

    let skillCount = 0;
    let roleCount = 0;
    let configCount = 0;
    const availableAgentsTemplatePath = path.join(scaffoldDir, 'config', 'available-agents.json');
    const availableAgentsProjectSampleTemplatePath = path.join(scaffoldDir, 'config', 'available-agents.project.sample.json');
    const projectConfigDir = path.join(optimusDir, 'config');
    const agentsPath = path.join(projectConfigDir, 'available-agents.json');
    const projectSamplePath = path.join(projectConfigDir, 'available-agents.project.sample.json');

    // 1. Meta-Skills: Copy to User-Level Directory (~/.optimus/skills) and IDE native registries
    const skillsSrc = path.join(pluginRoot, 'skills');
    if (fs.existsSync(skillsSrc)) {
      if (!quiet) console.log('📚 Upgrading universal meta-skills to user-level directory and IDE registries...');
      skillCount = copyDirForceOverwrite(skillsSrc, path.join(userOptimusDir, 'skills'), quiet);
      copyDirForceOverwrite(skillsSrc, copilotSkillsDir, true);
      copyDirForceOverwrite(skillsSrc, claudeSkillsDir, true);
    }

    // 2. Meta-Roles: Copy to User-Level Directory (~/.optimus/roles)
    const rolesSrc = path.join(pluginRoot, 'roles');
    if (fs.existsSync(rolesSrc)) {
      if (!quiet) console.log('\n👥 Upgrading universal meta-roles to user-level directory...');
      roleCount = copyDirForceOverwrite(rolesSrc, path.join(userOptimusDir, 'roles'), quiet);
    }

    // 3. Config: MERGE (preserve user values in JSON files)
    const configSrc = path.join(scaffoldDir, 'config');
    if (fs.existsSync(configSrc)) {
      if (!quiet) console.log('\n⚙️  Upgrading system config...');
      configCount = mergeConfigFiles(configSrc, projectConfigDir, {
        skippedNames: ['available-agents.json', 'available-agents.project.sample.json'],
        quiet,
      });
    }

    const userAvailableAgentsPath = getUserAvailableAgentsConfigPath();
    if (fs.existsSync(availableAgentsTemplatePath)) {
      if (!quiet) console.log(`  👤 Syncing user-level available-agents config at ${userAvailableAgentsPath}...`);
      try {
        const syncResult = syncAvailableAgentsConfig(availableAgentsTemplatePath, userAvailableAgentsPath);
        if (!quiet) {
          if (syncResult.created) {
            console.log('  ✅ Installed default user-level available-agents.json');
          } else if (syncResult.overwrittenDueToError) {
            console.log('  🔄 Replaced malformed user-level available-agents.json with the latest template');
          } else if (syncResult.patched) {
            console.log('  🔧 Refreshed user-level engine capabilities from template');
          } else {
            console.log('  ℹ️  Preserved your user-level engine config');
          }
        }
      } catch (e) {
        if (!quiet) console.log('  ⚠️  User-level available-agents sync skipped: ' + (e.message || e));
      }
    }

    if (disableProjectAvailableAgents && fs.existsSync(agentsPath)) {
      const disabled = disableProjectAvailableAgentsOverride(projectConfigDir);
      if (disabled && !quiet) {
        console.log(`  🚫 Disabled project override and preserved it at ${path.relative(projectPath, disabled.disabledPath)}`);
        console.log('  👤 User-level available-agents.json is now authoritative unless you restore a project override later.');
      }
    } else if (disableProjectAvailableAgents && !quiet) {
      console.log('  ℹ️  No active project-level available-agents override found to disable.');
    }

    if (fs.existsSync(agentsPath) && fs.existsSync(availableAgentsTemplatePath)) {
      if (!quiet) console.log(`  🏗️  Preserving active project override at ${path.relative(projectPath, agentsPath)}...`);
      try {
        const syncResult = syncAvailableAgentsConfig(availableAgentsTemplatePath, agentsPath);
        if (!quiet) {
          if (syncResult.overwrittenDueToError) {
            console.log(`  🔄 Updated ${path.relative(projectPath, agentsPath)} (overwritten — parse error)`);
          } else if (syncResult.patched) {
            console.log('  🔧 Patched project engine capability arrays (union with template)');
          } else if (syncResult.preservedUserValues) {
            console.log('  ℹ️  Preserved your existing project-level override');
          } else {
            console.log(`  🔄 Updated ${path.relative(projectPath, agentsPath)}`);
          }
        }
      } catch (e) {
        if (!quiet) console.log('  ⚠️  Project-level available-agents sync skipped: ' + (e.message || e));
      }
    } else if (fs.existsSync(availableAgentsProjectSampleTemplatePath)) {
      copyFileForce(availableAgentsProjectSampleTemplatePath, projectSamplePath);
      if (!quiet) console.log(`  🧪 Refreshed project override sample at ${path.relative(projectPath, projectSamplePath)}`);
    }

    const systemSrc = path.join(scaffoldDir, 'system');
    if (fs.existsSync(systemSrc)) {
      if (!quiet) console.log('\n\u23f0 Upgrading system scheduler config...');
      const destSystem = path.join(optimusDir, 'system');
      if (!fs.existsSync(destSystem)) fs.mkdirSync(destSystem, { recursive: true });

      const crontabSrc = path.join(systemSrc, 'meta-crontab.json');
      const crontabDest = path.join(destSystem, 'meta-crontab.json');
      if (fs.existsSync(crontabSrc) && !fs.existsSync(crontabDest)) {
        fs.copyFileSync(crontabSrc, crontabDest);
        if (!quiet) console.log('  \u2705 Installed default meta-crontab.json');
      } else if (fs.existsSync(crontabDest)) {
        if (!quiet) console.log('  \u23ed\ufe0f  meta-crontab.json preserved (user config)');
      }

      const cronLocksDir = path.join(destSystem, 'cron-locks');
      if (!fs.existsSync(cronLocksDir)) {
        fs.mkdirSync(cronLocksDir, { recursive: true });
        fs.writeFileSync(path.join(cronLocksDir, '.gitkeep'), '');
        if (!quiet) console.log('  \u2705 Created cron-locks directory');
      }
    }

    // 4. Agents: NEVER TOUCH
    if (!quiet) console.log('\n⏭️  Agents preserved (runtime instances)');

    // 5. State/Tasks/Reports/Reviews/Memory: NEVER TOUCH
    if (!quiet) console.log('⏭️  Runtime data preserved');

    // 6. Refresh all dist bundles used by workspace
    const destDistDir = path.join(optimusDir, 'dist');
    if (!fs.existsSync(destDistDir)) {
      fs.mkdirSync(destDistDir, { recursive: true });
    }
    const distBundles = ['mcp-server.js', 'http-runtime.js', 'runtime-cli.js'];
    for (const bundle of distBundles) {
      const srcDistPath = path.resolve(pluginRoot, 'dist', bundle);
      const destDistPath = path.join(destDistDir, bundle);
      if (fs.existsSync(srcDistPath)) {
        fs.copyFileSync(srcDistPath, destDistPath);
        const srcMapPath = srcDistPath + '.map';
        if (fs.existsSync(srcMapPath)) {
          fs.copyFileSync(srcMapPath, destDistPath + '.map');
        }
      }
    }
    // Patch self-reference path in mcp-server.js
    const mcpDestPath = path.join(destDistDir, 'mcp-server.js');
    if (fs.existsSync(mcpDestPath)) {
      let distContent = fs.readFileSync(mcpDestPath, 'utf8');
      const patchedContent = distContent.replace(
        /join\(__dirname,\s*"\.\."\s*,\s*"\.\."\s*,\s*"dist"\s*,\s*"mcp-server\.js"\)/g,
        'join(__dirname, "mcp-server.js")'
      );
      if (patchedContent !== distContent) {
        fs.writeFileSync(mcpDestPath, patchedContent, 'utf8');
      }
    }
    writeClientMcpConfigs(projectPath);
    writeCopilotLaunchers(projectPath);
    const registeredProject = registerProject(projectPath);
    if (!quiet) {
      console.log('\n🔌 Regenerated MCP client configs from .optimus/config/mcp-servers.json');
      console.log('   • VS Code / GitHub Copilot: .vscode/mcp.json');
      console.log('   • GitHub Copilot CLI:       .copilot/mcp-config.json');
      console.log('   • Claude Code:              .mcp.json');
      console.log('   • Copilot launchers:        copilot-optimus.ps1 / .cmd / (POSIX) copilot-optimus');
      console.log(`   • Project registry:         ${getProjectsRegistryPath()} (${registeredProject.name})`);
      console.log('   📍 MCP server:   .optimus/dist/mcp-server.js');
      console.log('   📍 HTTP runtime: .optimus/dist/http-runtime.js');
      console.log('   📍 CLI runtime:  .optimus/dist/runtime-cli.js');
    }

    // 7. Ensure system-instructions references exist in IDE instruction files
    const { injectSystemInstructions } = require('../lib/inject');
    const injectResult = injectSystemInstructions(projectPath);

    if (!quiet) {
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
    }

    return { skillCount, roleCount, configCount, success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = function upgrade(argv = process.argv.slice(3)) {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const pkgPath = path.join(pluginRoot, 'package.json');
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  const singleMode = argv.includes('--single');
  const disableProjectAvailableAgents = argv.includes(DISABLE_PROJECT_AVAILABLE_AGENTS_FLAG);

  if (singleMode) {
    // Legacy: upgrade only cwd
    const cwd = process.cwd();
    console.log(`\n🔄 Upgrading ${cwd} to optimus-swarm v${version}...\n`);
    const result = upgradeProject(cwd, pluginRoot, { disableProjectAvailableAgents });
    if (!result.success) {
      console.error(`❌ Upgrade failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`\n✅ Upgrade complete: ${result.skillCount} skills, ${result.roleCount} roles, ${result.configCount} config files updated.\n`);
  } else {
    // Default: upgrade ALL registered projects + cwd
    const registry = loadProjectRegistry();
    const cwd = process.cwd();

    // Collect unique project paths: registered projects + cwd (if it has .optimus/)
    const projectPaths = new Set(registry.projects.map(p => p.path));
    if (fs.existsSync(path.join(cwd, '.optimus'))) {
      projectPaths.add(path.resolve(cwd));
    }

    if (projectPaths.size === 0) {
      console.error('No Optimus projects found. Run `optimus init` in a project directory first.');
      process.exit(1);
    }

    console.log(`\n🔄 Upgrading ${projectPaths.size} project(s) to optimus-swarm v${version}...\n`);

    const results = [];
    for (const projectPath of projectPaths) {
      const name = path.basename(projectPath);
      process.stdout.write(`📦 ${name} (${projectPath})... `);
      const result = upgradeProject(projectPath, pluginRoot, { quiet: true, disableProjectAvailableAgents });
      if (result.success) {
        console.log(`✅ ${result.skillCount} skills, ${result.roleCount} roles, ${result.configCount} config`);
      } else {
        console.log(`❌ ${result.error}`);
      }
      results.push({ name, path: projectPath, ...result });
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`\n✅ Upgrade complete: ${succeeded}/${results.length} projects upgraded.`);
    if (failed > 0) {
      console.log(`⚠️  ${failed} project(s) failed — check errors above.`);
    }
    console.log(`\nUse --single to upgrade only the current directory.\n`);
  }

  // 8. Ensure claude-agent-acp is installed (ACP is now the default for claude-code engine)
  const { execSync } = require('child_process');
  try {
    execSync('claude-agent-acp --version', { stdio: 'ignore', timeout: 5000 });
  } catch {
    console.log('📦 Installing claude-agent-acp (now default for claude-code engine)...');
    try {
      execSync('npm install -g @zed-industries/claude-agent-acp', { stdio: 'inherit', timeout: 60000 });
      console.log('  ✅ claude-agent-acp installed');
    } catch (e) {
      console.log('  ⚠️  Auto-install failed. Run manually: npm install -g @zed-industries/claude-agent-acp');
    }
  }
};
