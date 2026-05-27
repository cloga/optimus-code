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
import {
    buildSchedulerContextPacket,
    formatSchedulerContextForPrompt,
} from './schedulerContext';
import { buildMemoryEntry } from '../managers/MemoryManager';
import { detectWorktreeContext } from '../utils/worktree';
import fs from 'fs';
import path from 'path';

export const MASTER_SCHEDULER_PROTOCOL = [
    'Application-layer scheduler: this does not intercept or replace Copilot core turn scheduling.',
    'For task-bearing user feedback, persist the message with scheduler_ingest before deciding whether to queue, update, cancel, prioritize, or dispatch work.',
    'Treat scheduler tasks and task_events as durable state; do not rely on transient LLM context as the source of truth.',
].join(' ');

export type InboxClassification =
    | 'new_task'
    | 'task_update'
    | 'cancellation'
    | 'pause'
    | 'priority_change'
    | 'clarification'
    | 'interrupt'
    | 'checkpoint'
    | 'handoff'
    | 'yield';

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
    paused: SchedulerTask[];
    blocked: SchedulerTask[];
    review: SchedulerTask[];
    failed: SchedulerTask[];
    done: SchedulerTask[];
    cancelled: SchedulerTask[];
    inbox_pending: number;
    agent_runs: SchedulerAgentRun[];
}

export interface SchedulerTaskDetails {
    task?: SchedulerTask;
    events: ReturnType<SchedulerStore['listTaskEvents']>;
    agent_runs: SchedulerAgentRun[];
}

export interface SchedulerReassignOptions {
    required_capability?: SchedulerCapability;
    assigned_agent_id?: string;
    reason?: string;
}

export interface SchedulerCheckpoint {
    summary: string;
    current_focus?: string;
    next_steps?: string;
    open_questions?: string[];
    affected_files?: string[];
    handoff_recommended?: boolean;
}

export interface SchedulerHandoffOptions {
    summary: string;
    required_capability?: SchedulerCapability;
    assigned_agent_id?: string;
    acceptance_criteria?: string;
    context_summary?: string;
    affected_files?: string[];
    cancel_current_run?: boolean;
    reason?: string;
}

export interface SchedulerYieldOptions {
    reason: string;
    checkpoint?: SchedulerCheckpoint;
}

export interface SchedulerResumeContext {
    task?: SchedulerTask;
    context?: string;
    suggested_next_action: 'continue_as_master' | 'handoff_to_sub_agent' | 'tick_scheduler' | 'ask_user' | 'task_not_found';
}

export interface SchedulerMemoryPromotion {
    level: 'project' | 'role';
    category: string;
    tags: string[];
    content: string;
    role?: string;
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
    if (/(取消|停掉|cancel|abort)/i.test(content)) return 'cancellation';
    if (/(暂停|pause)/i.test(content)) return 'pause';
    if (/(先做|优先|插队|do this first|priority|first)/i.test(content)) return 'priority_change';
    if (/(交给|转交|handoff|hand off|delegate to sub-agent|sub-agent)/i.test(content)) return 'handoff';
    if (/(checkpoint|保存进度|记录进度)/i.test(content)) return 'checkpoint';
    if (/(先这样|切走|yield|稍后继续)/i.test(content)) return 'yield';
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
            paused: tasks.filter(task => task.status === 'paused'),
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

    getTaskDetails(taskId: string): SchedulerTaskDetails {
        return {
            task: this.store.getTask(taskId),
            events: this.store.listTaskEvents(taskId),
            agent_runs: this.store.listAgentRuns().filter(run => run.task_id === taskId),
        };
    }

    getResumeContext(taskId: string): SchedulerResumeContext {
        const packet = buildSchedulerContextPacket(this.workspacePath, taskId);
        if (!packet) {
            return { suggested_next_action: 'task_not_found' };
        }
        const context = formatSchedulerContextForPrompt(packet);
        let suggested: SchedulerResumeContext['suggested_next_action'] = 'continue_as_master';
        if (packet.task.status === 'ready') suggested = 'tick_scheduler';
        if (packet.latest_handoff) suggested = 'handoff_to_sub_agent';
        if (packet.task.status === 'blocked' && packet.task.blocking_reason) suggested = 'ask_user';
        return { task: packet.task, context, suggested_next_action: suggested };
    }

    promoteTaskMemory(taskId: string, promotion: SchedulerMemoryPromotion): SchedulerTask | undefined {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        const memoryFile = this.getPromotionMemoryPath(promotion.level, promotion.role || task.required_capability);
        fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
        const entry = buildMemoryEntry({
            level: promotion.level,
            category: promotion.category,
            tags: promotion.tags,
            content: promotion.content,
            author: 'scheduler-memory-bridge',
        });
        fs.appendFileSync(memoryFile, entry, 'utf8');
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_memory_promoted',
            payload: {
                level: promotion.level,
                category: promotion.category,
                tags: promotion.tags,
                role: promotion.role,
                memory_file: memoryFile,
            },
        });
        return task;
    }

    private getPromotionMemoryPath(level: 'project' | 'role', role: string): string {
        const ctx = detectWorktreeContext(this.workspacePath);
        const memoryRoot = path.join(ctx.mainRoot, '.optimus', 'memory');
        if (level === 'project') {
            return path.join(memoryRoot, 'continuous-memory.md');
        }
        const sanitizedRole = role.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100);
        if (!sanitizedRole) {
            throw new Error(`Invalid role name for memory promotion: '${role}'`);
        }
        return path.join(memoryRoot, 'roles', `${sanitizedRole}.md`);
    }

    checkpointTask(taskId: string, checkpoint: SchedulerCheckpoint): SchedulerTask | undefined {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        const affectedFiles = checkpoint.affected_files?.filter(filePath => filePath.trim().length > 0);
        const updated = this.store.updateTask(taskId, {
            context_summary: checkpoint.summary || task.context_summary,
            affected_files: affectedFiles && affectedFiles.length > 0 ? affectedFiles : task.affected_files,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_checkpointed',
            payload: {
                summary: checkpoint.summary,
                current_focus: checkpoint.current_focus,
                next_steps: checkpoint.next_steps,
                open_questions: checkpoint.open_questions || [],
                affected_files: affectedFiles || [],
                handoff_recommended: checkpoint.handoff_recommended === true,
            },
        });
        return updated;
    }

    async handoffTask(taskId: string, options: SchedulerHandoffOptions): Promise<SchedulerTask | undefined> {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        if (['done', 'failed', 'cancelled'].includes(task.status)) {
            this.store.appendTaskEvent({
                task_id: task.id,
                event_type: 'task_handoff_ignored',
                payload: { reason: options.reason, current_status: task.status, summary: options.summary },
            });
            return task;
        }

        let cancelledCurrentRun = false;
        if (task.runtime_run_id && options.cancel_current_run === true) {
            try {
                await cancelRun(this.workspacePath, task.runtime_run_id, options.reason || 'Cancelled for scheduler handoff.');
                cancelledCurrentRun = true;
            } catch (error) {
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'handoff_runtime_cancel_failed',
                    payload: { runtime_run_id: task.runtime_run_id, error: error instanceof Error ? error.message : String(error) },
                });
            }
        }

        const nextStatus: SchedulerTaskStatus = task.status === 'running' && !cancelledCurrentRun
            ? 'running'
            : task.status === 'paused'
                ? 'paused'
                : 'ready';
        const nextAffectedFiles = options.affected_files && options.affected_files.length > 0
            ? options.affected_files
            : task.affected_files;
        const updated = this.store.updateTask(taskId, {
            required_capability: options.required_capability || task.required_capability,
            assigned_agent_id: options.assigned_agent_id ?? task.assigned_agent_id,
            acceptance_criteria: options.acceptance_criteria ?? task.acceptance_criteria,
            context_summary: options.context_summary || options.summary || task.context_summary,
            affected_files: nextAffectedFiles,
            status: nextStatus,
            runtime_run_id: cancelledCurrentRun ? undefined : task.runtime_run_id,
            blocking_reason: nextStatus === 'ready' ? undefined : task.blocking_reason,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_handed_off',
            payload: {
                summary: options.summary,
                reason: options.reason,
                required_capability: options.required_capability || task.required_capability,
                assigned_agent_id: options.assigned_agent_id ?? task.assigned_agent_id,
                cancel_current_run: options.cancel_current_run === true,
                cancelled_current_run: cancelledCurrentRun,
                previous_status: task.status,
                next_status: nextStatus,
            },
        });
        return updated;
    }

    yieldTask(taskId: string, options: SchedulerYieldOptions): SchedulerTask | undefined {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        let updated: SchedulerTask | undefined = task;
        if (options.checkpoint) {
            updated = this.checkpointTask(taskId, options.checkpoint);
        }
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'master_yielded',
            payload: {
                reason: options.reason,
                checkpoint_recorded: !!options.checkpoint,
                status_preserved: task.status,
            },
        });
        return updated;
    }

    async pauseTask(taskId: string, reason = 'Paused by scheduler request.'): Promise<SchedulerTask | undefined> {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        if (['done', 'failed', 'cancelled'].includes(task.status)) {
            this.store.appendTaskEvent({
                task_id: task.id,
                event_type: 'task_pause_ignored',
                payload: { reason, current_status: task.status },
            });
            return task;
        }
        if (task.runtime_run_id) {
            try {
                await cancelRun(this.workspacePath, task.runtime_run_id, reason);
            } catch (error) {
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'pause_runtime_cancel_failed',
                    payload: { runtime_run_id: task.runtime_run_id, error: error instanceof Error ? error.message : String(error) },
                });
            }
        }
        const updated = this.store.updateTask(taskId, {
            status: 'paused',
            runtime_run_id: undefined,
            blocking_reason: reason,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_paused',
            payload: { reason, previous_status: task.status },
        });
        return updated;
    }

    resumeTask(taskId: string, reason = 'Resumed by scheduler request.'): SchedulerTask | undefined {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        if (task.status !== 'paused') {
            this.store.appendTaskEvent({
                task_id: task.id,
                event_type: 'task_resume_ignored',
                payload: { reason, current_status: task.status },
            });
            return task;
        }
        const updated = this.store.updateTask(taskId, {
            status: 'ready',
            blocking_reason: undefined,
            failure_reason: undefined,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_resumed',
            payload: { reason },
        });
        return updated;
    }

    async reassignTask(taskId: string, options: SchedulerReassignOptions): Promise<SchedulerTask | undefined> {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        if (['done', 'failed', 'cancelled'].includes(task.status)) {
            this.store.appendTaskEvent({
                task_id: task.id,
                event_type: 'task_reassign_ignored',
                payload: { reason: options.reason, current_status: task.status },
            });
            return task;
        }
        if (task.runtime_run_id) {
            try {
                await cancelRun(this.workspacePath, task.runtime_run_id, options.reason || 'Reassigned by scheduler request.');
            } catch (error) {
                this.store.appendTaskEvent({
                    task_id: task.id,
                    event_type: 'reassign_runtime_cancel_failed',
                    payload: { runtime_run_id: task.runtime_run_id, error: error instanceof Error ? error.message : String(error) },
                });
            }
        }
        const nextCapability = options.required_capability || task.required_capability;
        const updated = this.store.updateTask(taskId, {
            required_capability: nextCapability,
            assigned_agent_id: options.assigned_agent_id ?? task.assigned_agent_id,
            status: task.status === 'paused' ? 'paused' : 'ready',
            runtime_run_id: undefined,
            blocking_reason: task.status === 'paused' ? task.blocking_reason : undefined,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_reassigned',
            payload: {
                reason: options.reason,
                previous_capability: task.required_capability,
                required_capability: nextCapability,
                assigned_agent_id: options.assigned_agent_id ?? task.assigned_agent_id,
                previous_status: task.status,
            },
        });
        return updated;
    }

    private async processInbox(): Promise<number> {
        let processed = 0;
        for (const entry of this.store.listPendingInboxEntries()) {
            try {
                const classification = this.getInboxClassification(entry);
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
        const metadata = entry.metadata || {};
        const targetTaskId = typeof metadata.target_task_id === 'string' ? metadata.target_task_id : undefined;
        const action = typeof metadata.action === 'string' ? metadata.action.toLowerCase() : undefined;
        if (targetTaskId) {
            if (action === 'pause') return this.pauseTask(targetTaskId, entry.content);
            if (action === 'resume') return this.resumeTask(targetTaskId, entry.content);
            if (action === 'checkpoint') {
                return this.checkpointTask(targetTaskId, this.buildCheckpointFromInbox(entry));
            }
            if (action === 'handoff') {
                return this.handoffTask(targetTaskId, this.buildHandoffFromInbox(entry));
            }
            if (action === 'yield') {
                return this.yieldTask(targetTaskId, {
                    reason: entry.content,
                    checkpoint: this.buildCheckpointFromInbox(entry),
                });
            }
            if (action === 'reassign') {
                return this.reassignTask(targetTaskId, {
                    required_capability: typeof metadata.required_capability === 'string' ? metadata.required_capability : undefined,
                    assigned_agent_id: typeof metadata.assigned_agent_id === 'string' ? metadata.assigned_agent_id : undefined,
                    reason: entry.content,
                });
            }
        }
        if (targetTaskId) {
            switch (classification) {
                case 'cancellation':
                    return this.cancelTask(targetTaskId, entry.content);
                case 'pause':
                    return this.pauseTask(targetTaskId, entry.content);
                case 'interrupt':
                    return this.bumpTaskPriority(targetTaskId, entry);
                case 'priority_change':
                    return this.bumpTaskPriority(targetTaskId, entry);
                case 'checkpoint':
                    return this.checkpointTask(targetTaskId, this.buildCheckpointFromInbox(entry));
                case 'handoff':
                    return this.handoffTask(targetTaskId, this.buildHandoffFromInbox(entry));
                case 'yield':
                    return this.yieldTask(targetTaskId, { reason: entry.content, checkpoint: this.buildCheckpointFromInbox(entry) });
                case 'task_update':
                    return this.updateTaskFromInbox(targetTaskId, entry);
                case 'clarification':
                case 'new_task':
                default:
                    return this.createTaskFromInbox(entry, 0, classification);
            }
        }

        switch (classification) {
            case 'cancellation':
                return this.cancelCurrentTaskFromInbox(entry);
            case 'priority_change':
            case 'interrupt':
                return this.createTaskFromInbox(entry, 100, classification);
            case 'pause':
                return this.pauseCurrentTaskFromInbox(entry);
            case 'checkpoint':
                return this.checkpointMostRelevantTask(entry);
            case 'handoff':
                return this.handoffMostRelevantTask(entry);
            case 'yield':
                return this.yieldMostRelevantTask(entry);
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
        return this.updateTaskFromInbox(task.id, entry)!;
    }

    private updateTaskFromInbox(taskId: string, entry: SchedulerInboxEntry): SchedulerTask | undefined {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;

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

    private bumpTaskPriority(taskId: string, entry: SchedulerInboxEntry): SchedulerTask | undefined {
        const task = this.store.getTask(taskId);
        if (!task) return undefined;
        const metadataPriority = typeof entry.metadata?.priority === 'number' && Number.isFinite(entry.metadata.priority)
            ? entry.metadata.priority
            : undefined;
        const updated = this.store.updateTask(taskId, {
            priority: metadataPriority ?? Math.max(task.priority, 100),
            status: task.status === 'paused' ? 'paused' : 'ready',
            blocking_reason: task.status === 'paused' ? task.blocking_reason : undefined,
        });
        this.store.appendTaskEvent({
            task_id: task.id,
            event_type: 'task_priority_changed_from_inbox',
            payload: { inbox_id: entry.id, priority: updated?.priority },
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

    private async pauseCurrentTaskFromInbox(entry: SchedulerInboxEntry): Promise<SchedulerTask | undefined> {
        const task = this.findCurrentOrLatestOpenTask();
        if (!task) {
            this.store.appendTaskEvent({
                event_type: 'pause_without_target',
                payload: { inbox_id: entry.id, content_summary: summarizeTitle(entry.content) },
            });
            return undefined;
        }
        return this.pauseTask(task.id, entry.content);
    }

    private checkpointMostRelevantTask(entry: SchedulerInboxEntry): SchedulerTask {
        const task = this.findCurrentOrLatestOpenTask();
        if (!task) {
            return this.createTaskFromInbox(entry, 10, 'checkpoint');
        }
        return this.checkpointTask(task.id, this.buildCheckpointFromInbox(entry))!;
    }

    private async handoffMostRelevantTask(entry: SchedulerInboxEntry): Promise<SchedulerTask> {
        const task = this.findCurrentOrLatestOpenTask();
        if (!task) {
            return this.createTaskFromInbox(entry, 50, 'handoff');
        }
        return (await this.handoffTask(task.id, this.buildHandoffFromInbox(entry)))!;
    }

    private yieldMostRelevantTask(entry: SchedulerInboxEntry): SchedulerTask {
        const task = this.findCurrentOrLatestOpenTask();
        if (!task) {
            return this.createTaskFromInbox(entry, 10, 'yield');
        }
        return this.yieldTask(task.id, { reason: entry.content, checkpoint: this.buildCheckpointFromInbox(entry) })!;
    }

    private buildCheckpointFromInbox(entry: SchedulerInboxEntry): SchedulerCheckpoint {
        const metadata = entry.metadata || {};
        const openQuestions = Array.isArray(metadata.open_questions)
            ? metadata.open_questions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : undefined;
        return {
            summary: typeof metadata.summary === 'string' ? metadata.summary : entry.content,
            current_focus: typeof metadata.current_focus === 'string' ? metadata.current_focus : undefined,
            next_steps: typeof metadata.next_steps === 'string' ? metadata.next_steps : undefined,
            open_questions: openQuestions,
            affected_files: inferAffectedFiles(metadata),
            handoff_recommended: metadata.handoff_recommended === true,
        };
    }

    private buildHandoffFromInbox(entry: SchedulerInboxEntry): SchedulerHandoffOptions {
        const metadata = entry.metadata || {};
        return {
            summary: typeof metadata.summary === 'string' ? metadata.summary : entry.content,
            required_capability: typeof metadata.required_capability === 'string' ? metadata.required_capability : undefined,
            assigned_agent_id: typeof metadata.assigned_agent_id === 'string' ? metadata.assigned_agent_id : undefined,
            acceptance_criteria: typeof metadata.acceptance_criteria === 'string' ? metadata.acceptance_criteria : undefined,
            context_summary: typeof metadata.context_summary === 'string' ? metadata.context_summary : undefined,
            affected_files: inferAffectedFiles(metadata),
            cancel_current_run: metadata.cancel_current_run === true,
            reason: entry.content,
        };
    }

    private getInboxClassification(entry: SchedulerInboxEntry): InboxClassification {
        const action = typeof entry.metadata?.action === 'string' ? entry.metadata.action.toLowerCase() : undefined;
        if (action === 'cancel') return 'cancellation';
        if (action === 'pause') return 'pause';
        if (action === 'interrupt') return 'interrupt';
        if (action === 'priority' || action === 'prioritize') return 'priority_change';
        if (action === 'update') return 'task_update';
        if (action === 'checkpoint') return 'checkpoint';
        if (action === 'handoff') return 'handoff';
        if (action === 'yield') return 'yield';
        if (action === 'resume' || action === 'reassign') return 'task_update';
        return classifyInboxContent(entry.content);
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
                const schedulerContextPacket = buildSchedulerContextPacket(this.workspacePath, candidate.id);
                const schedulerContext = schedulerContextPacket
                    ? formatSchedulerContextForPrompt(schedulerContextPacket)
                    : undefined;
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
                    scheduler_context: schedulerContext,
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
