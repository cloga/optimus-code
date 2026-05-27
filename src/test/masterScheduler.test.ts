import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MasterScheduler, classifyInboxContent } from '../runtime/masterScheduler';
import { SchedulerStore } from '../runtime/schedulerStore';

const tempDirs = new Set<string>();

function createWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-scheduler-test-'));
    tempDirs.add(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

describe('master scheduler', () => {
    it('classifies interruption-oriented inbox content', () => {
        expect(classifyInboxContent('取消当前任务')).toBe('cancellation');
        expect(classifyInboxContent('先做这个修复')).toBe('priority_change');
        expect(classifyInboxContent('刚才那个需求改成 Z')).toBe('task_update');
        expect(classifyInboxContent('Why is this failing?')).toBe('clarification');
        expect(classifyInboxContent('Analyze the runtime code')).toBe('new_task');
    });

    it('persists inbox entries, tasks, events, dependencies, and agent runs across store instances', () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const inbox = store.appendInboxEntry({ source: 'user', content: 'Analyze scheduler design' });
        const task = store.createTask({
            title: 'Analyze scheduler design',
            description: 'Analyze scheduler design',
            priority: 0,
            required_capability: 'research_worker',
            affected_files: [],
            created_from_inbox_id: inbox.id,
        });
        store.addDependency(task.id, 'upstream-task');
        store.appendTaskEvent({ task_id: task.id, event_type: 'task_created', payload: { inbox_id: inbox.id } });
        const run = store.createAgentRun({ task_id: task.id, agent_type: 'research_worker', input_summary: task.title });

        const reloaded = new SchedulerStore(workspace).snapshot();

        expect(reloaded.inbox_entries.map(entry => entry.id)).toContain(inbox.id);
        expect(reloaded.tasks.map(item => item.id)).toContain(task.id);
        expect(reloaded.task_dependencies).toContainEqual({ task_id: task.id, depends_on_task_id: 'upstream-task' });
        expect(reloaded.task_events.some(event => event.task_id === task.id && event.event_type === 'task_created')).toBe(true);
        expect(reloaded.agent_runs.map(item => item.id)).toContain(run.id);
    });

    it('turns inbox entries into durable tasks without dispatch when disabled', async () => {
        const workspace = createWorkspace();
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        scheduler.ingestInbox('user', 'Please analyze the runtime scheduler gaps', {
            required_capability: 'research_worker',
            depends_on: ['upstream-task'],
        });
        const tick = await scheduler.tick();

        expect(tick.processed_inbox).toBe(1);
        expect(tick.dispatched_tasks).toEqual([]);
        expect(tick.status.blocked).toHaveLength(1);
        expect(tick.status.blocked[0].required_capability).toBe('research_worker');
        expect(tick.status.blocked[0].blocking_reason).toContain('upstream-task');
    });

    it('preempts the current task for high-priority inbox entries', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const current = store.createTask({
            title: 'Current implementation',
            description: 'Current implementation',
            status: 'running',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/current.ts'],
            runtime_run_id: 'run_current',
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        scheduler.ingestInbox('user', '先做这个紧急修复', { affected_files: ['src/runtime/urgent.ts'] });
        const tick = await scheduler.tick();
        const updatedCurrent = store.getTask(current.id)!;

        expect(updatedCurrent.status).toBe('ready');
        expect(updatedCurrent.blocking_reason).toContain('Application-layer preemption');
        expect(tick.status.ready.some(task => task.priority === 100 && task.title.includes('先做'))).toBe(true);
    });

    it('pauses and resumes a scheduler task without auto-promoting while paused', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Interruptible task',
            description: 'Interruptible task',
            status: 'ready',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/masterScheduler.ts'],
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        const paused = await scheduler.pauseTask(task.id, 'Need to stop here');
        await scheduler.tick();
        expect(paused?.status).toBe('paused');
        expect(scheduler.getStatus().paused.map(item => item.id)).toContain(task.id);
        expect(store.getTask(task.id)!.status).toBe('paused');

        const resumed = scheduler.resumeTask(task.id, 'Continue');
        expect(resumed?.status).toBe('ready');
        expect(store.listTaskEvents(task.id).map(event => event.event_type)).toEqual(
            expect.arrayContaining(['task_paused', 'task_resumed'])
        );
    });

    it('reassigns running work by clearing active runtime state and queueing redispatch', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Running assignment',
            description: 'Running assignment',
            status: 'running',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/masterScheduler.ts'],
            runtime_run_id: 'run_missing',
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        const reassigned = await scheduler.reassignTask(task.id, {
            required_capability: 'research_worker',
            assigned_agent_id: 'researcher_123',
            reason: 'Need research context',
        });

        expect(reassigned?.status).toBe('ready');
        expect(reassigned?.required_capability).toBe('research_worker');
        expect(reassigned?.assigned_agent_id).toBe('researcher_123');
        expect(reassigned?.runtime_run_id).toBeUndefined();
        expect(store.listTaskEvents(task.id).map(event => event.event_type)).toContain('task_reassigned');
    });

    it('honors targeted inbox metadata for pause, resume, reassign, and priority changes', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Targeted task',
            description: 'Targeted task',
            status: 'ready',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: [],
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        scheduler.ingestInbox('user', 'pause this one', { action: 'pause', target_task_id: task.id });
        await scheduler.tick();
        expect(store.getTask(task.id)!.status).toBe('paused');

        scheduler.ingestInbox('user', 'send to researcher', {
            action: 'reassign',
            target_task_id: task.id,
            required_capability: 'research_worker',
            assigned_agent_id: 'researcher_456',
        });
        await scheduler.tick();
        expect(store.getTask(task.id)!.required_capability).toBe('research_worker');
        expect(store.getTask(task.id)!.status).toBe('paused');

        scheduler.ingestInbox('user', 'resume now', { action: 'resume', target_task_id: task.id });
        await scheduler.tick();
        expect(store.getTask(task.id)!.status).toBe('ready');

        scheduler.ingestInbox('user', 'do this first', { action: 'priority', target_task_id: task.id, priority: 77 });
        await scheduler.tick();
        expect(store.getTask(task.id)!.priority).toBe(77);
    });

    it('blocks ready coding tasks when affected files are locked by a running task', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        store.createTask({
            title: 'Running edit',
            description: 'Running edit',
            status: 'running',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/masterScheduler.ts'],
            runtime_run_id: 'run_locked',
        });
        const blocked = store.createTask({
            title: 'Conflicting edit',
            description: 'Conflicting edit',
            status: 'ready',
            priority: 10,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/masterScheduler.ts'],
        });
        const scheduler = new MasterScheduler(workspace, {
            maxConcurrentWorkers: 2,
            workerRoles: { coding_worker: 'definitely-missing-role' },
        });

        await scheduler.tick();
        const updated = store.getTask(blocked.id)!;

        expect(updated.status).toBe('blocked');
        expect(updated.blocking_reason).toContain('Conflict');
    });

    it('recovers running tasks that have no runtime run id', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Interrupted work',
            description: 'Interrupted work',
            status: 'running',
            priority: 0,
            required_capability: 'research_worker',
            affected_files: [],
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        await scheduler.tick();
        const recovered = store.getTask(task.id)!;

        expect(recovered.status).toBe('ready');
        expect(recovered.retry_count).toBe(1);
    });

    it('blocks dispatch when the injected runtime capacity gate is full', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Queued implementation',
            description: 'Queued implementation',
            status: 'ready',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/http-server.ts'],
        });
        const scheduler = new MasterScheduler(workspace, {
            tryAcquireWorkerSlot: () => false,
            workerRoles: { coding_worker: 'definitely-missing-role' },
        });

        const tick = await scheduler.tick();
        const updated = store.getTask(task.id)!;

        expect(tick.dispatched_tasks).toEqual([]);
        expect(updated.status).toBe('blocked');
        expect(updated.blocking_reason).toContain('Capacity');
    });

    it('keeps completed worker output in review by default', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const task = store.createTask({
            title: 'Needs review',
            description: 'Needs review',
            status: 'review',
            priority: 0,
            required_capability: 'research_worker',
            affected_files: [],
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        await scheduler.tick();

        expect(store.getTask(task.id)!.status).toBe('review');
    });

    it('records runtime cancellation failure when inbox cancellation targets an active runtime run', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        const current = store.createTask({
            title: 'Running task',
            description: 'Running task',
            status: 'running',
            priority: 0,
            required_capability: 'research_worker',
            affected_files: [],
            runtime_run_id: 'run_missing',
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        scheduler.ingestInbox('user', '取消当前任务');
        await scheduler.tick();

        expect(store.getTask(current.id)!.status).toBe('cancelled');
        expect(store.listTaskEvents(current.id).some(event => event.event_type === 'runtime_cancel_failed')).toBe(true);
    });

    it('does not churn conflict-blocked tasks while the conflicting task is still running', async () => {
        const workspace = createWorkspace();
        const store = new SchedulerStore(workspace);
        store.createTask({
            title: 'Running edit',
            description: 'Running edit',
            status: 'running',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/http-server.ts'],
            runtime_run_id: 'run_locked',
        });
        const blocked = store.createTask({
            title: 'Blocked edit',
            description: 'Blocked edit',
            status: 'blocked',
            priority: 0,
            required_capability: 'coding_worker',
            affected_files: ['src/runtime/http-server.ts'],
            blocking_reason: 'Conflict: src/runtime/http-server.ts is locked by task run_locked.',
        });
        const scheduler = new MasterScheduler(workspace, { dispatchEnabled: false });

        await scheduler.tick();

        const updated = store.getTask(blocked.id)!;
        expect(updated.status).toBe('blocked');
        expect(updated.blocking_reason).toContain('Conflict');
    });
});
