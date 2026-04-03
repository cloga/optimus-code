/**
 * ACP Smoke Tests (Release CI)
 *
 * Validates that ACP engine configuration, executable discovery, process
 * spawning, and error reporting all work correctly. Covers the fix for
 * Issue #538 (delegate_task_async fails with acp_process_crashed).
 *
 * Tests are resilient: they skip gracefully when CLI tools aren't installed
 * so CI environments without engines still pass.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as cp from 'child_process';
import {
    getEngineConfig,
    getConfiguredEngineNames,
    explainEngineResolution,
} from '../mcp/engine-resolver.js';
import { AcpProcessPool } from '../utils/acpProcessPool.js';
import { AcpAdapter } from '../adapters/AcpAdapter.js';

// ─── Helpers ───

const WORKSPACE = process.cwd();

/** Check if an executable is available on PATH. */
function isExecutableAvailable(executable: string): boolean {
    try {
        const cmd = process.platform === 'win32'
            ? `where ${executable}`
            : `which ${executable}`;
        cp.execSync(cmd, { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

describe('ACP Smoke Tests (Release CI)', () => {
    afterEach(() => {
        AcpProcessPool.resetInstance();
    });

    // ─── 1. ACP Configuration Validation ───

    describe('ACP Configuration Validation', () => {
        it('available-agents.json lists at least one engine', () => {
            const engines = getConfiguredEngineNames(WORKSPACE);
            expect(engines.length).toBeGreaterThan(0);
        });

        it.each(getConfiguredEngineNames(WORKSPACE))(
            'engine "%s" resolves to ACP protocol with executable set',
            (engine) => {
                const config = getEngineConfig(engine, WORKSPACE);
                expect(config).not.toBeNull();
                expect(config.protocol).toBe('acp');
                expect(config.acp?.path).toBeTruthy();
            },
        );

        it('github-copilot engine has --stdio in args', () => {
            const engines = getConfiguredEngineNames(WORKSPACE);
            if (!engines.includes('github-copilot')) {
                return; // engine not configured in this workspace
            }
            const config = getEngineConfig('github-copilot', WORKSPACE);
            expect(config.acp.args).toContain('--stdio');
        });

        it('claude-code engine has --stdio in args', () => {
            const engines = getConfiguredEngineNames(WORKSPACE);
            if (!engines.includes('claude-code')) {
                return; // engine not configured in this workspace
            }
            const config = getEngineConfig('claude-code', WORKSPACE);
            expect(config.acp.args).toContain('--stdio');
        });

        it.each(getConfiguredEngineNames(WORKSPACE))(
            'engine "%s" automation policy is auto-approve + autopilot',
            (engine) => {
                const explanation = explainEngineResolution(engine, WORKSPACE);
                expect(explanation.requestedAutomation.mode).toBe('auto-approve');
                expect(explanation.requestedAutomation.continuation).toBe('autopilot');
            },
        );
    });

    // ─── 2. Pre-flight Executable Check ───

    describe('Pre-flight Executable Check', () => {
        const engines = getConfiguredEngineNames(WORKSPACE);

        for (const engine of engines) {
            const config = getEngineConfig(engine, WORKSPACE);
            const executable = config?.acp?.path;

            it(`engine "${engine}" executable "${executable}" can be located (skip if not installed)`, () => {
                if (!executable) {
                    // No executable configured — skip
                    return;
                }
                const available = isExecutableAvailable(executable);
                if (!available) {
                    console.log(`  ⏭ Skipping: "${executable}" not installed on this machine`);
                    return;
                }
                // Executable was found — verify it returns cleanly from `where`/`which`
                expect(available).toBe(true);
            });
        }
    });

    // ─── 3. ACP Process Spawn & Handshake ───

    describe('ACP Process Spawn & Handshake', () => {
        const engines = getConfiguredEngineNames(WORKSPACE);

        for (const engine of engines) {
            const config = getEngineConfig(engine, WORKSPACE);
            const executable = config?.acp?.path;
            const args: string[] = Array.isArray(config?.acp?.args) ? config.acp.args : [];
            const available = executable ? isExecutableAvailable(executable) : false;

            it.skipIf(!available)(
                `engine "${engine}" spawns and completes ACP initialize handshake`,
                async () => {
                    const adapter = new AcpAdapter(
                        `smoke-${engine}`,
                        `Smoke-${engine}`,
                        executable!,
                        args,
                        0,
                        false, // ephemeral — auto-clean after invoke
                    );

                    try {
                        // invoke triggers spawn → initialize handshake → prompt
                        const result = await adapter.invoke(
                            'Respond with exactly: SMOKE_OK',
                            'agent',
                        );
                        // We only care that we got a non-empty response (handshake succeeded)
                        expect(result).toBeTruthy();
                        expect(typeof result).toBe('string');
                    } finally {
                        adapter.shutdown();
                    }
                },
                30_000,
            );
        }
    });

    // ─── 4. Stderr Capture & Actionable Error ───

    describe('Stderr Capture & Actionable Error', () => {
        it('non-existent executable produces actionable pre-flight error', async () => {
            const adapter = new AcpAdapter(
                'smoke-missing',
                'Smoke-Missing',
                'nonexistent-acp-engine-xyz',
                [],
                0,
                false,
            );

            await expect(
                adapter.invoke('hello', 'agent'),
            ).rejects.toThrow(/pre-flight failed/i);
        });

        it('pre-flight error includes install instructions', async () => {
            const adapter = new AcpAdapter(
                'smoke-missing-2',
                'Smoke-Missing-2',
                'nonexistent-acp-engine-xyz',
                [],
                0,
                false,
            );

            try {
                await adapter.invoke('hello', 'agent');
                expect.unreachable('should have thrown');
            } catch (err: any) {
                expect(err.message).toMatch(/not found/i);
                expect(err.message).toMatch(/install|update.*path/i);
            }
        });
    });
});
