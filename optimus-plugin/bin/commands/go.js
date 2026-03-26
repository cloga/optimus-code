#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const {
  findProjectsByIdentifier,
  getProjectsRegistryPath,
  loadProjectRegistry,
  scanForProjects,
  sortProjects,
  touchProject
} = require('../lib/project-registry');

function parseGoArgs(argv = process.argv.slice(3)) {
  let shouldScan = false;
  let scanRoot;
  let projectIdentifier;
  const passthroughArgs = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--scan') {
      shouldScan = true;
      const next = argv[index + 1];
      if (next && !next.startsWith('-') && !projectIdentifier) {
        scanRoot = next;
        index++;
      }
      continue;
    }

    if (!projectIdentifier && !arg.startsWith('-')) {
      projectIdentifier = arg;
      continue;
    }

    passthroughArgs.push(arg);
  }

  return {
    passthroughArgs,
    projectIdentifier,
    scanRoot,
    shouldScan
  };
}

function getProjectMcpConfigPath(projectPath) {
  const copilotConfig = path.join(projectPath, '.copilot', 'mcp-config.json');
  if (fs.existsSync(copilotConfig)) {
    return copilotConfig;
  }

  const claudeConfig = path.join(projectPath, '.mcp.json');
  if (fs.existsSync(claudeConfig)) {
    return claudeConfig;
  }

  return undefined;
}

function buildCopilotArgs(configPath, passthroughArgs) {
  const args = [];
  if (configPath) {
    args.push('--additional-mcp-config', `@${configPath}`);
  }

  return args.concat(passthroughArgs);
}

function renderProject(project, index) {
  const aliasSuffix = project.aliases.length > 0
    ? ` [${project.aliases.join(', ')}]`
    : '';
  return `  [${index + 1}] ${project.name}${aliasSuffix} — ${project.path}`;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function resolveProjectSelection(identifier, projects) {
  if (!identifier) {
    return { project: undefined };
  }

  if (/^\d+$/.test(identifier)) {
    const index = parseInt(identifier, 10) - 1;
    if (index >= 0 && index < projects.length) {
      return { project: projects[index] };
    }

    return { error: `Project index '${identifier}' is out of range.` };
  }

  const matches = findProjectsByIdentifier(identifier, projects);
  if (matches.length === 1) {
    return { project: matches[0] };
  }

  if (matches.length > 1) {
    return {
      error: `Project '${identifier}' matched multiple entries: ${matches.map(project => project.name).join(', ')}`
    };
  }

  return {
    error: `Project '${identifier}' not found. Registered projects: ${projects.map(project => project.name).join(', ')}`
  };
}

function launchCopilot(project, passthroughArgs) {
  if (!fs.existsSync(project.path)) {
    throw new Error(`Registered project path does not exist: ${project.path}`);
  }

  if (!fs.existsSync(path.join(project.path, '.optimus'))) {
    throw new Error(`Registered path is not an Optimus workspace: ${project.path}`);
  }

  const configPath = getProjectMcpConfigPath(project.path);
  if (!configPath) {
    throw new Error(`Missing Copilot MCP config for ${project.name}. Run 'optimus upgrade' in ${project.path} first.`);
  }

  const args = buildCopilotArgs(configPath, passthroughArgs);
  const result = spawnSync('copilot', args, {
    cwd: project.path,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

async function selectProjectInteractively(projects) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive project selection requires a TTY. Pass a project name or alias explicitly.');
  }

  console.log('Available Optimus projects:');
  projects.forEach((project, index) => {
    console.log(renderProject(project, index));
  });
  console.log('');

  const selection = await prompt('Select project (number, name, or alias): ');
  if (!selection) {
    throw new Error('No project selected.');
  }

  const resolved = resolveProjectSelection(selection, projects);
  if (resolved.error) {
    throw new Error(resolved.error);
  }

  return resolved.project;
}

module.exports = async function go() {
  const { passthroughArgs, projectIdentifier, scanRoot, shouldScan } = parseGoArgs();

  if (shouldScan) {
    const discovered = scanForProjects(scanRoot || os.homedir());
    console.log(`Registered ${discovered.length} Optimus project(s) from scan root ${scanRoot || os.homedir()}`);
    discovered.forEach((project, index) => {
      console.log(renderProject(project, index));
    });

    if (!projectIdentifier) {
      return;
    }
  }

  const registry = loadProjectRegistry();
  const projects = sortProjects(registry.projects);
  if (projects.length === 0) {
    throw new Error(`No Optimus projects are registered yet. Run 'optimus init' or 'optimus upgrade' inside a project, or use 'optimus go --scan'. Registry path: ${getProjectsRegistryPath()}`);
  }

  const resolved = resolveProjectSelection(projectIdentifier, projects);
  let project = resolved.project;

  if (!projectIdentifier) {
    project = await selectProjectInteractively(projects);
  } else if (resolved.error) {
    throw new Error(resolved.error);
  }

  touchProject(project.path);
  launchCopilot(project, passthroughArgs);
};

module.exports.buildCopilotArgs = buildCopilotArgs;
module.exports.getProjectMcpConfigPath = getProjectMcpConfigPath;
module.exports.parseGoArgs = parseGoArgs;
module.exports.resolveProjectSelection = resolveProjectSelection;
