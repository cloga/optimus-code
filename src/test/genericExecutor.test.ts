import { describe, it, expect } from 'vitest';
import { resolveEngineConfig, getBuiltinEngines } from '../runtime/genericExecutor';

describe('genericExecutor', () => {
    describe('getBuiltinEngines', () => {
        it('returns github-copilot and claude-code', () => {
            const engines = getBuiltinEngines();
            expect(engines).toContain('github-copilot');
            expect(engines).toContain('claude-code');
        });
    });

    describe('resolveEngineConfig', () => {
        it('returns config for github-copilot', () => {
            const config = resolveEngineConfig('github-copilot');
            expect(config.executable).toBe('copilot');
            expect(config.args).toContain('--acp');
            expect(config.activityTimeoutMs).toBeGreaterThan(0);
        });

        it('returns config for claude-code', () => {
            const config = resolveEngineConfig('claude-code');
            expect(config.executable).toBe('claude-agent-acp');
            expect(config.args).toContain('--acp');
        });

        it('throws for unknown engine with helpful message', () => {
            expect(() => resolveEngineConfig('unknown-engine')).toThrow(/Unknown engine/);
            expect(() => resolveEngineConfig('unknown-engine')).toThrow(/Available engines/);
        });
    });
});
