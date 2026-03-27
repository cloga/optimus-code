import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const registryModule = require('../../optimus-plugin/bin/lib/project-registry.js');
const goModule = require('../../optimus-plugin/bin/commands/go.js');
const clientsModule = require('../../optimus-plugin/bin/lib/go-clients.js');

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

  it('preserves preferredCli on re-registration', () => {
    const registryRoot = makeTempDir('optimus-go-cli-pref-');
    process.env.OPTIMUS_PROJECTS_REGISTRY_PATH = path.join(registryRoot, 'projects.json');

    const projectPath = path.join(registryRoot, 'MyProject');
    fs.mkdirSync(path.join(projectPath, '.optimus'), { recursive: true });

    registryModule.registerProject(projectPath, { preferredCli: 'claude' });
    registryModule.registerProject(projectPath);

    const registry = registryModule.loadProjectRegistry();
    expect(registry.projects[0].preferredCli).toBe('claude');
  });

  it('stores and loads registry defaults', () => {
    const registryRoot = makeTempDir('optimus-go-defaults-');
    process.env.OPTIMUS_PROJECTS_REGISTRY_PATH = path.join(registryRoot, 'projects.json');

    const registry = registryModule.loadProjectRegistry();
    registry.defaults = { cli: 'claude' };
    registryModule.saveProjectRegistry(registry);

    const reloaded = registryModule.loadProjectRegistry();
    expect(reloaded.defaults).toEqual({ cli: 'claude' });
  });
});

describe('optimus go helpers', () => {
  it('parses --cli, --scan, project, and passthrough arguments', () => {
    expect(goModule.parseGoArgs(['--scan', 'C:\\Workspace', '--cli', 'claude', 'FR', '--continue'])).toEqual({
      cliOverride: 'claude',
      passthroughArgs: ['--continue'],
      projectIdentifier: 'FR',
      scanRoot: 'C:\\Workspace',
      shouldScan: true
    });
  });

  it('defaults cliOverride to undefined when --cli is not specified', () => {
    const parsed = goModule.parseGoArgs(['FR', '--resume']);
    expect(parsed.cliOverride).toBeUndefined();
    expect(parsed.projectIdentifier).toBe('FR');
    expect(parsed.passthroughArgs).toEqual(['--resume']);
  });
});

describe('client adapter layer', () => {
  it('resolves CLI with correct precedence: override > project > global > default', () => {
    expect(clientsModule.resolveCliClient('claude', { preferredCli: 'copilot' }, { cli: 'copilot' })).toBe('claude');
    expect(clientsModule.resolveCliClient(undefined, { preferredCli: 'claude' }, { cli: 'copilot' })).toBe('claude');
    expect(clientsModule.resolveCliClient(undefined, {}, { cli: 'claude' })).toBe('claude');
    expect(clientsModule.resolveCliClient(undefined, {}, {})).toBe('copilot');
    expect(clientsModule.resolveCliClient(undefined, undefined, undefined)).toBe('copilot');
  });

  it('copilot adapter builds correct args with @-prefixed config path', () => {
    const adapter = clientsModule.getClientAdapter('copilot');
    const args = adapter.buildArgs('/path/to/config.json', ['--continue']);
    expect(args).toEqual(['--additional-mcp-config', '@/path/to/config.json', '--continue']);
  });

  it('claude adapter builds correct args with --mcp-config', () => {
    const adapter = clientsModule.getClientAdapter('claude');
    const args = adapter.buildArgs('/path/to/.mcp.json', ['--resume']);
    expect(args).toEqual(['--mcp-config', '/path/to/.mcp.json', '--resume']);
  });

  it('copilot adapter resolves .copilot/mcp-config.json', () => {
    const projectRoot = makeTempDir('optimus-go-copilot-adapter-');
    const copilotConfig = path.join(projectRoot, '.copilot', 'mcp-config.json');
    fs.mkdirSync(path.dirname(copilotConfig), { recursive: true });
    fs.writeFileSync(copilotConfig, '{}', 'utf8');

    const adapter = clientsModule.getClientAdapter('copilot');
    expect(adapter.resolveConfigPath(projectRoot)).toBe(copilotConfig);
  });

  it('claude adapter resolves .mcp.json', () => {
    const projectRoot = makeTempDir('optimus-go-claude-adapter-');
    const claudeConfig = path.join(projectRoot, '.mcp.json');
    fs.writeFileSync(claudeConfig, '{}', 'utf8');

    const adapter = clientsModule.getClientAdapter('claude');
    expect(adapter.resolveConfigPath(projectRoot)).toBe(claudeConfig);
  });

  it('throws on unknown client ID', () => {
    expect(() => clientsModule.getClientAdapter('unknown')).toThrow(/Unknown CLI client/);
  });

  it('lists available clients', () => {
    const clients = clientsModule.listAvailableClients();
    expect(clients.map((c: { id: string }) => c.id).sort()).toEqual(['claude', 'copilot']);
  });
});
