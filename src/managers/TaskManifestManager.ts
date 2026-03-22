import * as fs from 'fs';
import * as path from 'path';
import { resolveOptimusPath } from '../utils/worktree';
// Multiple agents (heartbeats, status updates, task creation) can race on the same file.
let manifestMutex: Promise<void> = Promise.resolve();

function withManifestLock<T>(fn: () => T): Promise<T> {
    let release: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const prev = manifestMutex;
    manifestMutex = next;
    return prev.then(() => {
        try {
            const result = fn();
            return result;
        } finally {
            release!();
        }
    });
}

export interface TaskRecord {
    taskId: string;
    type: 'delegate_task' | 'dispatch_council';
    status: 'pending' | 'blocked' | 'running' | 'completed' | 'partial' | 'verified' | 'failed' | 'degraded' | 'awaiting_input' | 'expired' | 'cancelled';
    role?: string;
    roles?: string[];
    task_description?: string;
    context_files?: string[];
    proposal_path?: string;
    output_path?: string;
    pid?: number;
    error_message?: string;
    github_issue_number?: number;
    parent_issue_number?: number;
    startTime: number;
    heartbeatTime: number;
    workspacePath: string;
    role_description?: string;
    role_engine?: string;
    role_model?: string;
    required_skills?: string[];
    delegation_depth?: number;
    role_descriptions?: Record<string, string>;
    agent_id?: string;
    // Pause/resume fields (agent pause/resume mechanism)
    pause_question?: string;
    pause_context?: string;
    pause_timestamp?: number;
    pause_github_comment_id?: number;
    pause_count?: number;
    human_answer?: string;
    max_pause_timeout_ms?: number;
    resume_task_id?: string;
    // Task dependency fields
    depends_on?: string[];   // Declared prerequisite task IDs
    blocked_by?: string[];   // Runtime: unresolved prerequisite task IDs
    // Configurable heartbeat timeout (overrides TIMEOUT_MS default per-task)
    heartbeat_timeout_ms?: number;
    resolved_engine?: string;
    resolved_model?: string;
    session_id?: string;
    completed_at?: number;
    cancelled_at?: number;
    cancellation_reason?: string;
    runtime_run_id?: string;
    runtime_trace_id?: string;
    runtime_skill?: string;
}

export class TaskManifestManager {
    static getManifestPath(workspacePath: string): string {
        return resolveOptimusPath(workspacePath, 'state', 'task-manifest.json');
    }

    static loadManifest(workspacePath: string): Record<string, TaskRecord> {
        const manifestPath = this.getManifestPath(workspacePath);
        if (!fs.existsSync(manifestPath)) {
            return {};
        }
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e: any) {
            console.error(`[TaskManifest] Warning: failed to parse task manifest at ${manifestPath}: ${e.message}. Returning empty manifest — existing tasks may appear missing.`);
            return {};
        }
    }

    static saveManifest(workspacePath: string, manifest: Record<string, TaskRecord>) {
        const manifestPath = this.getManifestPath(workspacePath);
        const tempPath = `${manifestPath}.tmp`;
        const dir = path.dirname(manifestPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf8');
        fs.renameSync(tempPath, manifestPath);
    }

    static createTask(workspacePath: string, record: Omit<TaskRecord, 'status' | 'startTime' | 'heartbeatTime'>): TaskRecord {
        const fullRecord: TaskRecord = {
            ...record,
            status: 'pending',
            startTime: Date.now(),
            heartbeatTime: Date.now()
        };
        // Synchronous write — callers (meta-cron, delegate_task) spawn child processes
        // immediately after createTask returns, so the manifest MUST be on disk before
        // this function returns. The async withManifestLock caused a race condition where
        // child processes couldn't find their task entry (Issue #326).
        const manifest = this.loadManifest(workspacePath);
        manifest[record.taskId] = fullRecord;
        this.saveManifest(workspacePath, manifest);
        return fullRecord;
    }

    static updateTask(workspacePath: string, taskId: string, updates: Partial<TaskRecord>) {
        withManifestLock(() => {
            const manifest = this.loadManifest(workspacePath);
            if (manifest[taskId]) {
                manifest[taskId] = { ...manifest[taskId], ...updates };
                this.saveManifest(workspacePath, manifest);
            }
        });
    }

    static heartbeat(workspacePath: string, taskId: string) {
        withManifestLock(() => {
            const manifest = this.loadManifest(workspacePath);
            if (manifest[taskId]) {
                manifest[taskId].heartbeatTime = Date.now();
                this.saveManifest(workspacePath, manifest);
            }
        });
    }

    static reapStaleTasks(workspacePath: string) {
        withManifestLock(() => {
            const manifest = this.loadManifest(workspacePath);
            const now = Date.now();
            const TIMEOUT_MS = 1000 * 60 * 3; // 3 minutes timeout
            let changed = false;

            for (const taskId in manifest) {
                const task = manifest[taskId];
                if (task.status === 'running') {
                    const effectiveTimeout = task.heartbeat_timeout_ms || TIMEOUT_MS;
                    if (now - task.heartbeatTime > effectiveTimeout) {
                        task.status = 'failed';
                        task.error_message = 'Task timed out or runner process died (reaped by Watchdog).';
                        changed = true;
                        try {
                            if (task.output_path) {
                                const dir = path.dirname(task.output_path);
                                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                                fs.writeFileSync(task.output_path, `❌ **Fatal Error**: ${task.error_message}\n`, 'utf8');
                            }
                        } catch (e: any) { console.error(`[TaskManifest] Warning: failed to write timeout marker: ${e.message}`); }
                    }
                }
            }
            if (changed) {
                this.saveManifest(workspacePath, manifest);
            }
        });
    }

    /**
     * Find all tasks associated with a given GitHub Issue number.
     * Used by patrol-manager to diagnose open Issues and determine task status.
     */
    static findTasksByIssue(workspacePath: string, issueNumber: number): TaskRecord[] {
        const manifest = this.loadManifest(workspacePath);
        return Object.values(manifest).filter(t => t.github_issue_number === issueNumber || t.parent_issue_number === issueNumber);
    }

    /**
     * Archive task manifest entries older than the given age and in terminal status.
     * Terminal statuses: verified, failed, timeout, completed, partial, degraded.
     * Archived entries are appended to task-manifest-archive.json.
     * Returns count of archived entries.
     */
    static trimManifest(workspacePath: string, maxAgeDays: number = 30): { archived: number } {
        const manifest = this.loadManifest(workspacePath);
        const now = Date.now();
        const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
        const TERMINAL_STATUSES = new Set(['verified', 'failed', 'timeout', 'completed', 'partial', 'degraded', 'cancelled']);

        const archivePath = resolveOptimusPath(workspacePath, 'state', 'task-manifest-archive.json');
        let archive: Record<string, TaskRecord> = {};
        try {
            if (fs.existsSync(archivePath)) {
                archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
            }
        } catch { /* start fresh archive */ }

        const toArchive: string[] = [];
        for (const [taskId, task] of Object.entries(manifest)) {
            if (TERMINAL_STATUSES.has(task.status) && (now - task.startTime) > cutoffMs) {
                toArchive.push(taskId);
            }
        }

        if (toArchive.length === 0) return { archived: 0 };

        for (const taskId of toArchive) {
            archive[taskId] = manifest[taskId];
            delete manifest[taskId];
        }

        // Write archive (not under mutex — archive is append-only, lower risk)
        const archiveDir = path.dirname(archivePath);
        if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
        fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf8');

        // Write trimmed manifest (synchronous, same as createTask pattern)
        this.saveManifest(workspacePath, manifest);

        return { archived: toArchive.length };
    }

    /**
     * Unblock dependent tasks after a task completes with 'verified' status.
     * MUST be synchronous (same as createTask) to prevent double-spawn race conditions.
     * Returns the list of task IDs that were unblocked (transitioned from blocked → pending).
     */
    static unblockDependents(workspacePath: string, completedTaskId: string): string[] {
        const manifest = this.loadManifest(workspacePath);
        const unblocked: string[] = [];
        let changed = false;

        for (const taskId in manifest) {
            const task = manifest[taskId];
            if (task.status !== 'blocked' || !task.blocked_by) continue;

            const idx = task.blocked_by.indexOf(completedTaskId);
            if (idx === -1) continue;

            task.blocked_by.splice(idx, 1);
            changed = true;

            if (task.blocked_by.length === 0) {
                task.status = 'pending';
                task.blocked_by = undefined; // clean up
                unblocked.push(taskId);
            }
        }

        if (changed) {
            this.saveManifest(workspacePath, manifest);
        }
        return unblocked;
    }
}
