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
  registerProject,
  saveProjectRegistry,
  scanForProjects,
  sortProjects,
  touchProject
} = require('../lib/project-registry');
const {
  getClientAdapter,
  resolveCliClient,
  listAvailableClients
} = require('../lib/go-clients');

function parseGoArgs(argv = process.argv.slice(3)) {
  let shouldScan = false;
  let scanRoot;
  let cliOverride;
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

    if (arg === '--cli') {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        cliOverride = next;
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
    cliOverride,
    passthroughArgs,
    projectIdentifier,
    scanRoot,
    shouldScan
  };
}

function renderProject(project, index) {
  const aliasSuffix = project.aliases.length > 0
    ? ` [${project.aliases.join(', ')}]`
    : '';
  const cliSuffix = project.preferredCli ? ` (${project.preferredCli})` : '';
  return `  [${index + 1}] ${project.name}${aliasSuffix}${cliSuffix} — ${project.path}`;
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

function launchClient(project, clientId, passthroughArgs) {
  if (!fs.existsSync(project.path)) {
    throw new Error(`Registered project path does not exist: ${project.path}`);
  }

  if (!fs.existsSync(path.join(project.path, '.optimus'))) {
    throw new Error(`Registered path is not an Optimus workspace: ${project.path}`);
  }

  const adapter = getClientAdapter(clientId);
  const configPath = adapter.resolveConfigPath(project.path);
  if (!configPath) {
    throw new Error(`Missing MCP config for ${adapter.label} in ${project.name}. Run 'optimus upgrade' in ${project.path} first.`);
  }

  const args = adapter.buildArgs(configPath, passthroughArgs);
  console.log(`→ ${project.name} (${project.path}) via ${adapter.label}`);
  const result = spawnSync(adapter.executable, args, {
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

function handleSetCli(argv) {
  const projectIdentifier = argv[0];
  const clientId = argv[1];

  if (!projectIdentifier || !clientId) {
    console.error('Usage: optimus go set-cli <project> <client>');
    console.error(`Available clients: ${listAvailableClients().map(c => c.id).join(', ')}`);
    process.exit(1);
  }

  getClientAdapter(clientId);

  const registry = loadProjectRegistry();
  const matches = findProjectsByIdentifier(projectIdentifier, registry.projects);
  if (matches.length === 0) {
    throw new Error(`Project '${projectIdentifier}' not found.`);
  }
  if (matches.length > 1) {
    throw new Error(`Project '${projectIdentifier}' matched multiple entries: ${matches.map(p => p.name).join(', ')}`);
  }

  registerProject(matches[0].path, { preferredCli: clientId });
  console.log(`✅ Set preferred CLI for ${matches[0].name} to '${clientId}'`);
}

function handleSetDefaultCli(argv) {
  const clientId = argv[0];

  if (!clientId) {
    console.error('Usage: optimus go set-default-cli <client>');
    console.error(`Available clients: ${listAvailableClients().map(c => c.id).join(', ')}`);
    process.exit(1);
  }

  getClientAdapter(clientId);

  const registry = loadProjectRegistry();
  registry.defaults = registry.defaults || {};
  registry.defaults.cli = clientId;
  saveProjectRegistry(registry);
  console.log(`✅ Set global default CLI to '${clientId}'`);
}

module.exports = async function go() {
  const subcommand = process.argv[3];

  if (subcommand === 'set-cli') {
    return handleSetCli(process.argv.slice(4));
  }
  if (subcommand === 'set-default-cli') {
    return handleSetDefaultCli(process.argv.slice(4));
  }

  const { cliOverride, passthroughArgs, projectIdentifier, scanRoot, shouldScan } = parseGoArgs();

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

  const clientId = resolveCliClient(cliOverride, project, registry.defaults);
  touchProject(project.path);
  launchClient(project, clientId, passthroughArgs);
};

module.exports.parseGoArgs = parseGoArgs;
module.exports.resolveProjectSelection = resolveProjectSelection;
