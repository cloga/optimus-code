import { afterEach, describe, expect, it } from 'vitest';
import {
    resolveEngineConfig,
    getBuiltinEngines,
    isRuntimeServerProcess,
    shouldRouteViaRuntimeServer,
    resolveRuntimeProxyTimeoutMs,
    getRuntimeServerBootstrapCandidates,
    isRuntimeServerHealthyPayload,
    getRuntimeStartupLogPath,
    getRuntimeStartupStderrSummary,
    buildRuntimeStartupFailureLog,
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

        it('resolves bootstrap candidates from the workspace root instead of a nested cwd', () => {
            const nestedWorkspace = 'C:\\Users\\lochen\\optimus-code\\src\\runtime';
            const candidates = getRuntimeServerBootstrapCandidates(nestedWorkspace, {
                ...process.env,
                USERPROFILE: 'C:\\Users\\lochen',
                HOME: 'C:\\Users\\lochen',
            });
            expect(candidates).toContain('C:\\Users\\lochen\\optimus-code\\.optimus\\dist\\http-runtime.js');
            expect(candidates).not.toContain('C:\\Users\\lochen\\optimus-code\\src\\runtime\\.optimus\\dist\\http-runtime.js');
        });

        it('prefers colocated and workspace runtimes before the user-level runtime', () => {
            const workspace = 'C:\\Users\\lochen\\optimus-code';
            const userRuntime = 'C:\\Users\\lochen\\.optimus\\dist\\http-runtime.js';
            const workspaceRuntime = 'C:\\Users\\lochen\\optimus-code\\.optimus\\dist\\http-runtime.js';
            const pluginRuntime = 'C:\\Users\\lochen\\optimus-code\\optimus-plugin\\dist\\http-runtime.js';
            const candidates = getRuntimeServerBootstrapCandidates(workspace, {
                ...process.env,
                USERPROFILE: 'C:\\Users\\lochen',
                HOME: 'C:\\Users\\lochen',
            });

            expect(candidates[0]).toMatch(/runtime[\\/]http-runtime\.js$/);
            expect(candidates.indexOf(workspaceRuntime)).toBeGreaterThan(0);
            expect(candidates.indexOf(pluginRuntime)).toBeGreaterThan(0);
            expect(candidates.indexOf(userRuntime)).toBeGreaterThan(candidates.indexOf(workspaceRuntime));
            expect(candidates.indexOf(userRuntime)).toBeGreaterThan(candidates.indexOf(pluginRuntime));
        });
    });

    describe('runtime health readiness', () => {
        it('accepts the expected runtime v2 health payload', () => {
            expect(isRuntimeServerHealthyPayload({
                status: 'ok',
                engines: ['github-copilot'],
                uptime_ms: 1234,
            })).toBe(true);
        });

        it('rejects unrelated 200 responses as not-ready', () => {
            expect(isRuntimeServerHealthyPayload({ status: 'ok' })).toBe(false);
            expect(isRuntimeServerHealthyPayload({ status: 'ok', engines: 'github-copilot', uptime_ms: 1234 })).toBe(false);
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

    describe('runtime startup diagnostics', () => {
        it('places startup failure logs under the workspace .optimus logs directory', () => {
            const logPath = getRuntimeStartupLogPath(
                'C:\\Users\\lochen\\optimus-code',
                new Date('2026-04-25T12:34:56.789Z')
            );
            expect(logPath).toContain('C:\\Users\\lochen\\optimus-code\\.optimus\\logs\\runtime-startup-2026-04-25T12-34-56-789Z-');
            expect(logPath).toMatch(/\.log$/);
        });

        it('summarizes first and last stderr lines while preserving full stderr in log content', () => {
            const stderr = 'first failure line\nmiddle detail\nlast failure line\n';
            expect(getRuntimeStartupStderrSummary(stderr)).toEqual({
                firstLine: 'first failure line',
                lastLine: 'last failure line',
            });
            const content = buildRuntimeStartupFailureLog({
                workspaceRoot: 'C:\\Users\\lochen\\optimus-code',
                httpRuntimePath: 'C:\\Users\\lochen\\optimus-code\\optimus-plugin\\dist\\http-runtime.js',
                port: 3100,
                pid: 12345,
                exitCode: 1,
                timedOut: false,
                stderr,
            });
            expect(content).toContain('httpRuntimePath=C:\\Users\\lochen\\optimus-code\\optimus-plugin\\dist\\http-runtime.js');
            expect(content).toContain(stderr);
        });
    });
});
