import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventBuffer, loadAgentRuntimeRecord } from '../utils/agentRuntime';

vi.mock('../mcp/council-runner', () => ({
    runWorkerInProcess: vi.fn(() => Promise.resolve()),
    spawnAsyncWorker: vi.fn(),
}));

vi.mock('../utils/resolveRoleName', () => ({
    resolveRoleName: (role: string) => role,
}));

vi.mock('../utils/validateMcpInput', () => ({
    validateRoleNotModelName: vi.fn(),
    validateEngineAndModel: vi.fn(),
}));

vi.mock('../mcp/worker-spawner', () => ({
    loadValidEnginesAndModels: () => ({ engines: ['claude-code'], models: {} }),
    loadEngineHeartbeatTimeout: () => null,
}));

const tmpDirs: string[] = [];

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-service-test-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
});

describe('agentRuntimeService', () => {
    it('makes a started run immediately queryable from the same workspace', async () => {
        const workspacePath = makeTmpDir();
        const runnerModule = await import('../mcp/council-runner');
        const runner = vi.mocked(runnerModule.runWorkerInProcess);
        const { startRun, getRunStatus } = await import('../runtime/agentRuntimeService');

        const started = startRun({
            role: 'runtime-tester',
            workspace_path: workspacePath,
            input: { prompt: 'hello' },
        });

        expect(started.run_id).toMatch(/^run_/);
        expect(started.status).toBe('queued');

        const queried = getRunStatus(workspacePath, started.run_id);
        expect(queried.run_id).toBe(started.run_id);
        expect(queried.status).toBe('queued');
        expect(queried.runtime_metadata.task_id).toBe(started.run_id);

        expect(runner).not.toHaveBeenCalled();
        await new Promise(resolve => setImmediate(resolve));
        expect(runner).toHaveBeenCalledWith(started.run_id, workspacePath);

        const eventStatuses = getEventBuffer(started.run_id)?.events
            .filter(event => event.type === 'status')
            .map(event => event.data);
        expect(eventStatuses).toEqual(expect.arrayContaining(['queued', 'starting', 'running']));

        const record = loadAgentRuntimeRecord(workspacePath, started.run_id);
        expect(record?.history.map(entry => entry.status)).toEqual(
            expect.arrayContaining(['queued', 'starting'])
        );
    });
});
