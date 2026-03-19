/**
 * Test: Council Capacity Accounting + Async Observability
 *
 * Covers:
 *  - computeDiversityAssignments: three-state classification, static validation,
 *    configured vs runnable vs assigned pool logging
 *  - dispatchCouncilConcurrent: DISPATCH_MANIFEST.md pre-spawn, per-role placeholder
 *    files, failure artifact overwrite, FAILURES.md partial failure report
 *  - async council queue helper used by dispatch_council_async: STATUS.md + manifest
 *    entry created immediately
 *
 * Run: vitest src/test/council-capacity.test.ts
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Test Harness ───

function assert(label: string, condition: boolean, detail?: string): void {
    expect(condition, detail ? `${label} — ${detail}` : label).toBe(true);
}

function createTempWorkspace(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-capacity-test-'));
    const optimusDir = path.join(tmp, '.optimus');
    fs.mkdirSync(path.join(optimusDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(optimusDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(optimusDir, 'reviews'), { recursive: true });
    return tmp;
}

function writeAgentsConfig(workspacePath: string, config: object): void {
    fs.writeFileSync(
        path.join(workspacePath, '.optimus', 'config', 'available-agents.json'),
        JSON.stringify(config, null, 2),
        'utf8'
    );
}

function writeEngineHealth(workspacePath: string, health: Record<string, object>): void {
    fs.writeFileSync(
        path.join(workspacePath, '.optimus', 'state', 'engine-health.json'),
        JSON.stringify(health, null, 2),
        'utf8'
    );
}

function cleanup(workspacePath: string): void {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch {}
}

// ─── Import Functions Under Test ───
// We import from worker-spawner directly. CI note: functions are exported.

import {
    loadValidEnginesAndModels,
    dispatchCouncilConcurrent,
} from '../mcp/worker-spawner';
import { prepareAsyncCouncilDispatch } from '../mcp/async-council-dispatch';
import { TaskManifestManager } from '../managers/TaskManifestManager';

// ─── Test Cases ───

async function test_configured_vs_runnable_pool_logging(): Promise<void> {
    const ws = createTempWorkspace();
    try {
        writeAgentsConfig(ws, {
            engines: {
                'claude-code': {
                    protocol: 'acp',
                    path: 'claude-agent-acp',
                    available_models: ['model-a', 'model-b'],
                    cli_flags: '--model'
                },
                'github-copilot': {
                    protocol: 'cli',
                    path: 'copilot',
                    available_models: ['gpt-x'],
                    cli_flags: '-m'
                }
            }
        });
        // Mark one model unhealthy
        writeEngineHealth(ws, {
            'claude-code:model-b': {
                engine: 'claude-code', model: 'model-b',
                invocations: 5, successes: 0, failures: 5, consecutive_failures: 5,
                last_success: '', last_failure: new Date().toISOString(),
                status: 'unhealthy'
            }
        });

        const { engines, models } = loadValidEnginesAndModels(ws);
        assert('loadValidEnginesAndModels returns both engines', engines.length === 2,
            `got ${engines.length}`);
        assert('claude-code has 2 models', (models['claude-code'] || []).length === 2);
        assert('github-copilot has 1 model', (models['github-copilot'] || []).length === 1);
    } finally {
        cleanup(ws);
    }
}

async function test_unhealthy_combo_excluded_from_assignments(): Promise<void> {
    const ws = createTempWorkspace();
    const spawnLog: Array<{ engine?: string; model?: string }> = [];
    try {
        writeAgentsConfig(ws, {
            engines: {
                'claude-code': {
                    protocol: 'acp',
                    path: 'claude-agent-acp',
                    available_models: ['opus', 'sonnet'],
                    cli_flags: '--model'
                }
            }
        });
        // Mark 'opus' as unhealthy within TTL
        writeEngineHealth(ws, {
            'claude-code:opus': {
                engine: 'claude-code', model: 'opus',
                invocations: 3, successes: 0, failures: 3, consecutive_failures: 3,
                last_success: '', last_failure: new Date().toISOString(),
                status: 'unhealthy'
            },
            'claude-code:sonnet': {
                engine: 'claude-code', model: 'sonnet',
                invocations: 5, successes: 5, failures: 0, consecutive_failures: 0,
                last_success: new Date().toISOString(), last_failure: '',
                status: 'healthy'
            }
        });

        const reviewsPath = path.join(ws, '.optimus', 'reviews', 'test_council_1');
        fs.mkdirSync(reviewsPath, { recursive: true });
        const proposalPath = path.join(ws, 'proposal.md');
        fs.writeFileSync(proposalPath, '# Test Proposal\nContent.', 'utf8');

        // Use spawn override to capture what engines/models were assigned
        const spawnOverride = async (
            role: string, _proposalPath: string, outputPath: string,
            _sessionId: string, _workspacePath: string,
            _parentDepth?: number, _parentIssueNumber?: number,
            _roleDescription?: string, engine?: string, model?: string
        ): Promise<string> => {
            spawnLog.push({ engine, model });
            // Write a real review file so verification passes
            fs.writeFileSync(outputPath, `# Review: ${role}\n\nLooks good.`, 'utf8');
            return `ok:${role}`;
        };

        await dispatchCouncilConcurrent(
            ['reviewer-a', 'reviewer-b'],
            proposalPath,
            reviewsPath,
            'ts_test2',
            ws,
            undefined, undefined, undefined,
            spawnOverride
        );

        // Both roles should be assigned to the only healthy combo (sonnet)
        assert('reviewer-a assigned to claude-code',
            spawnLog[0]?.engine === 'claude-code');
        assert('reviewer-a model is sonnet (not unhealthy opus)',
            spawnLog[0]?.model === 'sonnet',
            `got ${spawnLog[0]?.model}`);
        assert('reviewer-b also assigned to sonnet',
            spawnLog[1]?.model === 'sonnet',
            `got ${spawnLog[1]?.model}`);
    } finally {
        cleanup(ws);
    }
}

async function test_static_validation_rejects_malformed_config_entries(): Promise<void> {
    const ws = createTempWorkspace();
    const spawnLog: Array<{ engine?: string; model?: string }> = [];
    try {
        writeAgentsConfig(ws, {
            engines: {
                'bad-path': {
                    protocol: 'acp',
                    path: '   ',
                    available_models: ['ghost-model'],
                    cli_flags: '--model'
                },
                'bad-models': {
                    protocol: 'cli',
                    path: 'copilot',
                    available_models: ['', null, '   '],
                    cli_flags: '-m'
                },
                'good-engine': {
                    protocol: 'cli',
                    path: 'copilot',
                    available_models: ['gpt-x'],
                    cli_flags: '-m'
                }
            }
        });

        const reviewsPath = path.join(ws, '.optimus', 'reviews', 'test_council_static_validation');
        fs.mkdirSync(reviewsPath, { recursive: true });
        const proposalPath = path.join(ws, 'proposal.md');
        fs.writeFileSync(proposalPath, '# Test Proposal\nContent.', 'utf8');

        const spawnOverride = async (
            role: string, _proposalPath: string, outputPath: string,
            _sessionId: string, _workspacePath: string,
            _parentDepth?: number, _parentIssueNumber?: number,
            _roleDescription?: string, engine?: string, model?: string
        ): Promise<string> => {
            spawnLog.push({ engine, model });
            fs.writeFileSync(outputPath, `# Review: ${role}\n\nLooks good.`, 'utf8');
            return `ok:${role}`;
        };

        await dispatchCouncilConcurrent(
            ['reviewer-a', 'reviewer-b'],
            proposalPath,
            reviewsPath,
            'ts_test3',
            ws,
            undefined, undefined, undefined,
            spawnOverride
        );

        assert('Malformed configs do not crash dispatch', spawnLog.length === 2, `got ${spawnLog.length} assignments`);
        assert('reviewer-a assigned to the only statically valid engine', spawnLog[0]?.engine === 'good-engine', `got ${spawnLog[0]?.engine}`);
        assert('reviewer-a assigned to the only statically valid model', spawnLog[0]?.model === 'gpt-x', `got ${spawnLog[0]?.model}`);
        assert('reviewer-b also assigned to the only statically valid model', spawnLog[1]?.model === 'gpt-x', `got ${spawnLog[1]?.model}`);
    } finally {
        cleanup(ws);
    }
}

async function test_degraded_fallback_all_unhealthy(): Promise<void> {
    const ws = createTempWorkspace();
    const spawnLog: Array<{ engine?: string; model?: string }> = [];
    try {
        writeAgentsConfig(ws, {
            engines: {
                'claude-code': {
                    protocol: 'acp',
                    path: 'claude-agent-acp',
                    available_models: ['opus'],
                    cli_flags: '--model'
                }
            }
        });
        writeEngineHealth(ws, {
            'claude-code:opus': {
                engine: 'claude-code', model: 'opus',
                invocations: 5, successes: 0, failures: 5, consecutive_failures: 5,
                last_success: '', last_failure: new Date().toISOString(),
                status: 'unhealthy'
            }
        });

        const reviewsPath = path.join(ws, '.optimus', 'reviews', 'test_council_degraded');
        fs.mkdirSync(reviewsPath, { recursive: true });
        const proposalPath = path.join(ws, 'proposal.md');
        fs.writeFileSync(proposalPath, '# Test\nContent.', 'utf8');

        const spawnOverride = async (
            role: string, _proposalPath: string, outputPath: string,
            _sessionId: string, _workspacePath: string,
            _parentDepth?: number, _parentIssueNumber?: number,
            _roleDescription?: string, engine?: string, model?: string
        ): Promise<string> => {
            spawnLog.push({ engine, model });
            fs.writeFileSync(outputPath, `# Review: ${role}\n\nOk.`, 'utf8');
            return `ok:${role}`;
        };

        await dispatchCouncilConcurrent(
            ['role-x'],
            proposalPath,
            reviewsPath,
            'ts_test3',
            ws,
            undefined, undefined, undefined,
            spawnOverride
        );

        // Degraded: engine/model should both be undefined (use defaults)
        assert('Degraded fallback: engine is undefined',
            spawnLog[0]?.engine === undefined,
            `got engine=${spawnLog[0]?.engine}`);
        assert('Degraded fallback: model is undefined',
            spawnLog[0]?.model === undefined,
            `got model=${spawnLog[0]?.model}`);
    } finally {
        cleanup(ws);
    }
}

async function test_reviews_dir_created_immediately(): Promise<void> {
    const ws = createTempWorkspace();
    try {
        writeAgentsConfig(ws, {
            engines: {
                'claude-code': {
                    protocol: 'acp', path: 'claude-agent-acp',
                    available_models: ['opus'], cli_flags: '--model'
                }
            }
        });

        const reviewsPath = path.join(ws, '.optimus', 'reviews', 'test_council_early');
        const proposalPath = path.join(ws, 'proposal.md');
        fs.writeFileSync(proposalPath, '# Test\nContent.', 'utf8');

        let dirExistedBeforeSpawn = false;
        const spawnOverride = async (
            role: string, _proposalPath: string, outputPath: string,
            _sessionId: string, _workspacePath: string,
        ): Promise<string> => {
            // When this is called, the reviewsPath should already exist
            dirExistedBeforeSpawn = fs.existsSync(reviewsPath);
            fs.writeFileSync(outputPath, `# Review\nOk.`, 'utf8');
            return `ok:${role}`;
        };

        await dispatchCouncilConcurrent(
            ['reviewer'],
            proposalPath,
            reviewsPath,
            'ts_test4',
            ws,
            undefined, undefined, undefined,
            spawnOverride
        );

        assert('Reviews directory exists before first spawn call', dirExistedBeforeSpawn);
    } finally {
        cleanup(ws);
    }
}

async function test_placeholder_files_exist_before_spawn(): Promise<void> {
    const ws = createTempWorkspace();
    try {
        writeAgentsConfig(ws, {
            engines: {
                'claude-code': {
                    protocol: 'acp', path: 'claude-agent-acp',
                    available_models: ['opus'], cli_flags: '--model'
                }
            }
        });

        const reviewsPath = path.join(ws, '.optimus', 'reviews', 'test_council_placeholder');
        const proposalPath = path.join(ws, 'proposal.md');
        fs.writeFileSync(proposalPath, '# Test\nContent.', 'utf8');

        const placeholderExistenceLog: Record<string, boolean> = {};

        const spawnOverride = async (
            role: string, _proposalPath: string, outputPath: string,
            _sessionId: string, _workspacePath: string,
        ): Promise<string> => {
            // When spawn is called, placeholder should already exist
            placeholderExistenceLog[role] = fs.existsSync(outputPath);
            const content = placeholderExistenceLog[role] ? fs.readFileSync(outputPath, 'utf8') : '';
            // Overwrite with real review
            fs.writeFileSync(outputPath, `# Review: ${role}\n\n${content.includes('in-progress') ? 'placeholder was there' : 'no placeholder'}\n\nFinal review content.`, 'utf8');
            return `ok:${role}`;
        };

        await dispatchCouncilConcurrent(
            ['role-alpha', 'role-beta'],
            proposalPath,
            reviewsPath,
            'ts_test5',
            ws,
            undefined, undefined, undefined,
            spawnOverride
        );

        assert('role-alpha placeholder existed before spawn', placeholderExistenceLog['role-alpha'] === true);
        assert('role-beta placeholder existed before spawn', placeholderExistenceLog['role-beta'] === true);

        // DISPATCH_MANIFEST.md must exist
        assert('DISPATCH_MANIFEST.md exists pre-spawn', fs.existsSync(path.join(reviewsPath, 'DISPATCH_MANIFEST.md')));
    } finally {
        cleanup(ws);
    }
}

async function test_failure_artifact_overwrite(): Promise<void> {
    const ws = createTempWorkspace();
    try {
        writeAgentsConfig(ws, {
            engines: {
                'claude-code': {
                    protocol: 'acp', path: 'claude-agent-acp',
                    available_models: ['opus'], cli_flags: '--model'
                }
            }
        });

        const reviewsPath = path.join(ws, '.optimus', 'reviews', 'test_council_failure');
        const proposalPath = path.join(ws, 'proposal.md');
        fs.writeFileSync(proposalPath, '# Test\nContent.', 'utf8');

        const spawnOverride = async (
            role: string, _proposalPath: string, _outputPath: string,
        ): Promise<string> => {
            throw new Error(`Simulated spawn failure for ${role}`);
        };

        await dispatchCouncilConcurrent(
            ['doomed-role'],
            proposalPath,
            reviewsPath,
            'ts_test6',
            ws,
            undefined, undefined, undefined,
            spawnOverride
        );

        const failureFile = path.join(reviewsPath, 'doomed-role_review.md');
        assert('Failure artifact exists', fs.existsSync(failureFile));
        if (fs.existsSync(failureFile)) {
            const content = fs.readFileSync(failureFile, 'utf8');
            assert('Failure artifact contains status:failed', content.includes('status:** failed'));
            assert('Failure artifact contains error message', content.includes('Simulated spawn failure'));
        }
        // FAILURES.md should also exist
        assert('FAILURES.md exists', fs.existsSync(path.join(reviewsPath, 'FAILURES.md')));
    } finally {
        cleanup(ws);
    }
}

async function test_status_md_created_for_async_dispatch(): Promise<void> {
    const ws = createTempWorkspace();
    try {
        const roles = ['reviewer-1', 'reviewer-2'];
        const proposalPath = 'specs/test.md';
        const taskId = `council_test_${Date.now()}`;
        const { reviewsPath, statusPath } = prepareAsyncCouncilDispatch({
            workspacePath: ws,
            proposalPath,
            roles,
            taskId,
            delegationDepth: 2,
        });

        assert('Reviews directory exists after dispatch_council_async', fs.existsSync(reviewsPath));
        assert('STATUS.md exists immediately after dispatch', fs.existsSync(statusPath));

        const content = fs.readFileSync(statusPath, 'utf8');
        assert('STATUS.md contains phase:queued', content.includes('phase:** queued'));
        assert('STATUS.md contains council_id', content.includes(taskId));
        assert('STATUS.md not empty', content.trim().length > 0);

        const manifest = TaskManifestManager.loadManifest(ws);
        assert('Task manifest contains queued council task', manifest[taskId]?.type === 'dispatch_council');
        assert('Task manifest records reviews path', manifest[taskId]?.output_path === reviewsPath, `got ${manifest[taskId]?.output_path}`);
    } finally {
        cleanup(ws);
    }
}

describe('Council capacity accounting and async observability', () => {
    it('keeps configured engines/models visible to validation', async () => {
        await test_configured_vs_runnable_pool_logging();
    });

    it('excludes unhealthy combos from diversity assignments', async () => {
        await test_unhealthy_combo_excluded_from_assignments();
    });

    it('rejects malformed config entries before assignment', async () => {
        await test_static_validation_rejects_malformed_config_entries();
    });

    it('falls back to defaults when every combo is unhealthy', async () => {
        await test_degraded_fallback_all_unhealthy();
    });

    it('creates the reviews directory before workers start', async () => {
        await test_reviews_dir_created_immediately();
    });

    it('creates placeholder review files before workers start', async () => {
        await test_placeholder_files_exist_before_spawn();
    });

    it('overwrites placeholders with failure artifacts when a worker fails', async () => {
        await test_failure_artifact_overwrite();
    });

    it('creates queued async dispatch artifacts immediately', async () => {
        await test_status_md_created_for_async_dispatch();
    });
});
