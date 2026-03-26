import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const registryModule = require('../../optimus-plugin/bin/lib/project-registry.js');
const goModule = require('../../optimus-plugin/bin/commands/go.js');

const tempDirs: string[] = [];
const originalRegistryPath = process.env.OPTIMUS_PROJECTS_REGISTRY_PATH;

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalRegistryPath === undefined) {
    delete process.env.OPTIMUS_PROJECTS_REGISTRY_PATH;
  } else {
    process.env.OPTIMUS_PROJECTS_REGISTRY_PATH = originalRegistryPath;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('project registry helpers', () => {
  it('registers projects and preserves aliases on re-registration', () => {
    const registryRoot = makeTempDir('optimus-go-registry-');
    process.env.OPTIMUS_PROJECTS_REGISTRY_PATH = path.join(registryRoot, 'projects.json');

    const projectPath = path.join(registryRoot, 'FlightReview');
    fs.mkdirSync(path.join(projectPath, '.optimus'), { recursive: true });

    registryModule.registerProject(projectPath, { aliases: ['FR'] });
    registryModule.registerProject(projectPath);

    const registry = registryModule.loadProjectRegistry();
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]).toMatchObject({
      aliases: ['FR'],
      name: 'FlightReview',
      path: path.resolve(projectPath)
    });
  });

  it('scans the root and direct child folders for Optimus projects', () => {
    const registryRoot = makeTempDir('optimus-go-scan-');
    process.env.OPTIMUS_PROJECTS_REGISTRY_PATH = path.join(registryRoot, 'projects.json');

    const rootProject = path.join(registryRoot, '.');
    fs.mkdirSync(path.join(rootProject, '.optimus'), { recursive: true });

    const childProject = path.join(registryRoot, 'SydneyEvaluation');
    fs.mkdirSync(path.join(childProject, '.optimus'), { recursive: true });
    fs.mkdirSync(path.join(registryRoot, 'not-a-project'), { recursive: true });

    const scanned = registryModule.scanForProjects(registryRoot);
    expect(scanned.map((project: { name: string }) => project.name).sort()).toEqual(['SydneyEvaluation', path.basename(path.resolve(rootProject))].sort());
  });
});

describe('optimus go helpers', () => {
  it('parses scan, project, and passthrough arguments', () => {
    expect(goModule.parseGoArgs(['--scan', 'C:\\Workspace', 'FR', '--continue'])).toEqual({
      passthroughArgs: ['--continue'],
      projectIdentifier: 'FR',
      scanRoot: 'C:\\Workspace',
      shouldScan: true
    });
  });

  it('prefers .copilot mcp config and forwards remaining copilot args', () => {
    const projectRoot = makeTempDir('optimus-go-project-');
    const copilotConfig = path.join(projectRoot, '.copilot', 'mcp-config.json');
    fs.mkdirSync(path.dirname(copilotConfig), { recursive: true });
    fs.writeFileSync(copilotConfig, '{}', 'utf8');
    fs.writeFileSync(path.join(projectRoot, '.mcp.json'), '{}', 'utf8');

    expect(goModule.getProjectMcpConfigPath(projectRoot)).toBe(copilotConfig);
    expect(goModule.buildCopilotArgs(copilotConfig, ['--continue'])).toEqual([
      '--additional-mcp-config',
      `@${copilotConfig}`,
      '--continue'
    ]);
  });
});
