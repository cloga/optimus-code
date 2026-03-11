You are a delegated AI Worker operating under the Spartan Swarm Protocol.
Your Role: dev
Identity: T1 (Agent Instance -> dev_5dc5a6a2.md)

--- START PERSONA INSTRUCTIONS ---
# Dev

Core Developer implementing infrastructure code.
--- END PERSONA INSTRUCTIONS ---

Goal: Execute the following task.
System Note: Found local project agent state: C:\Users\lochen\optimus-code\.optimus\agents\dev_5dc5a6a2.md

Task Description:
Implement a build-time fetch of the official Claude skill-creator documentation so it ships with the plugin.

## Goal
During `npm run build` in optimus-plugin/, automatically fetch the latest content from https://claude.com/plugins/skill-creator and save it as a reference guide.

## Implementation Steps

1. **Create a pre-build script** at `optimus-plugin/scripts/fetch-skill-creator-guide.js`:
   - Use Node.js built-in `fetch` (Node 18+) to GET https://claude.com/plugins/skill-creator
   - Extract the meaningful text content (the plugin description about 4 modes: Create, Eval, Improve, Benchmark; the 4 agents: Executor, Grader, Comparator, Analyzer; and usage instructions)
   - Write the extracted content to `optimus-plugin/skills/skill-checker/official-guide.md` with a header noting the fetch date
   - If fetch fails (network error, 403, etc.), print a warning but do NOT fail the build. Keep the existing file if one exists.

2. **Integrate into esbuild.plugin.js**:
   - Before the esbuild.build() call, add: `try { await require('./scripts/fetch-skill-creator-guide.js')(); } catch(e) { console.warn('Skill guide fetch skipped:', e.message); }`

3. **Update skill-checker SKILL.md** (both .optimus/ and optimus-plugin/ copies):
   - In Step 1, change to: "Read the official guide at `.optimus/skills/skill-checker/official-guide.md` for the latest Claude skill-creator methodology (4 modes: Create, Eval, Improve, Benchmark)"
   - Remove the /skill-creator CLI slash command reference since agents can't use slash commands

4. **Test**: Run `cd optimus-plugin && npm run build` and verify:
   - `skills/skill-checker/official-guide.md` is created with fetched content
   - Build completes successfully even if fetch fails
   - The guide file is part of the skills directory that gets copied during `optimus init`

## Rules
- Do NOT modify mcp-server.ts or worker-spawner.ts
- Create a feature branch, commit, push, and create a PR via vcs_create_pr, then merge via vcs_merge_pr
- After merge, git checkout master

=== CONTEXT FILES ===

The following files are provided as required context for, and must be strictly adhered to during this task:

--- START OF .optimus/skills/skill-checker/SKILL.md ---
---
name: skill-checker
description: Validates and ensures new skills comply with Optimus standards — correct paths, valid MCP tool references, proper structure, and error handling.
---

# Skill Checker (Optimus Meta-Skill)

<purpose>
This skill activates when the Master Agent needs to validate a new or updated skill before it is deployed.
It checks file paths, naming conventions, MCP tool accuracy, and structural compliance.
</purpose>

<instructions>

## Step 1: Use the Official Skill Creator

Invoke the official Claude Code `skill-creator` plugin to generate a high-quality skill:
- Use `/skill-creator` in Create mode
- Describe what the skill should teach (e.g., "Create a skill that teaches agents how to run database migrations")
- The plugin will guide you through requirements gathering and generate a well-structured skill file

If the official plugin is not available, write the skill manually following the template in Step 3.

## Step 2: Apply Optimus Registration Rules

Before saving, ensure the generated skill complies with these project-specific rules:

<rules>
  <rule>**File path**: The skill MUST be saved at `.optimus/skills/<skill-name>/SKILL.md`</rule>
  <rule>**Skill name**: Lowercase, hyphenated only. Characters allowed: `[a-z0-9-]`. Example: `data-migration`, `api-testing`</rule>
  <rule>**YAML frontmatter**: Must include `name` and `description` fields</rule>
  <rule>**MCP tool names**: Only reference tools that actually exist. Use `vcs_*` tools (NOT legacy `github_*`). Never hallucinate tool names.</rule>
  <rule>**Error handling**: Every skill that references MCP tools must include error recovery instructions</rule>
  <rule>**No loose files**: Skills must be in their own subdirectory under `.optimus/skills/`</rule>
</rules>

## Step 3: Manual Template (Fallback)

If the official `/skill-creator` plugin is unavailable, use this minimal template:

<template>
---
name: "<skill-name>"
description: "<one-line description>"
---

# <Skill Title>

<purpose>
When and why this skill activates.
</purpose>

<workflow>
### Step 1: <Action>
- **Tool**: `exact_tool_name`
- **Parameters**: `param`: description
- **Action**: What to do

### Step 2: <Action>
...
</workflow>

<error_handling>
- If `tool_name` fails with error X, do Y.
</error_handling>
</template>

## Step 4: Sync to Plugin (Optimus Developers Only)

If you are working on the `optimus-code` repository itself, also copy the new skill to:
- `optimus-plugin/skills/<skill-name>/SKILL.md`

This ensures new users get the skill when they run `optimus init`.

</instructions>

<anti_patterns>
- Do NOT duplicate existing skills — run `ls .optimus/skills/` first
- Do NOT reference MCP tools without verifying they exist
- Do NOT put skill files directly in `.optimus/skills/` — they must be in a named subdirectory
- Do NOT use legacy `github_create_issue` or `github_create_pr` — use `vcs_create_work_item` and `vcs_create_pr`
</anti_patterns>

--- END OF .optimus/skills/skill-checker/SKILL.md ---

--- START OF optimus-plugin/esbuild.plugin.js ---
/**
 * Standalone esbuild config for the Optimus MCP Plugin
 * Compiles src/mcp/mcp-server.ts → optimus-plugin/dist/mcp-server.js
 * 
 * This build is completely independent from the VS Code extension build.
 * It produces a single self-contained CJS bundle with zero vscode dependencies.
 */
const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', 'src', 'mcp', 'mcp-server.ts')],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: path.resolve(__dirname, 'dist', 'mcp-server.js'),
    // CRITICAL: vscode must NEVER be bundled — it should not even be imported
    // If it appears, the build should fail, not silently externalize it.
    // Runtime deps are external — resolved from node_modules at runtime.
    external: [
      '@modelcontextprotocol/sdk',
      '@modelcontextprotocol/sdk/*',
      'dotenv',
      'strip-ansi',
      'iconv-lite',
    ],
    logLevel: 'info',
    metafile: true,
    tsconfig: path.resolve(__dirname, '..', 'tsconfig.json'),
  });

  // Analyze the bundle for any accidental vscode imports
  const inputs = Object.keys(result.metafile.inputs);
  const vscodeDeps = inputs.filter(f => f.includes('vscode') || f.includes('@vscode'));
  if (vscodeDeps.length > 0) {
    console.error('\n🚨 FATAL: VS Code dependencies detected in MCP bundle!');
    console.error('Offending files:', vscodeDeps);
    console.error('The standalone MCP plugin MUST NOT depend on vscode.');
    process.exit(1);
  }

  const outputSize = Object.values(result.metafile.outputs)[0]?.bytes || 0;
  console.log(`\n✅ Plugin build complete (${(outputSize / 1024).toFixed(1)} KB)`);
  if (production) {
    console.log('   Mode: production (minified)');
  }
}

build().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});

--- END OF optimus-plugin/esbuild.plugin.js ---

--- START OF optimus-plugin/bin/commands/init.js ---
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
  const dirs = ['config', 'skills', 'agents', 'tasks', 'reports', 'reviews', 'memory', 'state'];
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

--- END OF optimus-plugin/bin/commands/init.js ---



=== EQUIPPED SKILLS ===
The following skills have been loaded for you to reference and follow:


=== SKILL: git-workflow ===
---
name: git-workflow
description: Standard unified VCS workflow — every code change must go through a branch, PR, and merge for traceability.
---

# Unified VCS Workflow

<purpose>
Every code change must be traceable via a branch and Pull Request. No direct commits to `master`.
</purpose>

<tools_required>
- `vcs_create_work_item`
- `vcs_create_pr`
- `vcs_merge_pr`
- `vcs_add_comment`
- Terminal (for `git` commands)
</tools_required>

<rules>
  <rule>NEVER use the `gh` CLI. Use MCP tools and local `git` only.</rule>
  <rule>NEVER use legacy `github_*` MCP tools. Use `vcs_*` equivalents.</rule>
  <rule>NEVER commit directly to `master` or `main`.</rule>
  <rule>Every change MUST have a PR — this is the traceability guarantee.</rule>
  <rule>ALWAYS switch back to `master` after pushing a feature branch.</rule>
</rules>

<instructions>

<step number="1" name="Identify or Create Tracking Issue">
Ensure there is a corresponding VCS work item. If none exists, create one via `vcs_create_work_item`.
Capture the Issue ID (e.g., `#113`). Do not proceed without one.
</step>

<step number="2" name="Branch, Commit and Push">
Using local terminal commands:
1. `git checkout -b feature/issue-<ID>-<short-description>`
2. Stage and commit: `git commit -m "feat: <description>, fixes #<ID>"`
3. Push: `git push -u origin <branch-name>`
</step>

<step number="3" name="Verify Before PR">
Before creating a PR, you MUST verify your changes:
1. If the project has a build step (e.g., `npm run build`, `dotnet build`), run it and confirm zero errors.
2. If test scripts exist (e.g., `npm test`), run them and confirm all pass.
3. If neither exists, at minimum review the diff (`git diff HEAD~1`) to sanity-check your changes.
Do NOT create a PR with broken builds or failing tests.
</step>

<step number="4" name="Create Pull Request">
Invoke `vcs_create_pr` with `title`, `head`, `base` (master), and `body` containing `Fixes #<ID>`.
</step>

<step number="5" name="Merge Pull Request">
Invoke `vcs_merge_pr` to merge the PR into master. Use `merge_method: "squash"` for clean history.
</step>

<step number="6" name="Workspace Reversion">
Run `git checkout master && git pull` to sync the merged changes locally.
</step>

</instructions>

<error_handling>
- **401/403 Credential Error**: Halt and instruct user to verify `GITHUB_TOKEN` or `ADO_PAT`.
- **Comment Type Error**: `vcs_add_comment` requires `item_type: "workitem"` or `"pullrequest"`.
- **Merge Conflict**: DO NOT force push. Halt and request intervention.
</error_handling>

=== END SKILL: git-workflow ===

=== END SKILLS ===

Please provide your complete execution result below.