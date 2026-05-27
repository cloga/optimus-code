import {
    SchedulerAgentRun,
    SchedulerCapability,
    SchedulerInboxEntry,
    SchedulerInboxSource,
    SchedulerStore,
    SchedulerTask,
    SchedulerTaskStatus,
} from './schedulerStore';
import { startRun, getRunStatus, cancelRun } from './agentRuntimeService';
import { TaskManifestManager } from '../managers/TaskManifestManager';

export const MASTER_SCHEDULER_PROTOCOL = [
    'Application-layer scheduler: this does not intercept or replace Copilot core turn scheduling.',
    'For task-bearing user feedback, persist the message with scheduler_ingest before deciding whether to queue, update, cancel, prioritize, or dispatch work.',
    'Treat scheduler tasks and task_events as durable state; do not rely on transient LLM context as the source of truth.',
].join(' ');

export type InboxClassification =
    | 'new_task'
    | 'task_update'
    | 'cancellation'
    | 'priority_change'
    | 'clarification'
    | 'interrupt';

export interface SchedulerOptions {
    maxConcurrentWorkers?: number;
    workerRoles?: Partial<Record<'research_worker' | 'coding_worker', string>>;
    dispatchEnabled?: boolean;
    autoApproveReview?: boolean;
    tryAcquireWorkerSlot?: () => boolean;
    releaseWorkerSlot?: () => void;
    onWorkerRunStarted?: (runId: string, workspacePath: string) => void;
}

export interface SchedulerTickResult {
    processed_inbox: number;
    dispatched_tasks: string[];
    recovered_tasks: string[];
    reconciled_tasks: string[];
    status: SchedulerStatus;
}

export interface SchedulerStatus {
    current: SchedulerTask[];
    ready: SchedulerTask[];
    pending: SchedulerTask[];
    blocked: SchedulerTask[];
    review: SchedulerTask[];
    failed: SchedulerTask[];
    done: SchedulerTask[];
    cancelled: SchedulerTask[];
    inbox_pending: number;
    agent_runs: SchedulerAgentRun[];
}

const DEFAULT_WORKER_ROLES: Record<'research_worker' | 'coding_worker', string> = {
    research_worker: 'researcher',
    coding_worker: 'developer',
};

const tickLocks = new Set<string>();
const schedulerLoops = new Map<string, ReturnType<typeof setInterval>>();

function nowIso(): string {
    return new Date().toISOString();
}

function summarizeTitle(content: string): string {
    const firstLine = content.split(/\r?\n/).find(line => line.trim()) || content;
    const compact = firstLine.replace(/\s+/g, ' ').trim();
    return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact || 'Untitled task';
}

function inferCapability(content: string): SchedulerCapability {
    const normalized = content.toLowerCase();
    if (
        /implement|fix|code|test|build|refactor|修改|实现|修复|测试|代码/.test(normalized)
    ) {
        return 'coding_worker';
    }
    return 'research_worker';
}

function inferAffectedFiles(metadata?: Record<string, unknown>): string[] {
    const value = metadata?.affected_files;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function classifyInboxContent(content: string): InboxClassification {
    const normalized = content.toLowerCase();
    if (/(取消|停下|停止|cancel|stop|abort)/i.test(content)) return 'cancellation';
    if (/(先做|优先|插队|do this first|priority|first)/i.test(content)) return 'priority_change';
    if (/(改成|变更|需求改|change requirement|change .* to)/i.test(content)) return 'task_update';
    if (/(打断|立即|马上|interrupt|urgent)/i.test(content)) return 'interrupt';
    if (/[?？]$/.test(content.trim()) || /^(what|why|how|when|who)\b/.test(normalized)) return 'clarification';
    return 'new_task';
}

export class MasterScheduler {
    private readonly store: SchedulerStore;
    private readonly maxConcurrentWorkers: number;
    private readonly workerRoles: Record<'research_worker' | 'coding_worker', string>;
    private readonly dispatchEnabled: boolean;
    private readonly autoApproveReview: boolean;
    private readonly tryAcquireWorkerSlot?: () => boolean;
    private readonly releaseWorkerSlot?: () => void;
    private readonly onWorkerRunStarted?: (runId: string, workspacePath: string) => void;

    constructor(private readonly workspacePath: string, options: SchedulerOptions = {}) {
        this.store = new SchedulerStore(workspacePath);
        this.maxConcurrentWorkers = Math.max(1, options.maxConcurrentWorkers ?? 2);
        this.workerRoles = { ...DEFAULT_WORKER_ROLES, ...options.workerRoles };
        this.dispatchEnabled = options.dispatchEnabled !== false;
        this.autoApproveReview = options.autoApproveReview === true;
        this.tryAcquireWorkerSlot = options.tryAcquireWorkerSlot;
        this.releaseWorkerSlot = options.releaseWorkerSlot;
        this.onWorkerRunStarted = options.onWorkerRunStarted;
    }

    ingestInbox(source: SchedulerInboxSource, content: string, metadata?: Record<string, unknown>): SchedulerInboxEntry {
        if (!content.trim()) {
            throw new Error('Scheduler inbox content must be a non-empty string.');
        }
        const entry = this.store.appendInboxEntry({ source, content, metadata });
        this.store.appendTaskEvent({
            event_type: 'inbox_received',
            payload: { inbox_id: entry.id, source, content_summary: summarizeTitle(content) },
        });
        return entry;
    }

    async tick(): Promise<SchedulerTickResult> {
        if (tickLocks.has(this.workspacePath)) {
            return {
                processed_inbox: 0,
                dispatched_tasks: [],
                recovered_tasks: [],
                reconciled_tasks: [],
                status: this.getStatus(),
            };
        }

        tickLocks.add(this.workspacePath);
        try {
            TaskManifestManager.reapStaleTasks(this.workspacePath);
            const recovered = this.recoverRunningTasks();
            const processed = await this.processInbox();
            const reconciled = this.reconcileAgentRuns();
            const dispatched = this.dispatchReadyTasks();
            return {
                processed_inbox: processed,
                dispatched_tasks: dispatched,
                recovered_tasks: recovered,
                reconciled_tasks: reconciled,
                status: this.getStatus(),
            };
        } finally {
            tickLocks.delete(this.workspacePath);
        }
    }

    getStatus(): SchedulerStatus {
        const tasks = this.store.listTasks();
        return {
            current: tasks.filter(task => task.status === 'running'),
            ready: tasks.filter(task => task.status === 'ready').sort(compareReadyTasks),
            pending: tasks.filter(task => task.status === 'pending'),
            blocked: tasks.filter(task => task.status === 'blocked'),
            review: tasks.filter(task => task.status === 'review'),
            failed: tasks.filter(task => task.status === 'failed'),
            done: tasks.filter(task => task.status === 'done'),
            cancelled: tasks.filter(task => task.status === 'cancelled'),
            inbox_pending: this.store.listPendingInboxEntries().length,
            agent_runs: this.store.listAgentRuns(),
        };
    }

    async cancelTask(taskId: string, reason: string): Promise<SchedulerTask | undefined> {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        if (task.runtime_run_id) {
            try {
                await cancelRun(this.workspacePath, task.runtime_run_id, reason);
            } catch (error) {
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'runtime_cancel_failed',
                    payload: { runtime_run_id: task.runtime_run_id, error: error instanceof Error ? error.message : String(error) },
                });
            }
        }
        const updated = this.store.updateTask(taskId, {
            status: 'cancelled',
            failure_reason: reason,
            blocking_reason: undefined,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_cancelled',
            payload: { reason },
        });
        return updated;
    }

    private async processInbox(): Promise<number> {
        let processed = 0;
        for (const entry of this.store.listPendingInboxEntries()) {
            try {
                const classification = classifyInboxContent(entry.content);
                const linkedTask = await this.applyInboxClassification(entry, classification);
                this.store.updateInboxEntry(entry.id, {
                    status: 'processed',
                    processed_at: nowIso(),
                    linked_task_id: linkedTask?.id,
                });
                this.store.appendTaskEvent({
                    task_id: linkedTask?.id,
                    event_type: 'inbox_classified',
                    payload: { inbox_id: entry.id, classification },
                });
                processed++;
            } catch (error) {
                this.store.updateInboxEntry(entry.id, {
                    status: 'error',
                    processed_at: nowIso(),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return processed;
    }

    private async applyInboxClassification(entry: SchedulerInboxEntry, classification: InboxClassification): Promise<SchedulerTask | undefined> {
        switch (classification) {
            case 'cancellation':
                return this.cancelCurrentTaskFromInbox(entry);
            case 'priority_change':
            case 'interrupt':
                await this.preemptCurrentTask(entry);
                return this.createTaskFromInbox(entry, 100, classification);
            case 'task_update':
                return this.updateMostRelevantTask(entry);
            case 'clarification':
                return this.createTaskFromInbox(entry, 10, classification, 'research_worker');
            case 'new_task':
            default:
                return this.createTaskFromInbox(entry, 0, classification);
        }
    }

    private createTaskFromInbox(
        entry: SchedulerInboxEntry,
        priority: number,
        classification: InboxClassification,
        forcedCapability?: SchedulerCapability
    ): SchedulerTask {
        const metadata = entry.metadata || {};
        const metadataCapability = typeof metadata.required_capability === 'string' ? metadata.required_capability : undefined;
        const capability = forcedCapability || metadataCapability || inferCapability(entry.content);
        const dependencies = Array.isArray(metadata.depends_on)
            ? metadata.depends_on.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [];
        const status: SchedulerTaskStatus = dependencies.length > 0 ? 'blocked' : 'ready';
        const metadataPriority = typeof metadata.priority === 'number' && Number.isFinite(metadata.priority)
            ? metadata.priority
            : undefined;
        const task = this.store.createTask({
            title: summarizeTitle(entry.content),
            description: entry.content,
            status,
            priority: metadataPriority ?? priority,
            created_from_inbox_id: entry.id,
            required_capability: capability,
            affected_files: inferAffectedFiles(metadata),
            context_summary: typeof metadata.context_summary === 'string' ? metadata.context_summary : undefined,
            acceptance_criteria: typeof metadata.acceptance_criteria === 'string' ? metadata.acceptance_criteria : undefined,
            blocking_reason: dependencies.length > 0 ? `Waiting for dependencies: ${dependencies.join(', ')}` : undefined,
        });
        for (const dependency of dependencies) {
            this.store.addDependency(task.id, dependency);
        }
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_created',
            payload: { inbox_id: entry.id, classification, priority: task.priority, required_capability: capability, depends_on: dependencies },
        });
        return task;
    }

    private updateMostRelevantTask(entry: SchedulerInboxEntry): SchedulerTask {
        const task = this.findCurrentOrLatestOpenTask();
        if (!task) {
            return this.createTaskFromInbox(entry, 25, 'task_update');
        }

        const updatedDescription = `${task.description}\n\n## User update (${entry.received_at})\n${entry.content}`;
        const nextStatus: SchedulerTaskStatus = task.status === 'running' ? 'blocked' : task.status;
        const updated = this.store.updateTask(task.id, {
            description: updatedDescription,
            status: nextStatus,
            blocking_reason: task.status === 'running'
                ? 'Application-layer scheduler blocked this running task after a requirement update; review or requeue before continuing.'
                : task.blocking_reason,
        })!;
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_updated_from_inbox',
            payload: { inbox_id: entry.id, interrupted_running_task: task.status === 'running' },
        });
        return updated;
    }

    private async cancelCurrentTaskFromInbox(entry: SchedulerInboxEntry): Promise<SchedulerTask | undefined> {
        const task = this.findCurrentOrLatestOpenTask();
        if (!task) {
            this.store.appendTaskEvent({
                event_type: 'cancellation_without_target',
                payload: { inbox_id: entry.id, content_summary: summarizeTitle(entry.content) },
            });
            return undefined;
        }
        if (task.runtime_run_id) {
            try {
                await cancelRun(this.workspacePath, task.runtime_run_id, `Cancelled from inbox entry ${entry.id}.`);
            } catch (error) {
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'runtime_cancel_failed',
                    payload: { runtime_run_id: task.runtime_run_id, error: error instanceof Error ? error.message : String(error) },
                });
            }
        }
        const updated = this.store.updateTask(task.id, {
            status: 'cancelled',
            failure_reason: `Cancelled from inbox entry ${entry.id}: ${entry.content}`,
            blocking_reason: undefined,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_cancelled_from_inbox',
            payload: { inbox_id: entry.id, reason: entry.content },
        });
        return updated;
    }

    private async preemptCurrentTask(entry: SchedulerInboxEntry): Promise<void> {
        const current = this.store.listTasks()
            .filter(task => task.status === 'running')
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
        if (!current) return;
        if (current.runtime_run_id) {
            try {
                await cancelRun(this.workspacePath, current.runtime_run_id, `Preempted by inbox entry ${entry.id}.`);
            } catch (error) {
                this.store.appendTaskEvent({
                    task_id: current.id,
                    event_type: 'preempt_cancel_failed',
                    payload: { error: error instanceof Error ? error.message : String(error) },
                });
            }
        }
        this.store.updateTask(current.id, {
            status: 'ready',
            runtime_run_id: undefined,
            blocking_reason: `Application-layer preemption by inbox entry ${entry.id}; queued for retry because Copilot/worker execution cannot be hot-paused by Optimus.`,
        });
        this.store.appendTaskEvent({
            task_id: current.id,
            event_type: 'task_preempted',
            payload: { inbox_id: entry.id, reason: entry.content },
        });
    }

    private dispatchReadyTasks(): string[] {
        if (!this.dispatchEnabled) return [];
        const dispatched: string[] = [];
        let runningCount = this.store.listTasks().filter(task => task.status === 'running').length;

        while (runningCount < this.maxConcurrentWorkers) {
            const candidate = this.selectNextReadyTask();
            if (!candidate) break;
            let acquiredWorkerSlot = false;
            if (this.tryAcquireWorkerSlot) {
                if (!this.tryAcquireWorkerSlot()) {
                    this.store.updateTask(candidate.id, {
                        status: 'blocked',
                        blocking_reason: 'Capacity: HTTP runtime concurrency limit reached; scheduler will retry on a later tick.',
                    });
                    this.store.appendTaskEvent({
                        task_id: candidate.id,
                        event_type: 'task_blocked_by_capacity',
                        payload: { reason: 'HTTP runtime concurrency limit reached.' },
                    });
                    break;
                }
                acquiredWorkerSlot = true;
            }
            try {
                const role = this.resolveRoleForTask(candidate);
                const envelope = startRun({
                    role,
                    workspace_path: this.workspacePath,
                    input: candidate.description,
                    instructions: [
                        `Scheduler task: ${candidate.id}`,
                        'Application-layer scheduler worker: execute only this bounded task and report results through normal runtime output.',
                        `Required capability: ${candidate.required_capability}`,
                        candidate.acceptance_criteria ? `Acceptance criteria: ${candidate.acceptance_criteria}` : '',
                    ].filter(Boolean).join('\n'),
                    context_files: candidate.affected_files,
                    agent_id: candidate.assigned_agent_id,
                });
                if (acquiredWorkerSlot) {
                    this.onWorkerRunStarted?.(envelope.run_id, this.workspacePath);
                }
                const run = this.store.createAgentRun({
                    task_id: candidate.id,
                    agent_type: String(candidate.required_capability),
                    status: 'running',
                    input_summary: summarizeTitle(candidate.description),
                    runtime_run_id: envelope.run_id,
                });
                this.store.updateTask(candidate.id, {
                    runtime_run_id: envelope.run_id,
                    assigned_agent_id: run.id,
                    status: 'running',
                    blocking_reason: undefined,
                });
                this.store.appendTaskEvent({
                    task_id: candidate.id,
                    event_type: 'task_dispatched',
                    payload: {
                        runtime_run_id: envelope.run_id,
                        agent_run_id: run.id,
                        role,
                        dispatch_surface: 'optimus_agent_runtime',
                        app_layer_scheduler: true,
                    },
                });
                dispatched.push(candidate.id);
                runningCount++;
            } catch (error) {
                if (acquiredWorkerSlot) {
                    this.releaseWorkerSlot?.();
                }
                const message = error instanceof Error ? error.message : String(error);
                this.store.updateTask(candidate.id, {
                    status: 'failed',
                    failure_reason: message,
                    blocking_reason: undefined,
                });
                this.store.appendTaskEvent({
                    task_id: candidate.id,
                    event_type: 'task_dispatch_failed',
                    payload: { error: message },
                });
            }
        }

        return dispatched;
    }

    private selectNextReadyTask(): SchedulerTask | undefined {
        this.promotePendingTasks();
        const tasks = this.store.listTasks();
        const ready = tasks.filter(task => task.status === 'ready').sort(compareReadyTasks);
        for (const task of ready) {
            const blockingReason = this.getConflictBlockingReason(task, tasks);
            if (blockingReason) {
                this.store.updateTask(task.id, { status: 'blocked', blocking_reason: blockingReason });
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'task_blocked_by_conflict',
                    payload: { reason: blockingReason },
                });
                continue;
            }
            return this.store.updateTask(task.id, { status: 'running', blocking_reason: undefined });
        }
        return undefined;
    }

    private promotePendingTasks(): void {
        const tasks = this.store.listTasks();
        const terminalDone = new Set(tasks.filter(task => task.status === 'done').map(task => task.id));
        const dependencies = this.store.listDependencies();
        for (const task of tasks) {
            if (task.status !== 'pending' && task.status !== 'blocked') continue;
            if (task.blocking_reason?.startsWith('Conflict:')) {
                if (!this.getConflictBlockingReason(task, tasks)) {
                    this.store.updateTask(task.id, { status: 'ready', blocking_reason: undefined });
                }
                continue;
            }
            if (task.blocking_reason?.startsWith('Capacity:')) {
                this.store.updateTask(task.id, { status: 'ready', blocking_reason: undefined });
                continue;
            }
            const deps = dependencies.filter(dep => dep.task_id === task.id);
            const unresolved = deps.filter(dep => !terminalDone.has(dep.depends_on_task_id));
            if (unresolved.length === 0) {
                this.store.updateTask(task.id, { status: 'ready', blocking_reason: undefined });
            } else if (task.status !== 'blocked') {
                this.store.updateTask(task.id, {
                    status: 'blocked',
                    blocking_reason: `Waiting for dependencies: ${unresolved.map(dep => dep.depends_on_task_id).join(', ')}`,
                });
            }
        }
    }

    private reconcileAgentRuns(): string[] {
        const reconciled: string[] = [];
        for (const task of this.store.listTasks().filter(item => item.status === 'running' || item.status === 'review')) {
            if (task.status === 'review') {
                if (!this.autoApproveReview) {
                    continue;
                }
                const updated = this.store.updateTask(task.id, { status: 'done', blocking_reason: undefined });
                if (updated) {
                    this.store.appendTaskEvent({
                        task_id: task.id,
                        event_type: 'task_review_approved',
                        payload: { review: 'Output reached runtime completion and scheduler review gate accepted it.' },
                    });
                    reconciled.push(task.id);
                }
                continue;
            }

            if (!task.runtime_run_id) continue;
            try {
                const envelope = getRunStatus(this.workspacePath, task.runtime_run_id);
                if (envelope.status === 'completed') {
                    this.store.updateTask(task.id, { status: 'review' });
                    this.finishAgentRun(task, 'completed', typeof envelope.result === 'string' ? envelope.result : undefined);
                    this.store.appendTaskEvent({
                        task_id: task.id,
                        event_type: 'worker_completed',
                        payload: { runtime_run_id: task.runtime_run_id },
                    });
                    reconciled.push(task.id);
                } else if (envelope.status === 'failed') {
                    this.failOrRetryTask(task, envelope.error_message || 'Worker failed.');
                    this.finishAgentRun(task, 'failed', envelope.error_message);
                    reconciled.push(task.id);
                } else if (envelope.status === 'cancelled') {
                    this.store.updateTask(task.id, { status: 'cancelled', failure_reason: envelope.error_message || 'Worker cancelled.' });
                    this.finishAgentRun(task, 'cancelled', envelope.error_message);
                    reconciled.push(task.id);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'worker_status_unavailable',
                    payload: { runtime_run_id: task.runtime_run_id, error: message },
                });
            }
        }
        return reconciled;
    }

    private recoverRunningTasks(): string[] {
        const recovered: string[] = [];
        for (const task of this.store.listTasks().filter(item => item.status === 'running')) {
            if (!task.runtime_run_id) {
                const nextStatus: SchedulerTaskStatus = task.retry_count < task.max_retries ? 'ready' : 'failed';
                this.store.updateTask(task.id, {
                    status: nextStatus,
                    retry_count: task.retry_count + 1,
                    failure_reason: nextStatus === 'failed' ? 'Running task had no runtime_run_id during recovery.' : task.failure_reason,
                });
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'task_recovered_without_runtime',
                    payload: { next_status: nextStatus },
                });
                recovered.push(task.id);
            }
        }
        return recovered;
    }

    private failOrRetryTask(task: SchedulerTask, reason: string): void {
        if (task.retry_count < task.max_retries) {
            this.store.updateTask(task.id, {
                status: 'ready',
                retry_count: task.retry_count + 1,
                failure_reason: reason,
            });
            this.store.appendTaskEvent({
                task_id: task.id,
                event_type: 'task_retry_queued',
                payload: { reason, retry_count: task.retry_count + 1 },
            });
            return;
        }
        this.store.updateTask(task.id, { status: 'failed', failure_reason: reason });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_failed',
            payload: { reason },
        });
    }

    private finishAgentRun(task: SchedulerTask, status: SchedulerAgentRun['status'], outputSummary?: string): void {
        const run = this.store.listAgentRuns().find(item => item.task_id === task.id && item.runtime_run_id === task.runtime_run_id);
        if (!run) return;
        this.store.updateAgentRun(run.id, {
            status,
            output_summary: outputSummary,
            finished_at: nowIso(),
        });
    }

    private findCurrentOrLatestOpenTask(): SchedulerTask | undefined {
        const tasks = this.store.listTasks()
            .filter(task => !['done', 'failed', 'cancelled'].includes(task.status))
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return tasks.find(task => task.status === 'running') || tasks[0];
    }

    private resolveRoleForTask(task: SchedulerTask): string {
        if (task.required_capability === 'research_worker') return this.workerRoles.research_worker;
        if (task.required_capability === 'coding_worker') return this.workerRoles.coding_worker;
        return String(task.required_capability);
    }

    private getConflictBlockingReason(task: SchedulerTask, allTasks: SchedulerTask[]): string | undefined {
        const running = allTasks.filter(candidate => candidate.id !== task.id && candidate.status === 'running');
        if (task.required_capability === 'coding_worker' && task.affected_files.length === 0) {
            const runningCoding = running.find(candidate => candidate.required_capability === 'coding_worker');
            if (runningCoding) return `Conflict: unknown affected files wait for coding task ${runningCoding.id}.`;
        }
        for (const active of running) {
            if (active.required_capability === 'coding_worker' && active.affected_files.length === 0 && task.required_capability === 'coding_worker') {
                return `Conflict: coding task ${active.id} has unknown affected files.`;
            }
            const overlap = task.affected_files.find(filePath => active.affected_files.includes(filePath));
            if (overlap) return `Conflict: ${overlap} is locked by task ${active.id}.`;
        }
        return undefined;
    }
}

export function getMasterScheduler(workspacePath: string, options?: SchedulerOptions): MasterScheduler {
    return new MasterScheduler(workspacePath, options);
}

export function startMasterSchedulerLoop(workspacePath: string, options: SchedulerOptions & { intervalMs?: number } = {}): void {
    if (schedulerLoops.has(workspacePath)) return;
    const scheduler = new MasterScheduler(workspacePath, options);
    const interval = setInterval(() => {
        scheduler.tick().catch(error => {
            console.error(`[Scheduler] tick failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }, Math.max(1000, options.intervalMs ?? 5000));
    if (typeof interval.unref === 'function') interval.unref();
    schedulerLoops.set(workspacePath, interval);
}

function compareReadyTasks(a: SchedulerTask, b: SchedulerTask): number {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.created_at.localeCompare(b.created_at);
}
