import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveOptimusPath } from '../utils/worktree';

export type SchedulerInboxSource = 'user' | 'system' | 'worker' | 'ci';
export type SchedulerInboxStatus = 'pending' | 'processed' | 'ignored' | 'error';
export type SchedulerTaskStatus =
    | 'pending'
    | 'ready'
    | 'running'
    | 'blocked'
    | 'review'
    | 'failed'
    | 'done'
    | 'cancelled';
export type SchedulerCapability = 'research_worker' | 'coding_worker' | string;
export type SchedulerAgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SchedulerInboxEntry {
    id: string;
    source: SchedulerInboxSource;
    content: string;
    received_at: string;
    processed_at?: string;
    status: SchedulerInboxStatus;
    linked_task_id?: string;
    error?: string;
    metadata?: Record<string, unknown>;
}

export interface SchedulerTask {
    id: string;
    title: string;
    description: string;
    status: SchedulerTaskStatus;
    priority: number;
    parent_task_id?: string;
    created_from_inbox_id?: string;
    assigned_agent_id?: string;
    required_capability: SchedulerCapability;
    affected_files: string[];
    context_summary?: string;
    acceptance_criteria?: string;
    failure_reason?: string;
    blocking_reason?: string;
    runtime_run_id?: string;
    retry_count: number;
    max_retries: number;
    created_at: string;
    updated_at: string;
}

export interface SchedulerTaskDependency {
    task_id: string;
    depends_on_task_id: string;
}

export interface SchedulerTaskEvent {
    id: string;
    task_id?: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
}

export interface SchedulerAgentRun {
    id: string;
    task_id: string;
    agent_type: string;
    status: SchedulerAgentRunStatus;
    input_summary: string;
    output_summary?: string;
    runtime_run_id?: string;
    started_at: string;
    finished_at?: string;
}

export interface SchedulerSnapshot {
    inbox_entries: SchedulerInboxEntry[];
    tasks: SchedulerTask[];
    task_dependencies: SchedulerTaskDependency[];
    task_events: SchedulerTaskEvent[];
    agent_runs: SchedulerAgentRun[];
}

function nowIso(): string {
    return new Date().toISOString();
}

export function createSchedulerId(prefix: string): string {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
}

function safeFileName(id: string): string {
    return id.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    try {
        fs.renameSync(tempPath, filePath);
    } catch (error: any) {
        if (error && (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')) {
            try { fs.unlinkSync(filePath); } catch (unlinkError: any) {
                if (unlinkError?.code !== 'ENOENT') throw unlinkError;
            }
            fs.renameSync(tempPath, filePath);
            return;
        }
        throw error;
    }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function appendJsonLine(filePath: string, value: unknown): void {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJsonLines<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line) as T);
}

export class SchedulerStore {
    constructor(private readonly workspacePath: string) {}

    get rootDir(): string {
        return resolveOptimusPath(this.workspacePath, 'state', 'scheduler');
    }

    private get inboxPath(): string {
        return path.join(this.rootDir, 'inbox_entries.jsonl');
    }

    private get eventsPath(): string {
        return path.join(this.rootDir, 'task_events.jsonl');
    }

    private get tasksDir(): string {
        return path.join(this.rootDir, 'tasks');
    }

    private get agentRunsDir(): string {
        return path.join(this.rootDir, 'agent_runs');
    }

    private get dependenciesPath(): string {
        return path.join(this.rootDir, 'task_dependencies.json');
    }

    ensure(): void {
        ensureDir(this.rootDir);
        ensureDir(this.tasksDir);
        ensureDir(this.agentRunsDir);
    }

    appendInboxEntry(entry: Omit<SchedulerInboxEntry, 'id' | 'received_at' | 'status'> & Partial<Pick<SchedulerInboxEntry, 'id' | 'received_at' | 'status'>>): SchedulerInboxEntry {
        this.ensure();
        const fullEntry: SchedulerInboxEntry = {
            id: entry.id || createSchedulerId('inbox'),
            source: entry.source,
            content: entry.content,
            received_at: entry.received_at || nowIso(),
            status: entry.status || 'pending',
            metadata: entry.metadata,
            linked_task_id: entry.linked_task_id,
            processed_at: entry.processed_at,
            error: entry.error,
        };
        appendJsonLine(this.inboxPath, fullEntry);
        return fullEntry;
    }

    listInboxEntries(): SchedulerInboxEntry[] {
        return readJsonLines<SchedulerInboxEntry>(this.inboxPath);
    }

    listPendingInboxEntries(): SchedulerInboxEntry[] {
        return this.listInboxEntries().filter(entry => entry.status === 'pending');
    }

    updateInboxEntry(id: string, updates: Partial<SchedulerInboxEntry>): SchedulerInboxEntry | undefined {
        const entries = this.listInboxEntries();
        const index = entries.findIndex(entry => entry.id === id);
        if (index === -1) return undefined;
        const updated = { ...entries[index], ...updates };
        entries[index] = updated;
        this.rewriteJsonLines(this.inboxPath, entries);
        return updated;
    }

    createTask(task: Omit<SchedulerTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'retry_count' | 'max_retries'> & Partial<Pick<SchedulerTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'retry_count' | 'max_retries'>>): SchedulerTask {
        const timestamp = nowIso();
        const fullTask: SchedulerTask = {
            id: task.id || createSchedulerId('task'),
            title: task.title,
            description: task.description,
            status: task.status || 'pending',
            priority: task.priority,
            parent_task_id: task.parent_task_id,
            created_from_inbox_id: task.created_from_inbox_id,
            assigned_agent_id: task.assigned_agent_id,
            required_capability: task.required_capability,
            affected_files: task.affected_files || [],
            context_summary: task.context_summary,
            acceptance_criteria: task.acceptance_criteria,
            failure_reason: task.failure_reason,
            blocking_reason: task.blocking_reason,
            runtime_run_id: task.runtime_run_id,
            retry_count: task.retry_count || 0,
            max_retries: task.max_retries ?? 1,
            created_at: task.created_at || timestamp,
            updated_at: task.updated_at || timestamp,
        };
        this.saveTask(fullTask);
        return fullTask;
    }

    saveTask(task: SchedulerTask): void {
        this.ensure();
        writeJsonAtomic(this.taskPath(task.id), task);
    }

    getTask(taskId: string): SchedulerTask | undefined {
        const filePath = this.taskPath(taskId);
        return readJsonFile<SchedulerTask | undefined>(filePath, undefined);
    }

    updateTask(taskId: string, updates: Partial<SchedulerTask>): SchedulerTask | undefined {
        const task = this.getTask(taskId);
        if (!task) return undefined;
        const updated: SchedulerTask = { ...task, ...updates, updated_at: nowIso() };
        this.saveTask(updated);
        return updated;
    }

    listTasks(): SchedulerTask[] {
        this.ensure();
        return fs.readdirSync(this.tasksDir)
            .filter(fileName => fileName.endsWith('.json'))
            .map(fileName => readJsonFile<SchedulerTask>(path.join(this.tasksDir, fileName), undefined as any))
            .filter((task): task is SchedulerTask => Boolean(task))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    listDependencies(): SchedulerTaskDependency[] {
        return readJsonFile<SchedulerTaskDependency[]>(this.dependenciesPath, []);
    }

    saveDependencies(dependencies: SchedulerTaskDependency[]): void {
        writeJsonAtomic(this.dependenciesPath, dependencies);
    }

    addDependency(taskId: string, dependsOnTaskId: string): void {
        const dependencies = this.listDependencies();
        if (dependencies.some(dep => dep.task_id === taskId && dep.depends_on_task_id === dependsOnTaskId)) return;
        dependencies.push({ task_id: taskId, depends_on_task_id: dependsOnTaskId });
        this.saveDependencies(dependencies);
    }

    appendTaskEvent(event: Omit<SchedulerTaskEvent, 'id' | 'created_at'> & Partial<Pick<SchedulerTaskEvent, 'id' | 'created_at'>>): SchedulerTaskEvent {
        this.ensure();
        const fullEvent: SchedulerTaskEvent = {
            id: event.id || createSchedulerId('event'),
            task_id: event.task_id,
            event_type: event.event_type,
            payload: event.payload,
            created_at: event.created_at || nowIso(),
        };
        appendJsonLine(this.eventsPath, fullEvent);
        return fullEvent;
    }

    listTaskEvents(taskId?: string): SchedulerTaskEvent[] {
        const events = readJsonLines<SchedulerTaskEvent>(this.eventsPath);
        return taskId ? events.filter(event => event.task_id === taskId) : events;
    }

    createAgentRun(run: Omit<SchedulerAgentRun, 'id' | 'started_at' | 'status'> & Partial<Pick<SchedulerAgentRun, 'id' | 'started_at' | 'status'>>): SchedulerAgentRun {
        const fullRun: SchedulerAgentRun = {
            id: run.id || createSchedulerId('agent_run'),
            task_id: run.task_id,
            agent_type: run.agent_type,
            status: run.status || 'queued',
            input_summary: run.input_summary,
            output_summary: run.output_summary,
            runtime_run_id: run.runtime_run_id,
            started_at: run.started_at || nowIso(),
            finished_at: run.finished_at,
        };
        this.saveAgentRun(fullRun);
        return fullRun;
    }

    saveAgentRun(run: SchedulerAgentRun): void {
        this.ensure();
        writeJsonAtomic(this.agentRunPath(run.id), run);
    }

    getAgentRun(runId: string): SchedulerAgentRun | undefined {
        return readJsonFile<SchedulerAgentRun | undefined>(this.agentRunPath(runId), undefined);
    }

    updateAgentRun(runId: string, updates: Partial<SchedulerAgentRun>): SchedulerAgentRun | undefined {
        const run = this.getAgentRun(runId);
        if (!run) return undefined;
        const updated = { ...run, ...updates };
        this.saveAgentRun(updated);
        return updated;
    }

    listAgentRuns(): SchedulerAgentRun[] {
        this.ensure();
        return fs.readdirSync(this.agentRunsDir)
            .filter(fileName => fileName.endsWith('.json'))
            .map(fileName => readJsonFile<SchedulerAgentRun>(path.join(this.agentRunsDir, fileName), undefined as any))
            .filter((run): run is SchedulerAgentRun => Boolean(run))
            .sort((a, b) => a.started_at.localeCompare(b.started_at));
    }

    snapshot(): SchedulerSnapshot {
        return {
            inbox_entries: this.listInboxEntries(),
            tasks: this.listTasks(),
            task_dependencies: this.listDependencies(),
            task_events: this.listTaskEvents(),
            agent_runs: this.listAgentRuns(),
        };
    }

    private taskPath(taskId: string): string {
        return path.join(this.tasksDir, `${safeFileName(taskId)}.json`);
    }

    private agentRunPath(runId: string): string {
        return path.join(this.agentRunsDir, `${safeFileName(runId)}.json`);
    }

    private rewriteJsonLines(filePath: string, values: unknown[]): void {
        ensureDir(path.dirname(filePath));
        const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tempPath, values.map(value => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : ''), 'utf8');
        try {
            fs.renameSync(tempPath, filePath);
        } catch {
            try { fs.unlinkSync(filePath); } catch (error: any) {
                if (error?.code !== 'ENOENT') throw error;
            }
            fs.renameSync(tempPath, filePath);
        }
    }
}
