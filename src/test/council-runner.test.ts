import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTaskFailureAndRecoverIfPossible, isInfrastructureFailureMessage, openWorkerLogFd } from '../mcp/council-runner';
import { TaskManifestManager } from '../managers/TaskManifestManager';

describe('openWorkerLogFd', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns a numeric file descriptor for worker stderr logs', () => {
        const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-worker-log-'));

        const fd = openWorkerLogFd(logsDir, 'task123');

        expect(typeof fd).toBe('number');
        expect(fs.existsSync(path.join(logsDir, 'worker-task123.log'))).toBe(true);

        if (typeof fd === 'number') {
            fs.closeSync(fd);
        }

        fs.rmSync(logsDir, { recursive: true, force: true });
    });

    it('falls back to ignore when opening the log file fails', () => {
        vi.spyOn(fs, 'openSync').mockImplementation(() => {
            throw new Error('disk failure');
        });

        const logsDir = path.join(os.tmpdir(), 'optimus-worker-log-fail');
        const fd = openWorkerLogFd(logsDir, 'task123');

        expect(fd).toBe('ignore');
    });
});

function createProjectLocalWorkspace(): string {
    const workspaceRoot = path.join(process.cwd(), '.test-workspaces');
    const workspace = path.join(workspaceRoot, `council-runner-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(path.join(workspace, '.optimus', 'state'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.optimus', 'results'), { recursive: true });
    return workspace;
}

async function flushManifestUpdates(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 25));
}

describe('infrastructure failure self-heal guard', () => {
    it('classifies runtime and runner infrastructure failures', () => {
        expect(isInfrastructureFailureMessage('Runtime server not available on port 3100')).toBe(true);
        expect(isInfrastructureFailureMessage('Runtime server proxy timed out after 630000ms')).toBe(true);
        expect(isInfrastructureFailureMessage('Runtime server proxy failed: ECONNRESET')).toBe(true);
        expect(isInfrastructureFailureMessage('TASK_RUNNER_DIED: Async worker PID 123 is no longer running')).toBe(true);
        expect(isInfrastructureFailureMessage('TASK_STARTUP_TIMEOUT: Async worker failed to start')).toBe(true);
        expect(isInfrastructureFailureMessage('TASK_HEARTBEAT_TIMEOUT: No detached-worker heartbeat')).toBe(true);
        expect(isInfrastructureFailureMessage('SPAWN_FAILED: mcp-server.js not found')).toBe(true);
        expect(isInfrastructureFailureMessage('Agent produced no usable output.')).toBe(false);
    });

    it('does not spawn reviewer self-heal tasks for infrastructure failures', async () => {
        const workspace = createProjectLocalWorkspace();
        try {
            TaskManifestManager.createTask(workspace, {
                taskId: 'infra_failed_task',
                type: 'delegate_task',
                role: 'code-architect',
                task_description: 'Design the runtime flow.',
                output_path: path.join(workspace, '.optimus', 'results', 'infra_failed_task.md'),
                workspacePath: workspace,
            });

            await handleTaskFailureAndRecoverIfPossible(
                workspace,
                'infra_failed_task',
                'Runtime server proxy timed out after 630000ms. Fix: verify runtime health.'
            );
            await flushManifestUpdates();

            const manifest = TaskManifestManager.loadManifest(workspace);
            const task = manifest.infra_failed_task;
            expect(task.status).toBe('failed');
            expect(task.failure_classification).toBe('infrastructure_failure');
            expect(task.error_message).toContain('Runtime server proxy timed out after 630000ms');
            expect(task.error_message).toContain('Normal self-heal is skipped');
            expect(typeof task.completed_at).toBe('number');
            expect(task.depends_on).toBeUndefined();
            expect(Object.keys(manifest).some(taskId => taskId.startsWith('fix_infra_failed_task_'))).toBe(false);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });
});
