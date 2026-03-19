import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { TaskManifestManager } from "../managers/TaskManifestManager";

// ─── Cron Entry Schema ───

interface CronEntry {
    id: string;
    cron_expression: string;
    role: string;
    role_description?: string;
    required_skills: string[];
    capability_tier: string;
    concurrency_policy: string;
    max_actions: number;
    max_delegations?: number;
    dry_run_remaining: number;
    enabled: boolean;
    last_run: string | null;
    last_status: string | null;
    run_count: number;
    fail_count: number;
    created_at: string;
    last_agent_id?: string;
    startup_timeout_ms?: number;
}

interface CrontabData {
    max_concurrent: number;
    crons: CronEntry[];
}

// ─── Cron Expression Parser (5-field, no external deps) ───

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
    if (field === '*') return true;
    if (field.includes('/')) {
        const [rangeStr, stepStr] = field.split('/');
        const step = parseInt(stepStr, 10);
        if (isNaN(step) || step <= 0) return false;
        let rangeStart = min;
        let rangeEnd = max;
        if (rangeStr !== '*') {
            if (rangeStr.includes('-')) {
                const [s, e] = rangeStr.split('-').map(Number);
                rangeStart = s;
                rangeEnd = e;
            } else {
                rangeStart = parseInt(rangeStr, 10);
                rangeEnd = max;
            }
        }
        if (value < rangeStart || value > rangeEnd) return false;
        return (value - rangeStart) % step === 0;
    }
    if (field.includes(',')) {
        return field.split(',').some(v => matchesCronField(v.trim(), value, min, max));
    }
    if (field.includes('-')) {
        const [start, end] = field.split('-').map(Number);
        return value >= start && value <= end;
    }
    return parseInt(field, 10) === value;
}

function matchesCronExpression(expression: string, now: Date): boolean {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;
    const minute = now.getMinutes();
    const hour = now.getHours();
    const dayOfMonth = now.getDate();
    const month = now.getMonth() + 1;
    const dayOfWeek = now.getDay();
    return (
        matchesCronField(minuteField, minute, 0, 59) &&
        matchesCronField(hourField, hour, 0, 23) &&
        matchesCronField(dayOfMonthField, dayOfMonth, 1, 31) &&
        matchesCronField(monthField, month, 1, 12) &&
        matchesCronField(dayOfWeekField, dayOfWeek, 0, 6)
    );
}

// ─── Lock File Management ───

function getLockDir(workspacePath: string): string {
    return path.join(workspacePath, '.optimus', 'system', 'cron-locks');
}

function getLockPath(workspacePath: string, id: string): string {
    return path.join(getLockDir(workspacePath), `${id}.lock`);
}

function isPidRunning(pid: number): boolean {
    try {
        // signal 0 checks process existence without sending a real signal
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isLockStale(lockPath: string): boolean {
    try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const data = JSON.parse(content) as { pid?: number; locked_at?: string };
        // PID-based staleness: if the owning process is gone, the lock is stale
        if (typeof data.pid === 'number' && !isPidRunning(data.pid)) {
            return true;
        }
        // Time-based fallback: treat locks older than 1 hour as stale regardless of PID
        if (data.locked_at) {
            const ageMs = Date.now() - new Date(data.locked_at).getTime();
            if (ageMs >= 60 * 60 * 1000) return true;
        }
        return false;
    } catch {
        // Unreadable or malformed lock — treat as stale so we don't block forever
        return true;
    }
}

function isLocked(workspacePath: string, id: string): boolean {
    const lockPath = getLockPath(workspacePath, id);
    try {
        if (!fs.existsSync(lockPath)) return false;
        return !isLockStale(lockPath);
    } catch (e: any) {
        console.error(`[Meta-Cron] Warning: failed to check lock for '${id}': ${e.message}. Treating as unlocked.`);
        return false;
    }
}

function createLock(workspacePath: string, id: string): boolean {
    const lockDir = getLockDir(workspacePath);
    const lockPath = getLockPath(workspacePath, id);
    try {
        if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
        // 'wx' flag: exclusive create — atomically fails with EEXIST if the file already exists.
        // This guarantees that among N concurrent callers, exactly one succeeds.
        const lockFd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lockFd, JSON.stringify({
            pid: process.pid,
            locked_at: new Date().toISOString()
        }), 'utf8');
        fs.closeSync(lockFd);
        return true;
    } catch (e: any) {
        if (e?.code === 'EEXIST') {
            // Lock file exists — check if it belongs to a dead process (stale lock)
            try {
                if (isLockStale(lockPath)) {
                    fs.unlinkSync(lockPath);
                    return createLock(workspacePath, id);
                }
            } catch {
                // If we can't read/delete the stale lock, another process may be cleaning it up
                // concurrently. Treat as locked to avoid thundering herd on delete+retry.
            }
            return false;
        }
        console.error(`[Meta-Cron] Warning: failed to create lock for '${id}': ${e.message}. Entry will run unguarded.`);
        return false;
    }
}

export function deleteLock(workspacePath: string, id: string): void {
    try {
        const lockPath = getLockPath(workspacePath, id);
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (e: any) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[Meta-Cron] Warning: failed to delete lock for '${id}': ${e.message}. Stale lock may prevent next run.`);
    }
}

// ─── Crontab File I/O ───

function getCrontabPath(workspacePath: string): string {
    return path.join(workspacePath, '.optimus', 'system', 'meta-crontab.json');
}

export function loadCrontab(workspacePath: string): CrontabData | null {
    const crontabPath = getCrontabPath(workspacePath);
    try {
        if (!fs.existsSync(crontabPath)) return null;
        return JSON.parse(fs.readFileSync(crontabPath, 'utf8')) as CrontabData;
    } catch (e: any) {
        console.error(`[Meta-Cron] Failed to parse crontab: ${e.message}`);
        return null;
    }
}

export function saveCrontab(workspacePath: string, data: CrontabData): void {
    const crontabPath = getCrontabPath(workspacePath);
    const dir = path.dirname(crontabPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = crontabPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, crontabPath);
}

// ─── Core Engine ───

export class MetaCronEngine {
    private static interval: ReturnType<typeof setInterval> | null = null;
    private static workspacePath: string = '';
    private static runningCount: number = 0;

    static init(workspacePath: string): void {
        this.workspacePath = workspacePath;
        const crontab = loadCrontab(workspacePath);
        if (!crontab) {
            console.error('[Meta-Cron] No crontab found — engine idle');
        } else {
            console.error(`[Meta-Cron] Loaded ${crontab.crons.length} cron entries`);
        }
        this.interval = setInterval(() => { this.tick(); }, 60_000);
        if (this.interval && typeof this.interval.unref === 'function') {
            this.interval.unref();
        }
    }

    static shutdown(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            console.error('[Meta-Cron] Engine shut down');
        }
    }

    private static tick(): void {
        try {
            const crontab = loadCrontab(this.workspacePath);
            if (!crontab) return;
            const now = new Date();
            let mutated = false;
            for (const entry of crontab.crons) {
                if (!entry.enabled) continue;
                if (!matchesCronExpression(entry.cron_expression, now)) continue;
                if (this.runningCount >= crontab.max_concurrent) {
                    console.error(`[Meta-Cron] Skipping '${entry.id}' — max concurrent reached`);
                    continue;
                }
                if (entry.concurrency_policy === 'Forbid' && isLocked(this.workspacePath, entry.id)) {
                    console.error(`[Meta-Cron] Skipping '${entry.id}' — still locked (Forbid)`);
                    continue;
                }
                if (entry.dry_run_remaining > 0) {
                    console.error(
                        `[Meta-Cron] DRY RUN (${entry.dry_run_remaining} remaining): ` +
                        `Would fire '${entry.id}' -> role '${entry.role}'`
                    );
                    entry.dry_run_remaining--;
                    mutated = true;
                    continue;
                }
                this.fire(entry, crontab);
                mutated = true;
            }
            if (mutated) saveCrontab(this.workspacePath, crontab);
        } catch (e: any) {
            console.error(`[Meta-Cron] Tick error during crontab evaluation: ${e.message}. Check .optimus/system/meta-crontab.json for syntax errors.`);
        }
    }

    private static fire(entry: CronEntry, _crontab: CrontabData): void {
        if (!createLock(this.workspacePath, entry.id)) {
            console.error(`[Meta-Cron] Failed to create lock for '${entry.id}'. Check permissions on .optimus/system/cron-locks/ directory.`);
            return;
        }
        entry.last_run = new Date().toISOString();
        entry.last_status = 'running';
        entry.run_count++;
        this.runningCount++;

        const taskDescription =
            `You have been awakened by Meta-Cron (cron ID: ${entry.id}). ` +
            `Use your equipped skills to assess the system and take appropriate action.\n\n` +
            `**Capability tier:** ${entry.capability_tier}\n` +
            `**Max actions:** ${entry.max_actions}\n` +
            `**Run number:** ${entry.run_count}`;

        const taskId = `cron_${entry.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        TaskManifestManager.createTask(this.workspacePath, {
            taskId,
            type: 'delegate_task' as const,
            role: entry.role,
            role_description: entry.role_description || `System role '${entry.role}' responsible for automated ${entry.capability_tier}-tier operations. Equipped with skills: ${(entry.required_skills || []).join(', ')}.`,
            task_description: taskDescription,
            output_path: `.optimus/reports/cron-${entry.id}-${new Date().toISOString().slice(0, 10)}.md`,
            workspacePath: this.workspacePath,
            required_skills: entry.required_skills,
            delegation_depth: 0,
            agent_id: entry.last_agent_id,
        });

        // Capture child stdout/stderr to a log file for diagnostics (was stdio:'ignore' — Issue #326).
        const logDir = path.join(this.workspacePath, '.optimus', 'system', 'cron-logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, `${entry.id}_${new Date().toISOString().slice(0, 10)}.log`);
        const logFd = fs.openSync(logFile, 'a');

        const child = spawn(process.execPath, [
            __filename,
            '--run-task', taskId, this.workspacePath
        ], {
            detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
            cwd: this.workspacePath,
            env: { ...process.env, OPTIMUS_DELEGATION_DEPTH: '0', OPTIMUS_CRON_TRIGGERED: 'true' }
        });
        child.unref();
        fs.closeSync(logFd);

        const entryId = entry.id;
        const ws = this.workspacePath;
        const fireTime = Date.now();

        const checkInterval = setInterval(() => {
            try {
                const manifest = TaskManifestManager.loadManifest(ws);
                const task = manifest[taskId];
                if (!task) return;

                // Detect stuck-pending: child process failed to start (wrong path, crash, etc.)
                // If still pending after startup timeout, the spawned process never called runAsyncWorker.
                const startupTimeout = entry.startup_timeout_ms || 2 * 60 * 1000;
                if (task.status === 'pending' && (Date.now() - fireTime) > startupTimeout) {
                    console.error(`[Meta-Cron] Task '${taskId}' still pending after ${Math.round(startupTimeout / 1000)}s — child process likely failed to start. Marking as failed.`);
                    TaskManifestManager.updateTask(ws, taskId, { status: 'failed', error_message: 'Child process failed to start (task remained pending)' });
                    clearInterval(checkInterval);
                    deleteLock(ws, entryId);
                    MetaCronEngine.runningCount = Math.max(0, MetaCronEngine.runningCount - 1);
                    const freshCrontab = loadCrontab(ws);
                    if (freshCrontab) {
                        const freshEntry = freshCrontab.crons.find(c => c.id === entryId);
                        if (freshEntry) {
                            freshEntry.last_status = 'failed';
                            freshEntry.fail_count++;
                            saveCrontab(ws, freshCrontab);
                        }
                    }
                    return;
                }

                if (task.status === 'completed' || task.status === 'failed' || task.status === 'verified' || task.status === 'partial' || task.status === 'awaiting_input' || task.status === 'expired' || task.status === 'degraded') {
                    clearInterval(checkInterval);
                    deleteLock(ws, entryId);
                    MetaCronEngine.runningCount = Math.max(0, MetaCronEngine.runningCount - 1);
                    const freshCrontab = loadCrontab(ws);
                    if (freshCrontab) {
                        const freshEntry = freshCrontab.crons.find(c => c.id === entryId);
                        if (freshEntry) {
                            freshEntry.last_status = task.status;
                            if (task.status === 'failed') freshEntry.fail_count++;
                            // Session persistence: save agent_id for next cron cycle
                            if (task.agent_id) {
                                freshEntry.last_agent_id = task.agent_id;
                            }
                            saveCrontab(ws, freshCrontab);
                        }
                    }
                }
            } catch (e: any) { console.error(`[Meta-Cron] Warning: task poll failed for cron '${entryId}': ${e.message}`); }
        }, 30_000);
        if (typeof checkInterval.unref === 'function') checkInterval.unref();

        const safetyTimer = setTimeout(() => {
            clearInterval(checkInterval);
            deleteLock(ws, entryId);
            MetaCronEngine.runningCount = Math.max(0, MetaCronEngine.runningCount - 1);
            // Update crontab so last_status doesn't stay "running" forever
            const freshCrontab = loadCrontab(ws);
            if (freshCrontab) {
                const freshEntry = freshCrontab.crons.find(c => c.id === entryId);
                if (freshEntry && freshEntry.last_status === 'running') {
                    freshEntry.last_status = 'failed';
                    freshEntry.fail_count++;
                    saveCrontab(ws, freshCrontab);
                    console.error(`[Meta-Cron] Safety timeout: cron '${entryId}' exceeded 2h limit. Marked as failed.`);
                }
            }
        }, 2 * 60 * 60 * 1000);
        if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
    }
}
