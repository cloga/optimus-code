import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    getUserAvailableAgentsConfigPath,
    syncAvailableAgentsConfig,
} = require('../../optimus-plugin/bin/lib/available-agents-config');

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

describe('available-agents scaffolding helpers', () => {
    it('resolves the user-level config path from OPTIMUS_USER_AVAILABLE_AGENTS_PATH when set', () => {
        process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = 'C:\\custom\\available-agents.json';
        expect(getUserAvailableAgentsConfigPath()).toBe('C:\\custom\\available-agents.json');
    });

    it('installs the template when the destination config is missing', () => {
        const tempDir = createTempDir('available-agents-sync-');
        const templatePath = path.join(tempDir, 'template.json');
        const destPath = path.join(tempDir, 'user', 'available-agents.json');
        writeJson(templatePath, {
            engines: {
                'claude-code': {
                    available_models: ['template-model'],
                },
            },
        });

        const result = syncAvailableAgentsConfig(templatePath, destPath);

        expect(result).toMatchObject({
            created: true,
            overwrittenDueToError: false,
            patched: false,
        });
        expect(JSON.parse(fs.readFileSync(destPath, 'utf8'))).toEqual({
            engines: {
                'claude-code': {
                    available_models: ['template-model'],
                },
            },
        });
    });

    it('preserves user values while backfilling template capability updates', () => {
        const tempDir = createTempDir('available-agents-merge-');
        const templatePath = path.join(tempDir, 'template.json');
        const destPath = path.join(tempDir, 'project', 'available-agents.json');
        writeJson(templatePath, {
            engines: {
                'github-copilot': {
                    protocol: 'auto',
                    preferred_protocol: 'acp',
                    available_models: ['gpt-5.4'],
                    cli: {
                        path: 'copilot',
                        capabilities: {
                            automation_modes: ['interactive'],
                            automation_continuations: ['single'],
                        },
                    },
                },
            },
        });
        writeJson(destPath, {
            engines: {
                'github-copilot': {
                    protocol: 'acp',
                    available_models: ['custom-model'],
                    acp: {
                        path: 'copilot',
                        args: ['--acp', '--stdio'],
                    },
                    cli: {
                        path: 'copilot-custom-cli',
                        capabilities: {
                            automation_modes: ['interactive'],
                            automation_continuations: ['single'],
                        },
                    },
                },
            },
        });

        const result = syncAvailableAgentsConfig(templatePath, destPath);
        const synced = JSON.parse(fs.readFileSync(destPath, 'utf8'));

        expect(result).toMatchObject({
            created: false,
            overwrittenDueToError: false,
            preservedUserValues: true,
            patched: true,
        });
        expect(synced.engines['github-copilot']).toMatchObject({
            protocol: 'auto',
            preferred_protocol: 'acp',
            available_models: ['custom-model'],
            cli: {
                path: 'copilot-custom-cli',
                capabilities: {
                    automation_modes: ['interactive'],
                    automation_continuations: ['single'],
                },
            },
        });
    });

    it('replaces malformed configs with the latest template during sync', () => {
        const tempDir = createTempDir('available-agents-malformed-');
        const templatePath = path.join(tempDir, 'template.json');
        const destPath = path.join(tempDir, 'project', 'available-agents.json');
        writeJson(templatePath, {
            engines: {
                'claude-code': {
                    available_models: ['template-model'],
                },
            },
        });
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, '{ "engines": ', 'utf8');

        const result = syncAvailableAgentsConfig(templatePath, destPath);

        expect(result).toMatchObject({
            created: false,
            overwrittenDueToError: true,
            patched: false,
        });
        expect(JSON.parse(fs.readFileSync(destPath, 'utf8'))).toEqual({
            engines: {
                'claude-code': {
                    available_models: ['template-model'],
                },
            },
        });
    });
});
