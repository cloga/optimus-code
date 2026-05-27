import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SchedulerStore } from '../runtime/schedulerStore';
import { buildSchedulerContextPacket, formatSchedulerContextForPrompt } from '../runtime/schedulerContext';
import { MasterScheduler } from '../runtime/masterScheduler';
import { buildAgentRuntimeTaskDescription } from '../utils/agentRuntime';

const tempDirs = new Set<string>();

function createWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-context-test-'));
    tempDirs.add(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('scheduler context bridge', () => {
    it('formats bounded inherited context from checkpoints, handoffs, and yields', () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Bridge task',
            description: 'Implement scheduler memory bridge',
            status: 'ready',
            priority: 10,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/masterScheduler.ts'],
            context_summary: 'Master found the prompt injection gap.',
            acceptance_criteria: 'Worker receives inherited scheduler context.',
        });
        for (let i = 0; i < 20; i++) {
            store.appendTaskEvent({
                task_id: task.id,
                event_type: i === 18 ? 'task_checkpointed' : i === 19 ? 'task_handed_off' : 'task_updated_from_inbox',
                payload: { summary: `event ${i}`, next_steps: `next ${i}` },
            });
        }

        const packet = buildSchedulerContextPacket(workspace, task.id, { maxEvents: 5 })!;
        const formatted = formatSchedulerContextForPrompt(packet, { maxChars: 4000 });

        expect(packet.recent_events).toHaveLength(5);
        expect(packet.truncated).toBe(true);
        expect(formatted).toContain('Inherited Scheduler Context');
        expect(formatted).toContain('Master found the prompt injection gap.');
        expect(formatted).toContain('task_checkpointed');
        expect(formatted).toContain('task_handed_off');
        expect(formatted).toContain('Earlier scheduler events were omitted');
    });

    it('injects scheduler context into Agent Runtime task descriptions without changing direct delegate memory', () => {
        const taskDescription = buildAgentRuntimeTaskDescription({
            role: 'research_worker',
            workspace_path: createWorkspace(),
            input: 'Analyze README',
            scheduler_context: '## Inherited Scheduler Context\n- checkpoint summary',
        });

        expect(taskDescription).toContain('## Inherited Scheduler Context');
        expect(taskDescription).toContain('checkpoint summary');
        expect(taskDescription).toContain('## Input');
    });

    it('does not write scheduler checkpoint, handoff, or yield events into long-term memory automatically', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'No memory pollution',
            description: 'No memory pollution',
            status: 'running',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: [],
            runtime_run_id: 'run_current',
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        scheduler.checkpointTask(task.id, { summary: 'Short-term checkpoint only.' });
        await scheduler.handoffTask(task.id, { summary: 'Short-term handoff only.' });
        scheduler.yieldTask(task.id, { reason: 'Yield only.' });

        expect(fs.existsSync(path.join(workspace, '.optimus', 'memory', 'continuous-memory.md'))).toBe(false);
    });

    it('promotes selected reusable lessons to memory only when explicitly requested', () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Promote memory',
            description: 'Promote memory',
            status: 'done',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: [],
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        scheduler.promoteTaskMemory(task.id, {
            level: 'project',
            category: 'workflow',
            tags: ['scheduler', 'handoff'],
            content: 'Promote only generalized lessons, not raw scheduler event logs.',
        });

        const promotionEvent = store.listTaskEvents(task.id).find(event => event.event_type === 'task_memory_promoted');
        expect(promotionEvent).toBeDefined();
        const memoryPath = promotionEvent?.payload.memory_file;
        expect(typeof memoryPath).toBe('string');
        expect(fs.readFileSync(memoryPath as string, 'utf8')).toContain('Promote only generalized lessons');
    });
});
