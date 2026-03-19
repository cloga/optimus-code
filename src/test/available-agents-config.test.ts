import { describe, expect, it } from 'vitest';
import { parseAvailableAgentsConfig } from '../types/AvailableAgentsConfig';

describe('available-agents config schema', () => {
    it('accepts the current auto-protocol shape', () => {
        expect(() => parseAvailableAgentsConfig({
            $schema: './available-agents.schema.json',
            _schema_version: 1,
            engines: {
                'github-copilot': {
                    protocol: 'auto',
                    preferred_protocol: 'acp',
                    available_models: ['gpt-5.4'],
                    automation: { mode: 'auto-approve', continuation: 'autopilot', max_continues: 8 },
                    acp: {
                        path: 'copilot',
                        args: ['--acp', '--stdio'],
                        capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single'] }
                    },
                    cli: {
                        path: 'copilot',
                        cli_flags: '-m',
                        capabilities: { automation_modes: ['interactive', 'auto-approve'], automation_continuations: ['single', 'autopilot'] }
                    }
                }
            }
        })).not.toThrow();
    });

    it('accepts backward-compatible legacy engine declarations without protocol', () => {
        expect(() => parseAvailableAgentsConfig({
            engines: {
                'legacy-claude': {
                    path: 'claude',
                    cli_flags: '--model',
                    available_models: ['claude-opus-4.6-1m'],
                    automation: { mode: 'bypassPermissions' }
                }
            }
        })).not.toThrow();
    });

    it('rejects invalid protocol values with an actionable error', () => {
        expect(() => parseAvailableAgentsConfig({
            engines: {
                broken: {
                    protocol: 'stdio-only',
                    path: 'copilot'
                }
            }
        })).toThrow(/root\.engines\.broken\.protocol must be one of: cli, acp, auto/i);
    });

    it('rejects auto protocol entries that declare no transports', () => {
        expect(() => parseAvailableAgentsConfig({
            engines: {
                broken: {
                    protocol: 'auto',
                    available_models: ['gpt-5.4']
                }
            }
        })).toThrow(/does not declare either 'root\.engines\.broken\.acp' or 'root\.engines\.broken\.cli'/i);
    });
});