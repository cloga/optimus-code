import * as fs from 'fs';
import * as path from 'path';

// File-level mutex to prevent concurrent read-modify-write on task-manifest.json
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
    status: 'pending' | 'running' | 'completed' | 'partial' | 'verified' | 'failed' | 'degraded';
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
}

export class TaskManifestManager {
    static getManifestPath(workspacePath: string): string {
        return path.join(workspacePath, '.optimus', 'state', 'task-manifest.json');
    }

    static loadManifest(workspacePath: string): Record<string, TaskRecord> {
        const manifestPath = this.getManifestPath(workspacePath);
        if (!fs.existsSync(manifestPath)) {
            return {};
        }
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch {
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
        // Fire-and-forget locked write — record is returned immediately
        withManifestLock(() => {
            const manifest = this.loadManifest(workspacePath);
            manifest[record.taskId] = fullRecord;
            this.saveManifest(workspacePath, manifest);
        });
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
                    if (now - task.heartbeatTime > TIMEOUT_MS) {
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
}