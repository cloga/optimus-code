import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/ClaudeCodeAdapter';
import { GitHubCopilotAdapter } from '../adapters/GitHubCopilotAdapter';
import { PersistentAgentAdapter } from '../adapters/PersistentAgentAdapter';
import { getEngineProtocol, getResolvedEngineTransport, parseRoleSpec, resolveCliAdapterKind } from '../mcp/worker-spawner';
import { getClaudeCliAutomationArgs, normalizeAutomationPolicy } from '../utils/automationPolicy';

function createTempWorkspace(configOverride?: object): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-automation-test-'));
    fs.mkdirSync(path.join(tmp, '.optimus', 'config'), { recursive: true });
    const baseConfig = {
        engines: {
            'claude-code': {
                protocol: 'auto',
                preferred_protocol: 'acp',
                available_models: ['claude-opus-4.6-1m'],
                automation: { mode: 'auto-approve' },
                acp: {
                    path: 'claude-agent-acp',
                    cli_flags: '--model',
                    capabilities: { automation_modes: ['auto-approve'] }
                },
                cli: {
                    path: 'claude',
                    cli_flags: '--model',
                    capabilities: { automation_modes: ['interactive', 'plan', 'accept-edits', 'deny-unapproved', 'auto-approve'] }
                }
            },
            'github-copilot': {
                protocol: 'auto',
                preferred_protocol: 'acp',
                available_models: ['gpt-5.4'],
                automation: { mode: 'auto-approve', continuation: 'autopilot', max_continues: 5 },
                acp: {
                    path: 'copilot',
                    args: ['--acp', '--stdio'],
                    capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single'] }
                },
                cli: {
                    path: 'copilot',
                    cli_flags: '-m',
                    capabilities: {
                        automation_modes: ['interactive', 'plan', 'accept-edits', 'deny-unapproved', 'auto-approve'],
                        automation_continuations: ['single', 'autopilot']
                    }
                }
            }
        }
    };
    fs.writeFileSync(
        path.join(tmp, '.optimus', 'config', 'available-agents.json'),
        JSON.stringify(configOverride || baseConfig, null, 2),
        'utf8'
    );
    return tmp;
}

function cleanup(workspacePath: string): void {
    fs.rmSync(workspacePath, { recursive: true, force: true });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Engine automation integration', () => {
    it('parses config-defined engine suffixes from role specs', () => {
        const workspacePath = createTempWorkspace();
        try {
            expect(parseRoleSpec('security-reviewer_claude-code_claude-opus-4.6-1m', workspacePath)).toEqual({
                role: 'security-reviewer',
                engine: 'claude-code',
                model: 'claude-opus-4.6-1m'
            });
        } finally {
            cleanup(workspacePath);
        }
    });

    it('chooses ACP first for protocol:auto when ACP supports the requested automation mode', () => {
        const workspacePath = createTempWorkspace();
        try {
            expect(getEngineProtocol('claude-code', workspacePath)).toBe('acp');
        } finally {
            cleanup(workspacePath);
        }
    });

    it('falls back to CLI for protocol:auto when ACP lacks the requested automation mode', () => {
        const workspacePath = createTempWorkspace({
            engines: {
                'claude-code': {
                    protocol: 'auto',
                    preferred_protocol: 'acp',
                    available_models: ['claude-opus-4.6-1m'],
                    automation: { mode: 'deny-unapproved' },
                    acp: {
                        path: 'claude-agent-acp',
                        cli_flags: '--model',
                        capabilities: { automation_modes: ['auto-approve'] }
                    },
                    cli: {
                        path: 'claude',
                        cli_flags: '--model',
                        capabilities: { automation_modes: ['interactive', 'plan', 'accept-edits', 'deny-unapproved', 'auto-approve'] }
                    }
                }
            }
        });
        try {
            expect(getEngineProtocol('claude-code', workspacePath)).toBe('cli');
            expect(resolveCliAdapterKind('claude-code', workspacePath)).toBe('claude-code');
        } finally {
            cleanup(workspacePath);
        }
    });

    it('fails fast when no Claude transport can satisfy autopilot continuation', () => {
        const workspacePath = createTempWorkspace({
            engines: {
                'claude-code': {
                    protocol: 'auto',
                    preferred_protocol: 'acp',
                    available_models: ['claude-opus-4.6-1m'],
                    automation: { mode: 'auto-approve', continuation: 'autopilot' },
                    acp: {
                        path: 'claude-agent-acp',
                        cli_flags: '--model',
                        capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single'] }
                    },
                    cli: {
                        path: 'claude',
                        cli_flags: '--model',
                        capabilities: { automation_modes: ['interactive', 'plan', 'accept-edits', 'deny-unapproved', 'auto-approve'], automation_continuations: ['single'] }
                    }
                }
            }
        });
        try {
            expect(() => getEngineProtocol('claude-code', workspacePath)).toThrow(/cannot satisfy mode='auto-approve', continuation='autopilot'/i);
        } finally {
            cleanup(workspacePath);
        }
    });

    it('keeps Copilot autopilot on CLI even when ACP is configured as the preferred protocol', () => {
        const workspacePath = createTempWorkspace();
        try {
            expect(getEngineProtocol('github-copilot', workspacePath)).toBe('cli');
            expect(resolveCliAdapterKind('github-copilot', workspacePath)).toBe('github-copilot');
        } finally {
            cleanup(workspacePath);
        }
    });

    it('chooses Copilot ACP when continuation is single and ACP supports the requested mode', () => {
        const workspacePath = createTempWorkspace({
            engines: {
                'github-copilot': {
                    protocol: 'auto',
                    preferred_protocol: 'acp',
                    available_models: ['gpt-5.4'],
                    automation: { mode: 'auto-approve', continuation: 'single' },
                    acp: {
                        path: 'copilot',
                        args: ['--acp', '--stdio'],
                        capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single'] }
                    },
                    cli: {
                        path: 'copilot',
                        cli_flags: '-m',
                        capabilities: {
                            automation_modes: ['interactive', 'plan', 'accept-edits', 'deny-unapproved', 'auto-approve'],
                            automation_continuations: ['single', 'autopilot']
                        }
                    }
                }
            }
        });
        try {
            expect(getEngineProtocol('github-copilot', workspacePath)).toBe('acp');
            expect(getResolvedEngineTransport('github-copilot', workspacePath)).toEqual({
                protocol: 'acp',
                executable: 'copilot',
                args: ['--acp', '--stdio'],
            });
        } finally {
            cleanup(workspacePath);
        }
    });

    it('uses copilot --acp --stdio when GitHub Copilot is explicitly configured for ACP', () => {
        const workspacePath = createTempWorkspace({
            engines: {
                'github-copilot': {
                    protocol: 'acp',
                    path: 'copilot',
                    args: ['--acp', '--stdio'],
                    available_models: ['gpt-5.4'],
                    automation: { mode: 'auto-approve', continuation: 'single' }
                }
            }
        });
        try {
            expect(getEngineProtocol('github-copilot', workspacePath)).toBe('acp');
            expect(getResolvedEngineTransport('github-copilot', workspacePath)).toEqual({
                protocol: 'acp',
                executable: 'copilot',
                args: ['--acp', '--stdio'],
            });
        } finally {
            cleanup(workspacePath);
        }
    });

    it('fails fast when Copilot ACP is explicitly configured with autopilot continuation', () => {
        const workspacePath = createTempWorkspace({
            engines: {
                'github-copilot': {
                    protocol: 'acp',
                    path: 'copilot',
                    args: ['--acp', '--stdio'],
                    available_models: ['gpt-5.4'],
                    automation: { mode: 'auto-approve', continuation: 'autopilot' },
                    capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single'] }
                }
            }
        });
        try {
            expect(() => getEngineProtocol('github-copilot', workspacePath)).toThrow(/protocol 'acp' cannot satisfy mode='auto-approve', continuation='autopilot'/i);
        } finally {
            cleanup(workspacePath);
        }
    });

    it('defaults Copilot ACP transport to stdio when config only declares the executable path', () => {
        const workspacePath = createTempWorkspace({
            engines: {
                'github-copilot': {
                    protocol: 'acp',
                    path: 'copilot',
                    available_models: ['gpt-5.4'],
                    automation: { mode: 'auto-approve', continuation: 'single' }
                }
            }
        });
        try {
            expect(getResolvedEngineTransport('github-copilot', workspacePath)).toEqual({
                protocol: 'acp',
                executable: 'copilot',
                args: ['--acp', '--stdio'],
            });
        } finally {
            cleanup(workspacePath);
        }
    });

    it('warns when Copilot ACP relies on implicit stdio defaults from config validation', () => {
        const workspacePath = createTempWorkspace({
            engines: {
                'github-copilot': {
                    protocol: 'acp',
                    path: 'copilot',
                    available_models: ['gpt-5.4'],
                    automation: { mode: 'auto-approve', continuation: 'single' }
                }
            }
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(getResolvedEngineTransport('github-copilot', workspacePath)).toEqual({
                protocol: 'acp',
                executable: 'copilot',
                args: ['--acp', '--stdio'],
            });
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Optimus will default to '--acp --stdio'"));
        } finally {
            cleanup(workspacePath);
        }
    });

    it('adds native autopilot flags to GitHub Copilot agent mode when enabled', () => {
        const workspacePath = createTempWorkspace();
        try {
            PersistentAgentAdapter.setWorkspacePathHint(workspacePath);
            const adapter = new GitHubCopilotAdapter('github-copilot', 'GitHub Copilot', 'gpt-5.4', undefined, {
                autoApprove: true,
                autopilot: true,
                maxAutopilotContinues: 5,
            });
            const spawn = (adapter as any).getSpawnCommand('agent');
            expect(spawn.args).toContain('--allow-all');
            expect(spawn.args).toContain('--no-ask-user');
            expect(spawn.args).toContain('--autopilot');
            expect(spawn.args).toContain('--max-autopilot-continues');
            expect(spawn.args).toContain('5');
        } finally {
            cleanup(workspacePath);
        }
    });

    it('maps normalized Claude auto-approve autonomy to bypassPermissions flags', () => {
        const workspacePath = createTempWorkspace();
        try {
            PersistentAgentAdapter.setWorkspacePathHint(workspacePath);
            const adapter = new ClaudeCodeAdapter('claude-code', 'Claude Code', 'claude-opus-4.6-1m', undefined, {
                permissionMode: 'bypassPermissions',
            });
            const spawn = (adapter as any).getSpawnCommand('agent');
            expect(spawn.args).toContain('--allow-dangerously-skip-permissions');
            expect(spawn.args).toContain('--permission-mode');
            expect(spawn.args).toContain('bypassPermissions');
        } finally {
            cleanup(workspacePath);
        }
    });

    it('keeps legacy automation aliases readable while normalizing intent', () => {
        expect(normalizeAutomationPolicy({ mode: 'dontAsk' })).toEqual({
            mode: 'deny-unapproved',
            continuation: 'single',
            maxContinues: undefined,
        });
        expect(normalizeAutomationPolicy({ mode: 'bypassPermissions' })).toEqual({
            mode: 'auto-approve',
            continuation: 'single',
            maxContinues: undefined,
        });
        expect(normalizeAutomationPolicy({ mode: 'autopilot', max_continues: 3 })).toEqual({
            mode: 'auto-approve',
            continuation: 'autopilot',
            maxContinues: 3,
        });
    });

    it('maps deny-unapproved intent to Claude dontAsk permission mode', () => {
        expect(getClaudeCliAutomationArgs('agent', { mode: 'deny-unapproved' })).toEqual([
            '--permission-mode',
            'dontAsk',
        ]);
    });
});