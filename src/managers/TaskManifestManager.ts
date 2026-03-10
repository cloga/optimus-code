import * as fs from 'fs';
import * as path from 'path';

export interface TaskRecord {
    taskId: string;
    type: 'delegate_task' | 'dispatch_council';
    status: 'pending' | 'running' | 'completed' | 'failed';
    role?: string;
    roles?: string[];
    task_description?: string;
    proposal_path?: string;
    output_path?: string;
    pid?: number;
    error_message?: string;
    startTime: number;
    heartbeatTime: number;
    workspacePath: string;
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
        const manifest = this.loadManifest(workspacePath);
        const fullRecord: TaskRecord = {
            ...record,
            status: 'pending',
            startTime: Date.now(),
            heartbeatTime: Date.now()
        };
        manifest[record.taskId] = fullRecord;
        this.saveManifest(workspacePath, manifest);
        return fullRecord;
    }

    static updateTask(workspacePath: string, taskId: string, updates: Partial<TaskRecord>) {
        const manifest = this.loadManifest(workspacePath);
        if (manifest[taskId]) {
            manifest[taskId] = { ...manifest[taskId], ...updates };
            this.saveManifest(workspacePath, manifest);
        }
    }

    static heartbeat(workspacePath: string, taskId: string) {
        this.updateTask(workspacePath, taskId, { heartbeatTime: Date.now() });
    }

    static reapStaleTasks(workspacePath: string) {
        const manifest = this.loadManifest(workspacePath);
        const now = Date.now();
        const TIMEOUT_MS = 1000 * 60 * 10; // 10 minutes timeout
        let changed = false;

        for (const taskId in manifest) {
            const task = manifest[taskId];
            if (task.status === 'running') {
                if (now - task.heartbeatTime > TIMEOUT_MS) {
                    task.status = 'failed';
                    task.error_message = 'Task timed out or runner process died (reaped by Watchdog).';
                    changed = true;
                    // Try write a FAILED.md if it's a delegate task
                    try {
                        if (task.output_path) {
                            const dir = path.dirname(task.output_path);
                            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                            fs.writeFileSync(task.output_path, `❌ **Fatal Error**: ${task.error_message}\n`, 'utf8');
                        }
                    } catch(e) {}
                }
            }
        }
        if (changed) {
            this.saveManifest(workspacePath, manifest);
        }
    }
}