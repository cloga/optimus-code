import { afterEach, describe, expect, it } from 'vitest';
import {
    resolveEngineConfig,
    getBuiltinEngines,
    isRuntimeServerProcess,
    shouldRouteViaRuntimeServer,
    resolveRuntimeProxyTimeoutMs,
} from '../runtime/genericExecutor';

const originalArgv = [...process.argv];
const originalRuntimeServerFlag = process.env.OPTIMUS_RUNTIME_SERVER;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

afterEach(() => {
    process.argv = [...originalArgv];
    if (originalRuntimeServerFlag === undefined) {
        delete process.env.OPTIMUS_RUNTIME_SERVER;
    } else {
        process.env.OPTIMUS_RUNTIME_SERVER = originalRuntimeServerFlag;
    }
    if (originalIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    }
});

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
            expect(config.args).toContain('--stdio');
        });

        it('throws for unknown engine with helpful message', () => {
            expect(() => resolveEngineConfig('unknown-engine')).toThrow(/Unknown engine/);
            expect(() => resolveEngineConfig('unknown-engine')).toThrow(/Available engines/);
        });
    });

    describe('runtime proxy guards', () => {
        it('detects http-runtime.js as a runtime server process', () => {
            process.argv[1] = 'C:/Users/lochen/.optimus/dist/http-runtime.js';
            expect(isRuntimeServerProcess()).toBe(true);
        });

        it('does not route via runtime server from the runtime server process itself', () => {
            process.argv[1] = 'C:/Users/lochen/.optimus/dist/http-runtime.js';
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
            expect(shouldRouteViaRuntimeServer()).toBe(false);
        });

        it('routes via runtime server for non-runtime detached host-agent processes', () => {
            process.argv[1] = 'C:/Users/lochen/optimus-code/.optimus/dist/mcp-server.js';
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
            expect(shouldRouteViaRuntimeServer()).toBe(true);
        });
    });

    describe('resolveRuntimeProxyTimeoutMs', () => {
        it('uses timeoutMs plus grace when an explicit timeout is provided', () => {
            expect(resolveRuntimeProxyTimeoutMs(45_000, 300_000)).toBe(75_000);
        });

        it('falls back to the engine activity timeout plus grace', () => {
            expect(resolveRuntimeProxyTimeoutMs(undefined, 300_000)).toBe(330_000);
        });
    });
});
