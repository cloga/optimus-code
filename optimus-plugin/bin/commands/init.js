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

  console.log('\n🤖 Optimus Swarm — Initializing workspace...\n');

  // 1. Create required subdirectories
  const dirs = ['personas', 'config', 'tasks', 'reports', 'reviews', 'memory', 'state'];
  for (const dir of dirs) {
    const dirPath = path.join(optimusDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`  📁 Created .optimus/${dir}/`);
    }
  }

  // 2. Copy scaffold personas
  const personasSrc = path.join(scaffoldDir, 'personas');
  if (fs.existsSync(personasSrc)) {
    console.log('\n📋 Installing starter personas...');
    copyDirRecursive(personasSrc, path.join(optimusDir, 'personas'));
  }

  // 3. Copy scaffold config
  const configSrc = path.join(scaffoldDir, 'config');
  if (fs.existsSync(configSrc)) {
    console.log('\n⚙️  Installing system config...');
    copyDirRecursive(configSrc, path.join(optimusDir, 'config'));
  }

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

  console.log('\n✅ Workspace initialized! Your .optimus/ directory is ready.');
  console.log('   Run `optimus serve` or configure your MCP client to start.\n');
};
