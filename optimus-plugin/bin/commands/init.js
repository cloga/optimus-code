#!/usr/bin/env node

/**
 * `optimus init` — Bootstrap a .optimus/ workspace in the current directory.
 * 
 * Copies starter personas, config, and creates required subdirectories.
 * Appends .optimus ignore entries to .gitignore if not already present.
 */

const fs = require('fs');
const path = require('path');
const { writeClientMcpConfigs } = require('../lib/mcp-config');

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
  const dirs = ['config', 'skills', 'agents', 'tasks', 'reports', 'reviews', 'memory', 'memory/roles', 'state', 'system', 'specs', 'results'];
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

  // 2.0.1 Auto-fill vcs.json owner/repo from git remote
  const vcsConfigPath = path.join(optimusDir, 'config', 'vcs.json');
  if (fs.existsSync(vcsConfigPath)) {
    try {
      const { execSync } = require('child_process');
      const vcsConfig = JSON.parse(fs.readFileSync(vcsConfigPath, 'utf8'));
      if (vcsConfig.github && (!vcsConfig.github.owner || !vcsConfig.github.repo)) {
        try {
          const remote = execSync('git remote get-url origin', { encoding: 'utf8', timeout: 5000, cwd }).trim();
          const repoMatch = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
          if (repoMatch) {
            vcsConfig.github.owner = repoMatch[1];
            vcsConfig.github.repo = repoMatch[2];
            fs.writeFileSync(vcsConfigPath, JSON.stringify(vcsConfig, null, 2), 'utf8');
            console.log(`  🔗 Auto-detected GitHub repo: ${repoMatch[1]}/${repoMatch[2]}`);
          }
        } catch { /* not a git repo or no remote — leave empty */ }
      }
    } catch { /* parse error — skip */ }
  }


  // 2.1 Copy scaffold system config (meta-crontab, cron-locks)
  const systemSrc = path.join(scaffoldDir, 'system');
  if (fs.existsSync(systemSrc)) {
    console.log('\n\u23f0 Installing system scheduler config...');
    copyDirRecursive(systemSrc, path.join(optimusDir, 'system'));
  }

  // 2.2 Auto-create Health Log issue if GITHUB_TOKEN available and health_log_issue is null
  const crontabPath = path.join(optimusDir, 'system', 'meta-crontab.json');
  if (fs.existsSync(crontabPath)) {
    try {
      const crontab = JSON.parse(fs.readFileSync(crontabPath, 'utf8'));
      if (!crontab.health_log_issue) {
        // Try loading token from .env
        const envPath = path.join(cwd, '.env');
        let ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        if (!ghToken && fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf8');
          const match = envContent.match(/^GITHUB_TOKEN=(.+)$/m);
          if (match) ghToken = match[1].trim();
        }
        // Try detecting repo from git remote
        if (ghToken) {
          try {
            const { execSync } = require('child_process');
            const remote = execSync('git remote get-url origin', { encoding: 'utf8', timeout: 5000 }).trim();
            const repoMatch = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
            if (repoMatch) {
              const [, owner, repo] = repoMatch;
              console.log(`\n🏥 Creating Health Log issue on ${owner}/${repo}...`);
              const res = execSync(`node -e "${[
                `const f=require('node:https');`,
                `const data=JSON.stringify({title:'[Optimus] System Health Log — Automated Patrol Reports',body:'Permanent log for patrol reports. Each hourly patrol appends a summary comment here.',labels:['optimus-bot','system-maintained']});`,
                `const req=f.request({hostname:'api.github.com',path:'/repos/${owner}/${repo}/issues',method:'POST',headers:{'Authorization':'Bearer '+process.env.T,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json','User-Agent':'Optimus-Agent','Content-Length':Buffer.byteLength(data)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{const j=JSON.parse(b);console.log(j.number||'ERR:'+b.slice(0,200))}catch{console.log('ERR:'+b.slice(0,200))}})});`,
                `req.write(data);req.end();`
              ].join('')}"`, { encoding: 'utf8', timeout: 15000, env: { ...process.env, T: ghToken } }).trim();
              const issueNum = parseInt(res);
              if (issueNum > 0) {
                crontab.health_log_issue = issueNum;
                fs.writeFileSync(crontabPath, JSON.stringify(crontab, null, 2), 'utf8');
                console.log(`  ✅ Health Log issue #${issueNum} created and linked in meta-crontab.json`);
              } else {
                console.log(`  ⚠️  Could not create Health Log issue: ${res.slice(0, 100)}`);
              }
            }
          } catch (e) {
            console.log(`  ⚠️  Skipped Health Log issue creation: ${e.message}`);
          }
        } else {
          console.log('\n💡 Set GITHUB_TOKEN in .env to enable automatic Health Log issue creation');
        }
      }
    } catch { /* ignore parse errors */ }
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

  // 3.5 Copy the MCP server bundle into the workspace for all local clients
  // Copy mcp-server dist files to workspace .optimus/dist/
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
  console.log('\n🔌 Generated MCP client configs from .optimus/config/mcp-servers.json');
  console.log('   • VS Code / GitHub Copilot: .vscode/mcp.json');
  console.log('   • GitHub Copilot CLI:       .copilot/mcp-config.json');
  console.log('   • Claude Code:              .mcp.json');
  console.log('   📍 MCP server path: .optimus/dist/mcp-server.js');
  console.log('   💡 Edit .optimus/config/mcp-servers.json to keep all client configs in sync.');

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

  // 6. Auto-install claude-agent-acp if not already available
  const { execSync } = require('child_process');
  try {
    execSync('claude-agent-acp --version', { stdio: 'ignore', timeout: 5000 });
    console.log('\n🔗 claude-agent-acp already installed (ACP engine ready)');
  } catch {
    console.log('\n📦 Installing claude-agent-acp (ACP protocol bridge for Claude Code)...');
    try {
      execSync('npm install -g @zed-industries/claude-agent-acp', { stdio: 'inherit', timeout: 60000 });
      console.log('  ✅ claude-agent-acp installed successfully');
    } catch (e) {
      console.log('  ⚠️  Failed to install claude-agent-acp:', e.message);
      console.log('  💡 Install manually: npm install -g @zed-industries/claude-agent-acp');
    }
  }

  // 7. Initialize User Memory (cross-project, opt-in)
  const os = require('os');
  const userMemDir = path.join(os.homedir(), '.optimus', 'memory');
  const userMemFile = path.join(userMemDir, 'user-memory.md');
  if (!fs.existsSync(userMemFile)) {
    if (!fs.existsSync(userMemDir)) fs.mkdirSync(userMemDir, { recursive: true });
    const template = `# User Memory — managed by Optimus
# Last updated: ${new Date().toISOString().slice(0, 10)}
# Entries: 0
#
# Edit this file directly or use 'optimus memory' commands.
# Agents read this across all projects to personalize their behavior.

## Preferences

## Toolchain

## Lessons
`;
    fs.writeFileSync(userMemFile, template, 'utf8');
    console.log('\n🧠 Initialized User Memory at ~/.optimus/memory/user-memory.md');
    console.log('   💡 Add your preferences: edit the file or tell your AI assistant');
  } else {
    console.log('\n🧠 User Memory already exists (~/.optimus/memory/user-memory.md)');
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
