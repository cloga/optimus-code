import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfiguredEngineNames, getEngineConfig, isStaticallyValid, loadAvailableAgentsConfig, loadValidEnginesAndModels } from '../mcp/engine-resolver';

const createdPaths = new Set<string>();
const ORIGINAL_USER_CONFIG_PATH = process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;

function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    createdPaths.add(dir);
    return dir;
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath: string, value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
}

function createWorkspace(projectConfig?: unknown): string {
    const workspacePath = createTempDir('available-agents-workspace-');
    const configPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
    if (projectConfig !== undefined) {
        writeJson(configPath, projectConfig);
    }
    return workspacePath;
}

function createHomeDir(userConfig?: unknown): string {
    const homePath = createTempDir('available-agents-home-');
    const configPath = path.join(homePath, '.optimus', 'config', 'available-agents.json');
    if (userConfig !== undefined) {
        writeJson(configPath, userConfig);
    }
    return homePath;
}

afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_USER_CONFIG_PATH === undefined) {
        delete process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;
    } else {
        process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = ORIGINAL_USER_CONFIG_PATH;
    }

    for (const targetPath of createdPaths) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
    createdPaths.clear();
});

describe('available-agents config hierarchy', () => {
    it('loads user config from OPTIMUS_USER_AVAILABLE_AGENTS_PATH when set', () => {
        const workspacePath = createWorkspace();
        const userConfigPath = path.join(createTempDir('available-agents-user-config-'), 'user-available-agents.json');
        writeJson(userConfigPath, {
            engines: {
                'claude-code': {
                    available_models: ['user-model'],
                    acp: { path: 'custom-user-acp' },
                },
            },
        });
        process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = userConfigPath;

        const config = loadAvailableAgentsConfig(workspacePath);

        expect(config?.engines['claude-code']).toMatchObject({
            protocol: 'acp',
            available_models: ['user-model'],
            acp: { path: 'custom-user-acp' },
        });
    });

    it('loads user config from ~/.optimus/config/available-agents.json when no override path is set', () => {
        const workspacePath = createWorkspace();
        const homePath = createHomeDir({
            engines: {
                'claude-code': {
                    available_models: ['home-model'],
                    acp: { path: 'home-user-acp' },
                },
            },
        });
        delete process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;
        vi.spyOn(os, 'homedir').mockReturnValue(homePath);

        const config = getEngineConfig('claude-code', workspacePath);

        expect(config).toMatchObject({
            protocol: 'acp',
            available_models: ['home-model'],
            acp: { path: 'home-user-acp' },
        });
    });

    it('applies precedence project > user > built-in defaults and deep-merges nested objects', () => {
        const workspacePath = createWorkspace({
            engines: {
                'claude-code': {
                    available_models: ['project-model'],
                    automation: { mode: 'plan', max_continues: 2 },
                    acp: {
                        capabilities: {
                            automation_modes: ['auto-approve'],
                        },
                    },
                    timeout: { activity_ms: 222 },
                },
            },
        });
        const userConfigPath = path.join(createTempDir('available-agents-user-merge-'), 'available-agents.json');
        writeJson(userConfigPath, {
            engines: {
                'claude-code': {
                    available_models: ['user-model', 'user-overflow'],
                    automation: { continuation: 'single' },
                    acp: {
                        path: 'user-acp',
                        capabilities: {
                            automation_modes: ['interactive'],
                            automation_continuations: ['single'],
                        },
                    },
                    timeout: { heartbeat_ms: 111 },
                },
            },
        });
        process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = userConfigPath;

        const config = getEngineConfig('claude-code', workspacePath);

        expect(config).toMatchObject({
            protocol: 'acp',
            available_models: ['project-model'],
            automation: {
                mode: 'plan',
                continuation: 'single',
                max_continues: 2,
            },
            acp: {
                path: 'user-acp',
                capabilities: {
                    automation_modes: ['auto-approve'],
                    automation_continuations: ['single'],
                },
            },
            timeout: {
                heartbeat_ms: 111,
                activity_ms: 222,
            },
        });
        expect(config.acp.capabilities.automation_modes).toEqual(['auto-approve']);
        expect(config.acp.capabilities.automation_continuations).toEqual(['single']);
    });

    it('falls back to project config when user config fails validation', () => {
        const workspacePath = createWorkspace({
            engines: {
                'claude-code': {
                    available_models: ['project-model'],
                    acp: { path: 'project-acp' },
                },
            },
        });
        const userConfigPath = path.join(createTempDir('available-agents-user-invalid-'), 'available-agents.json');
        writeJson(userConfigPath, {
            engines: {
                'claude-code': {
                    protocol: 'broken-protocol',
                    available_models: ['user-model'],
                    acp: { path: 'invalid-user-acp' },
                },
            },
        });
        process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = userConfigPath;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const config = getEngineConfig('claude-code', workspacePath);

        expect(config).toMatchObject({
            protocol: 'acp',
            available_models: ['project-model'],
            acp: { path: 'project-acp' },
        });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('failed to read user available-agents.json'));
    });

    it('preserves existing project-only config behavior when no user config is present', () => {
        const workspacePath = createWorkspace({
            engines: {
                'qwen-code': {
                    available_models: ['qwen3-coder'],
                    acp: { path: 'auto', args: ['--acp'] },
                    timeout: { heartbeat_ms: 600000 },
                },
            },
        });
        const emptyHomePath = createHomeDir();
        delete process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;
        vi.spyOn(os, 'homedir').mockReturnValue(emptyHomePath);

        const config = getEngineConfig('qwen-code', workspacePath);
        const configuredEngines = getConfiguredEngineNames(workspacePath);

        expect(config).toMatchObject({
            protocol: 'acp',
            available_models: ['qwen3-coder'],
            acp: { path: 'auto', args: ['--acp'] },
            timeout: { heartbeat_ms: 600000 },
        });
        expect(configuredEngines).toContain('qwen-code');
        expect(configuredEngines).not.toContain('claude-code');
        expect(configuredEngines).not.toContain('github-copilot');
    });

    it('falls back to project config when user config contains malformed JSON', () => {
        const workspacePath = createWorkspace({
            engines: {
                'claude-code': {
                    available_models: ['project-model'],
                    acp: { path: 'project-acp' },
                },
            },
        });
        const userConfigPath = path.join(createTempDir('available-agents-user-malformed-'), 'available-agents.json');
        writeText(userConfigPath, '{ "engines": ');
        process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = userConfigPath;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const config = getEngineConfig('claude-code', workspacePath);

        expect(config).toMatchObject({
            protocol: 'acp',
            available_models: ['project-model'],
            acp: { path: 'project-acp' },
        });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('failed to read user available-agents.json'));
    });

    it('does not fabricate default engines when no user or project config exists', () => {
        const workspacePath = createWorkspace();
        const emptyHomePath = createHomeDir();
        delete process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;
        vi.spyOn(os, 'homedir').mockReturnValue(emptyHomePath);

        expect(loadAvailableAgentsConfig(workspacePath)).toBeNull();
        expect(getConfiguredEngineNames(workspacePath)).toEqual([]);
    });

    it('keeps raw project engines visible to validation when strict project parsing fails', () => {
        const workspacePath = createWorkspace();
        const projectConfigPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
        writeText(projectConfigPath, JSON.stringify({
            engines: {
                'good-engine': {
                    available_models: ['good-model'],
                    acp: { path: 'good-acp' },
                },
                'bad-models': {
                    protocol: 'cli',
                    path: 'copilot',
                    available_models: ['', null, '   '],
                    cli_flags: '-m',
                },
            },
        }, null, 2));
        const emptyHomePath = createHomeDir();
        delete process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;
        vi.spyOn(os, 'homedir').mockReturnValue(emptyHomePath);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { engines, models } = loadValidEnginesAndModels(workspacePath);

        expect(engines).toEqual(expect.arrayContaining(['good-engine', 'bad-models']));
        expect(models['good-engine']).toEqual(['good-model']);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('failed to read project available-agents.json'));
    });

    it('uses raw project fallback for static validation when malformed project config contains mixed entries', () => {
        const workspacePath = createWorkspace();
        const projectConfigPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
        writeText(projectConfigPath, JSON.stringify({
            engines: {
                'good-engine': {
                    available_models: ['good-model'],
                    acp: { path: 'good-acp' },
                },
                'bad-path': {
                    protocol: 'acp',
                    path: '   ',
                    available_models: ['ghost-model'],
                },
            },
        }, null, 2));
        const emptyHomePath = createHomeDir();
        delete process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;
        vi.spyOn(os, 'homedir').mockReturnValue(emptyHomePath);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(isStaticallyValid('good-engine', 'good-model', workspacePath)).toBe(true);
        expect(isStaticallyValid('bad-path', 'ghost-model', workspacePath)).toBe(false);
    });
});
