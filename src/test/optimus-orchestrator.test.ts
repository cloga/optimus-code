import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveEffectiveTaskStatus, summarizeOptimusTaskSettlement } from '../mcp/optimus-orchestrator';
import type { TaskRecord } from '../managers/TaskManifestManager';

function createTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
        taskId: overrides.taskId || 'task_1',
        type: overrides.type || 'delegate_task',
        status: overrides.status || 'completed',
        startTime: overrides.startTime || Date.now(),
        heartbeatTime: overrides.heartbeatTime || Date.now(),
        workspacePath: overrides.workspacePath || process.cwd(),
        ...overrides,
    };
}

describe('optimus orchestrator settlement helpers', () => {
    it('treats completed tasks with materialized output as verified', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-orchestrator-'));
        try {
            const outputPath = path.join(workspace, 'result.txt');
            fs.writeFileSync(outputPath, 'done', 'utf8');

            expect(resolveEffectiveTaskStatus(createTaskRecord({ output_path: outputPath }))).toBe('verified');
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('marks missing or failed tasks as terminal failures in aggregate settlement', () => {
        const settlement = summarizeOptimusTaskSettlement(['implement', 'verify'], {
            implement: createTaskRecord({ taskId: 'implement', status: 'failed', error_message: 'boom' }),
        });

        expect(settlement.settled).toBe(true);
        expect(settlement.overallStatus).toBe('failed');
        expect(settlement.tasks.find(task => task.taskId === 'verify')?.effectiveStatus).toBe('missing');
    });

    it('marks mixed verified and awaiting-input tasks as awaiting_input terminal state', () => {
        const settlement = summarizeOptimusTaskSettlement(['implement', 'verify'], {
            implement: createTaskRecord({ taskId: 'implement', status: 'verified' }),
            verify: createTaskRecord({ taskId: 'verify', status: 'awaiting_input', pause_question: 'Need approval?' }),
        });

        expect(settlement.settled).toBe(true);
        expect(settlement.overallStatus).toBe('awaiting_input');
    });

    it('keeps the aggregate unsettled while any task is still pending or running', () => {
        const settlement = summarizeOptimusTaskSettlement(['implement', 'verify'], {
            implement: createTaskRecord({ taskId: 'implement', status: 'verified' }),
            verify: createTaskRecord({ taskId: 'verify', status: 'running' }),
        });

        expect(settlement.settled).toBe(false);
        expect(settlement.overallStatus).toBe('running');
    });
});
