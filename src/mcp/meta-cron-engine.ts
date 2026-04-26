import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { TaskManifestManager, type TaskRecord } from "../managers/TaskManifestManager";
import { resolveOptimusPath } from "../utils/worktree";
import { isPidAlive } from "../utils/isPidAlive";

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
    last_task_id?: string;
    last_failure_code?: string;
    last_failure_message?: string;
    last_failure_fix?: string;
    last_heartbeat_at?: string;
    last_activity_timeout_ms?: number;
    last_recovery_status?: string;
    last_recovery_task_id?: string;
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
    return resolveOptimusPath(workspacePath, 'system', 'cron-locks');
}

function getLockPath(workspacePath: string, id: string): string {
    return path.join(getLockDir(workspacePath), `${id}.lock`);
}

function isLockStale(lockPath: string, workspacePath?: string): boolean {
    try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const data = JSON.parse(content) as { pid?: number; locked_at?: string; cronId?: string };

        // If the lock records a cronId and we have a workspacePath, check whether
        // a child worker task is still actively running in the manifest.
        // This defends against the server-crash scenario: the MCP server PID dies
        // but its detached child worker is still alive and heartbeating.
        // The manifest heartbeat is updated by the child, not the server (Issue #511).
        if (data.cronId && workspacePath) {
            try {
                const manifest = TaskManifestManager.loadManifest(workspacePath);
                const prefix = `cron_${data.cronId}_`;
                for (const [taskId, task] of Object.entries(manifest)) {
                    if (!taskId.startsWith(prefix)) continue;
                    if (task.status !== 'running') continue;
                    const hb = task.heartbeatTime;
                    // If the task has heartbeated within the last 5 minutes, the worker
                    // is alive — lock is NOT stale even if the server PID is dead.
                    if (hb && (Date.now() - hb) < 5 * 60 * 1000) {
                        return false;
                    }
                }
            } catch { /* manifest read failure — fall through to PID/time checks */ }
        }

        // PID-based staleness: if the owning process is gone, the lock is stale
        if (typeof data.pid === 'number' && !isPidAlive(data.pid)) {
            return true;
        }
        // Time-based fallback: treat locks older than 2 hours as stale regardless of PID.
        // Must be strictly greater than the longest cron period (1 hour for hourly-patrol)
        // to prevent the time-based check from treating an active lock as stale at the
        // exact boundary when the next cron tick fires (Issue #511).
        if (data.locked_at) {
            const ageMs = Date.now() - new Date(data.locked_at).getTime();
            if (ageMs >= 2 * 60 * 60 * 1000) return true;
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
        return !isLockStale(lockPath, workspacePath);
    } catch (e: any) {
        console.error(`[Meta-Cron] Warning: failed to check lock for '${id}': ${e.message}. Treating as unlocked.`);
        return false;
    }
}

function createLock(workspacePath: string, id: string): boolean {
    const lockDir = getLockDir(workspacePath);
    const lockPath = getLockPath(workspacePath, id);
    // Nonce for post-acquisition verification after stale-lock reclaim (Issue #511).
    const nonce = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
        if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
        // 'wx' flag: exclusive create — atomically fails with EEXIST if the file already exists.
        // This guarantees that among N concurrent callers, exactly one succeeds.
        const lockFd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lockFd, JSON.stringify({
            pid: process.pid,
            cronId: id,
            nonce,
            locked_at: new Date().toISOString()
        }), 'utf8');
        fs.closeSync(lockFd);
        return true;
    } catch (e: any) {
        if (e?.code === 'EEXIST') {
            // Lock file exists — check if it belongs to a dead process (stale lock)
            try {
                if (isLockStale(lockPath, workspacePath)) {
                    fs.unlinkSync(lockPath);
                    // Re-create with 'wx' — another process may also be reclaiming
                    try {
                        const fd2 = fs.openSync(lockPath, 'wx');
                        fs.writeFileSync(fd2, JSON.stringify({
                            pid: process.pid,
                            cronId: id,
                            nonce,
                            locked_at: new Date().toISOString()
                        }), 'utf8');
                        fs.closeSync(fd2);
                    } catch { return false; }
                    // Post-acquisition nonce verification: re-read and confirm our nonce
                    // is still present. Guards against a concurrent process that also
                    // detected stale, deleted our lock, and created its own (Issue #511).
                    try {
                        const verify = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { nonce?: string };
                        if (verify.nonce !== nonce) {
                            console.error(`[Meta-Cron] Lock for '${id}' stolen by concurrent process — backing off`);
                            return false;
                        }
                    } catch { return false; }
                    return true;
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

/**
 * Update existing lock with a new PID (e.g., after spawning the actual worker child process).
 * This ensures isPidAlive() checks the worker, not the parent MCP server.
 */
function updateLockPid(workspacePath: string, id: string, childPid: number): void {
    const lockPath = getLockPath(workspacePath, id);
    try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const data = JSON.parse(content);
        data.pid = childPid;
        // Atomic write: tmp + rename to avoid partial reads by concurrent isLockStale() callers
        const tmpPath = lockPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
        fs.renameSync(tmpPath, lockPath);
    } catch (e: any) {
        console.error(`[Meta-Cron] Warning: failed to update lock PID for '${id}': ${e.message}`);
    }
}

// Exported for testing (Issue #511)
export { createLock, isLocked, updateLockPid, getLockPath, getLockDir };

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
    return resolveOptimusPath(workspacePath, 'system', 'meta-crontab.json');
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

const TERMINAL_TASK_STATUSES = new Set<TaskRecord['status']>([
    'completed',
    'failed',
    'verified',
    'partial',
    'awaiting_input',
    'expired',
    'degraded',
    'cancelled',
]);

function isTerminalTaskStatus(status: TaskRecord['status']): boolean {
    return TERMINAL_TASK_STATUSES.has(status);
}

function isFailureCronStatus(status: TaskRecord['status']): boolean {
    return status !== 'completed' && status !== 'verified';
}

function toIsoTime(value?: number | null): string | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return new Date(value).toISOString();
}

function parseCronRunNumber(task: Partial<TaskRecord>): number | undefined {
    if (typeof task.cron_run_number === 'number' && Number.isFinite(task.cron_run_number)) {
        return task.cron_run_number;
    }
    const match = String(task.task_description || '').match(/\*\*Run number:\*\*\s*(\d+)/i);
    if (!match) return undefined;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseActivityTimeoutMs(message: string): number | undefined {
    const match = message.match(/\(limit:\s*(\d+)s\)/i);
    if (!match) return undefined;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function extractFix(message: string): string | undefined {
    const match = message.match(/\bFix:\s*(.+)$/is);
    return match ? match[1].trim().slice(0, 1000) : undefined;
}

function classifyCronFailure(task: Partial<TaskRecord>): {
    code?: string;
    message?: string;
    fix?: string;
    activityTimeoutMs?: number;
} {
    const message = String(task.error_message || '');
    if (!message) return {};

    let code: string | undefined = task.failure_classification;
    if (/auth_failed/i.test(message) || /authentication required/i.test(message) || /unauthorized/i.test(message)) {
        code = 'auth_failed';
    } else if (/task_timeout/i.test(message) || /activity timeout/i.test(message)) {
        code = 'task_timeout';
    }

    return {
        code,
        message: message.slice(0, 1000),
        fix: extractFix(message),
        activityTimeoutMs: parseActivityTimeoutMs(message),
    };
}

export function persistCronEntryRunning(
    workspacePath: string,
    crontab: CrontabData,
    entry: CronEntry,
    runAt: Date = new Date(),
): void {
    entry.last_run = runAt.toISOString();
    entry.last_status = 'running';
    entry.run_count++;
    delete entry.last_failure_code;
    delete entry.last_failure_message;
    delete entry.last_failure_fix;
    delete entry.last_activity_timeout_ms;
    saveCrontab(workspacePath, crontab);
}

function applyTaskToCronEntry(
    entry: CronEntry,
    task: Partial<TaskRecord>,
    options: { incrementFailure: boolean; failureCountFloor?: number } = { incrementFailure: false },
): boolean {
    let changed = false;
    const set = <K extends keyof CronEntry>(key: K, value: CronEntry[K]) => {
        if (entry[key] !== value) {
            entry[key] = value;
            changed = true;
        }
    };

    if (task.taskId) set('last_task_id', task.taskId);
    if (task.status) set('last_status', task.status);
    if (task.agent_id) set('last_agent_id', task.agent_id);

    const taskStartIso = toIsoTime(task.startTime);
    if (taskStartIso) {
        const currentLastRun = entry.last_run ? Date.parse(entry.last_run) : 0;
        if (!entry.last_run || Number.isNaN(currentLastRun) || currentLastRun < (task.startTime || 0)) {
            set('last_run', taskStartIso);
        }
    }

    const runNumber = parseCronRunNumber(task);
    if (runNumber !== undefined && runNumber > (entry.run_count || 0)) {
        set('run_count', runNumber);
    }

    const heartbeatIso = toIsoTime(task.heartbeatTime);
    if (heartbeatIso) set('last_heartbeat_at', heartbeatIso);

    if (task.status && isFailureCronStatus(task.status as TaskRecord['status'])) {
        const failure = classifyCronFailure(task);
        if (failure.code) set('last_failure_code', failure.code);
        if (failure.message) set('last_failure_message', failure.message);
        if (failure.fix) set('last_failure_fix', failure.fix);
        if (failure.activityTimeoutMs) set('last_activity_timeout_ms', failure.activityTimeoutMs);
        if (options.incrementFailure) {
            set('fail_count', (entry.fail_count || 0) + 1);
        }
    }

    if (options.failureCountFloor !== undefined && options.failureCountFloor > (entry.fail_count || 0)) {
        set('fail_count', options.failureCountFloor);
    }

    return changed;
}

export function updateCronEntryFromTask(
    workspacePath: string,
    entryId: string,
    task: Partial<TaskRecord>,
    options: { incrementFailure?: boolean } = {},
): boolean {
    const freshCrontab = loadCrontab(workspacePath);
    if (!freshCrontab) return false;
    const freshEntry = freshCrontab.crons.find(c => c.id === entryId);
    if (!freshEntry) return false;

    const changed = applyTaskToCronEntry(freshEntry, task, { incrementFailure: options.incrementFailure === true });
    if (changed) saveCrontab(workspacePath, freshCrontab);
    return changed;
}

export function reconcileCrontabFromManifest(workspacePath: string): boolean {
    const crontab = loadCrontab(workspacePath);
    if (!crontab) return false;

    const manifest = TaskManifestManager.loadManifest(workspacePath);
    let changed = false;

    for (const entry of crontab.crons) {
        const prefix = `cron_${entry.id}_`;
        const tasks = Object.values(manifest)
            .filter(task => task.taskId?.startsWith(prefix))
            .filter(task => isTerminalTaskStatus(task.status));
        if (tasks.length === 0) continue;

        tasks.sort((a, b) => (b.startTime || b.completed_at || b.heartbeatTime || 0) - (a.startTime || a.completed_at || a.heartbeatTime || 0));
        const latest = tasks[0];
        const latestTime = latest.startTime || latest.completed_at || latest.heartbeatTime || 0;
        const lastRunTime = entry.last_run ? Date.parse(entry.last_run) : 0;
        if (entry.last_run && !Number.isNaN(lastRunTime) && lastRunTime >= latestTime) {
            continue;
        }

        const latestRunNumber = parseCronRunNumber(latest);
        const latestIsNewFailedRun = isFailureCronStatus(latest.status)
            && (latestRunNumber === undefined || latestRunNumber > (entry.run_count || 0));
        const observedFailureCount = tasks.filter(task => isFailureCronStatus(task.status)).length;
        const failureCountFloor = latestIsNewFailedRun
            ? Math.max(observedFailureCount, (entry.fail_count || 0) + 1)
            : observedFailureCount;
        changed = applyTaskToCronEntry(entry, latest, {
            incrementFailure: false,
            failureCountFloor,
        }) || changed;
    }

    if (changed) saveCrontab(workspacePath, crontab);
    return changed;
}

// ─── Scheduler Leader Election ───
// Only one MCP server process should run the cron scheduler per workspace.
// We use an exclusive-create lock file with PID to elect a single leader.

function getSchedulerLockPath(workspacePath: string): string {
    return resolveOptimusPath(workspacePath, 'system', 'cron-locks', 'scheduler-leader.lock');
}

function tryAcquireSchedulerLock(workspacePath: string): boolean {
    const lockDir = getLockDir(workspacePath);
    const lockPath = getSchedulerLockPath(workspacePath);
    // Generate a unique nonce so we can verify we still own the lock after creation.
    // This defends against a TOCTOU race where two processes both detect a stale leader,
    // both unlink + create, and one deletes the other's freshly created lock (Issue #511).
    const nonce = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lockData = JSON.stringify({
        pid: process.pid,
        nonce,
        acquired_at: new Date().toISOString()
    });
    try {
        if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(fd, lockData, 'utf8');
        fs.closeSync(fd);
        return true;
    } catch (e: any) {
        if (e?.code === 'EEXIST') {
            // Check if the existing leader is still alive
            try {
                const content = fs.readFileSync(lockPath, 'utf8');
                const data = JSON.parse(content) as { pid?: number; acquired_at?: string };
                if (typeof data.pid === 'number' && !isPidAlive(data.pid)) {
                    // Stale leader — remove and retry exactly once
                    try { fs.unlinkSync(lockPath); } catch { return false; }
                    try {
                        const fd = fs.openSync(lockPath, 'wx');
                        fs.writeFileSync(fd, lockData, 'utf8');
                        fs.closeSync(fd);
                        // Post-acquisition verification: re-read and confirm our nonce is still there.
                        // Guards against a concurrent process that also detected stale leader,
                        // deleted our freshly created lock, and created its own.
                        try {
                            const verify = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { nonce?: string };
                            if (verify.nonce !== nonce) {
                                console.error('[Meta-Cron] Leader lock stolen by concurrent process — backing off');
                                return false;
                            }
                        } catch { return false; }
                        return true;
                    } catch { return false; }
                }
            } catch {
                // Unreadable lock — another process may be writing it; back off
            }
            return false;
        }
        return false;
    }
}

export function releaseSchedulerLock(workspacePath: string): void {
    const lockPath = getSchedulerLockPath(workspacePath);
    try {
        // Only delete if we own it
        const content = fs.readFileSync(lockPath, 'utf8');
        const data = JSON.parse(content) as { pid?: number };
        if (data.pid === process.pid) {
            fs.unlinkSync(lockPath);
        }
    } catch {
        // Best-effort cleanup
    }
}

// ─── Core Engine ───

interface SchedulerState {
    workspacePath: string;
    interval: ReturnType<typeof setInterval> | null;
    runningCount: number;
    isLeader: boolean;
}

export class MetaCronEngine {
    private static readonly schedulers = new Map<string, SchedulerState>();

    private static getWorkspaceKey(workspacePath: string): string {
        const resolved = path.resolve(workspacePath);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    private static stopScheduler(workspaceKey: string, releaseLock: boolean, reason?: string): void {
        const state = this.schedulers.get(workspaceKey);
        if (!state) return;
        if (state.interval) {
            clearInterval(state.interval);
            state.interval = null;
        }
        if (releaseLock && state.isLeader) {
            releaseSchedulerLock(state.workspacePath);
        }
        if (reason) {
            console.error(reason);
        }
        this.schedulers.delete(workspaceKey);
    }

    static init(workspacePath: string): void {
        const workspaceKey = this.getWorkspaceKey(workspacePath);
        const resolvedWorkspacePath = path.resolve(workspacePath);
        if (this.schedulers.has(workspaceKey)) {
            console.error(`[Meta-Cron] Scheduler already initialized for workspace '${workspacePath}'`);
            return;
        }

        // Single-leader election: only one MCP server process per workspace runs the scheduler.
        if (!tryAcquireSchedulerLock(resolvedWorkspacePath)) {
            console.error('[Meta-Cron] Another process is the scheduler leader — skipping init');
            return;
        }
        const state: SchedulerState = {
            workspacePath: resolvedWorkspacePath,
            interval: null,
            runningCount: 0,
            isLeader: true,
        };
        this.schedulers.set(workspaceKey, state);
        console.error(`[Meta-Cron] This process (PID ${process.pid}) elected as scheduler leader`);

        const reconciled = reconcileCrontabFromManifest(state.workspacePath);
        if (reconciled) {
            console.error('[Meta-Cron] Reconciled crontab state from task manifest');
        }

        const crontab = loadCrontab(state.workspacePath);
        if (!crontab) {
            console.error('[Meta-Cron] No crontab found — engine idle');
        } else {
            console.error(`[Meta-Cron] Loaded ${crontab.crons.length} cron entries`);
        }
        state.interval = setInterval(() => { this.tick(workspaceKey); }, 60_000);
        if (state.interval && typeof state.interval.unref === 'function') {
            state.interval.unref();
        }
    }

    static shutdown(workspacePath?: string): void {
        if (workspacePath) {
            const workspaceKey = this.getWorkspaceKey(workspacePath);
            if (this.schedulers.has(workspaceKey)) {
                this.stopScheduler(workspaceKey, true, '[Meta-Cron] Engine shut down');
            }
            return;
        }
        for (const workspaceKey of Array.from(this.schedulers.keys())) {
            this.stopScheduler(workspaceKey, true, '[Meta-Cron] Engine shut down');
        }
    }

    private static tick(workspaceKey: string): void {
        const state = this.schedulers.get(workspaceKey);
        if (!state) return;

        try {
            // Re-validate scheduler leadership on every tick.
            // If another process acquired the leader lock (e.g., after we were briefly
            // unresponsive or our PID was recycled), stop this scheduler to prevent
            // dual-scheduler overlap (Issue #511).
            try {
                const leaderPath = getSchedulerLockPath(state.workspacePath);
                const leaderData = JSON.parse(fs.readFileSync(leaderPath, 'utf8')) as { pid?: number };
                if (leaderData.pid !== process.pid) {
                    this.stopScheduler(
                        workspaceKey,
                        false,
                        `[Meta-Cron] Leader lock held by PID ${leaderData.pid}, not us (${process.pid}) — stopping scheduler`
                    );
                    return;
                }
            } catch {
                // If we can't read the leader lock (deleted, corrupted), stop — we may no longer be leader
                this.stopScheduler(workspaceKey, false, '[Meta-Cron] Cannot verify leader lock — stopping scheduler');
                return;
            }

            // Clean up old tick dedup files (older than 2 hours)
            try {
                const lockDir = getLockDir(state.workspacePath);
                if (fs.existsSync(lockDir)) {
                    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
                    for (const file of fs.readdirSync(lockDir)) {
                        if (!file.startsWith('tick_')) continue;
                        const filePath = path.join(lockDir, file);
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
                        } catch { /* best effort */ }
                    }
                }
            } catch { /* tick dedup cleanup is non-critical */ }

            const crontab = loadCrontab(state.workspacePath);
            if (!crontab) return;
            const now = new Date();
            let mutated = false;
            for (const entry of crontab.crons) {
                if (!entry.enabled) continue;
                if (!matchesCronExpression(entry.cron_expression, now)) continue;
                if (state.runningCount >= crontab.max_concurrent) {
                    console.error(`[Meta-Cron] Skipping '${entry.id}' — max concurrent reached`);
                    continue;
                }
                // Concurrency guard: use atomic createLock() as the single point of truth.
                // Previous code used isLocked() here then createLock() later in fire(), creating
                // a TOCTOU gap where two ticks could both see isLocked()=false before either locked.
                if (entry.concurrency_policy === 'Forbid') {
                    if (!createLock(state.workspacePath, entry.id)) {
                        console.error(`[Meta-Cron] Skipping '${entry.id}' — lock held (Forbid)`);
                        continue;
                    }
                    // Lock acquired — fire() will use it; if fire() fails early, we clean up below
                }
                if (entry.dry_run_remaining > 0) {
                    console.error(
                        `[Meta-Cron] DRY RUN (${entry.dry_run_remaining} remaining): ` +
                        `Would fire '${entry.id}' -> role '${entry.role}'`
                    );
                    entry.dry_run_remaining--;
                    // Release the lock acquired above — dry runs don't actually fire
                    if (entry.concurrency_policy === 'Forbid') deleteLock(state.workspacePath, entry.id);
                    mutated = true;
                    continue;
                }
                this.fire(state, entry, crontab);
                mutated = true;
            }
            if (mutated) saveCrontab(state.workspacePath, crontab);
        } catch (e: any) {
            console.error(`[Meta-Cron] Tick error during crontab evaluation: ${e.message}. Check .optimus/system/meta-crontab.json for syntax errors.`);
        }
    }

    private static fire(state: SchedulerState, entry: CronEntry, _crontab: CrontabData): void {
        // Defense-in-depth: per-tick deduplication prevents duplicate tasks even if
        // leader election is somehow bypassed (e.g., stale leader lock cleanup race).
        // The tick key is based on cron minute granularity — one fire per ID per minute.
        const now = new Date();
        const tickKey = `${entry.id}_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
        const tickLockPath = path.join(getLockDir(state.workspacePath), `tick_${tickKey}.lock`);
        try {
            const tickDir = getLockDir(state.workspacePath);
            if (!fs.existsSync(tickDir)) fs.mkdirSync(tickDir, { recursive: true });
            const fd = fs.openSync(tickLockPath, 'wx');
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, tick: tickKey }), 'utf8');
            fs.closeSync(fd);
        } catch (e: any) {
            if (e?.code === 'EEXIST') {
                console.error(`[Meta-Cron] Tick dedup: '${entry.id}' already fired for this minute — skipping`);
                // Release the concurrency lock since we won't actually run
                if (entry.concurrency_policy === 'Forbid') deleteLock(state.workspacePath, entry.id);
                return;
            }
            // Non-EEXIST errors: log but proceed (don't block the cron on dedup failures)
            console.error(`[Meta-Cron] Tick dedup warning for '${entry.id}': ${e?.message}`);
        }

        // Note: concurrency lock was already acquired in tick() before calling fire().
        // No need to createLock() here — that caused the TOCTOU race (Issue #511).
        persistCronEntryRunning(state.workspacePath, _crontab, entry, new Date());
        state.runningCount++;

        const taskDescription =
            `You have been awakened by Meta-Cron (cron ID: ${entry.id}). ` +
            `Use your equipped skills to assess the system and take appropriate action.\n\n` +
            `**Capability tier:** ${entry.capability_tier}\n` +
            `**Max actions:** ${entry.max_actions}\n` +
            `**Run number:** ${entry.run_count}`;

        const taskId = `cron_${entry.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        TaskManifestManager.createTask(state.workspacePath, {
            taskId,
            type: 'delegate_task' as const,
            role: entry.role,
            role_description: entry.role_description || `System role '${entry.role}' responsible for automated ${entry.capability_tier}-tier operations. Equipped with skills: ${(entry.required_skills || []).join(', ')}.`,
            task_description: taskDescription,
            output_path: `.optimus/reports/cron-${entry.id}-${new Date().toISOString().slice(0, 10)}.md`,
            workspacePath: state.workspacePath,
            required_skills: entry.required_skills,
            delegation_depth: 0,
            agent_id: entry.last_agent_id,
            cron_id: entry.id,
            cron_run_number: entry.run_count,
        });

        // Capture child stdout/stderr to a log file for diagnostics (was stdio:'ignore' — Issue #326).
        const logDir = resolveOptimusPath(state.workspacePath, 'system', 'cron-logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, `${entry.id}_${new Date().toISOString().slice(0, 10)}.log`);
        const logFd = fs.openSync(logFile, 'a');

        const child = spawn(process.execPath, [
            __filename,
            '--run-task', taskId, state.workspacePath
        ], {
            detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
            cwd: state.workspacePath,
            env: { ...process.env, OPTIMUS_DELEGATION_DEPTH: '0', OPTIMUS_CRON_TRIGGERED: 'true' }
        });
        child.unref();
        fs.closeSync(logFd);

        // Update the lock with the child's PID so isPidAlive() checks the actual worker,
        // not the MCP server. This prevents stale-lock false positives when the server
        // restarts but the worker child is still alive (root cause of Issue #511).
        if (child.pid) {
            updateLockPid(state.workspacePath, entry.id, child.pid);
        }

        const entryId = entry.id;
        const ws = state.workspacePath;
        const fireTime = Date.now();

        // Safety timer prevents leaked locks when tasks hang forever (2h hard ceiling).
        // CRITICAL: checkInterval MUST clear safetyTimer on task completion, otherwise the
        // stale safetyTimer fires later and deletes the lock belonging to a SUBSEQUENT run
        // of the same cron entry — the root cause of overlapping runs (Issue #511).
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;

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
                    TaskManifestManager.updateTask(ws, taskId, {
                        status: 'failed',
                        error_message: 'Child process failed to start (task remained pending)',
                        failure_classification: 'startup_timeout',
                        completed_at: Date.now(),
                    });
                    clearInterval(checkInterval);
                    if (safetyTimer) clearTimeout(safetyTimer);
                    deleteLock(ws, entryId);
                    state.runningCount = Math.max(0, state.runningCount - 1);
                    updateCronEntryFromTask(ws, entryId, {
                        taskId,
                        status: 'failed',
                        startTime: task.startTime,
                        heartbeatTime: task.heartbeatTime,
                        error_message: 'Child process failed to start (task remained pending)',
                        failure_classification: 'startup_timeout',
                        agent_id: task.agent_id,
                        cron_id: entryId,
                        cron_run_number: task.cron_run_number,
                    }, { incrementFailure: true });
                    return;
                }

                if (isTerminalTaskStatus(task.status)) {
                    clearInterval(checkInterval);
                    if (safetyTimer) clearTimeout(safetyTimer);
                    deleteLock(ws, entryId);
                    state.runningCount = Math.max(0, state.runningCount - 1);
                    updateCronEntryFromTask(ws, entryId, task, { incrementFailure: isFailureCronStatus(task.status) });
                }
            } catch (e: any) { console.error(`[Meta-Cron] Warning: task poll failed for cron '${entryId}': ${e.message}`); }
        }, 30_000);
        if (typeof checkInterval.unref === 'function') checkInterval.unref();

        safetyTimer = setTimeout(() => {
            clearInterval(checkInterval);
            deleteLock(ws, entryId);
            state.runningCount = Math.max(0, state.runningCount - 1);
            updateCronEntryFromTask(ws, entryId, {
                taskId,
                status: 'failed',
                startTime: fireTime,
                heartbeatTime: Date.now(),
                error_message: `META_CRON_SAFETY_TIMEOUT: cron '${entryId}' exceeded 2h limit. Fix: inspect the worker log and retry after increasing task timeout or resolving the engine hang.`,
                failure_classification: 'heartbeat_timeout',
                cron_id: entryId,
                cron_run_number: entry.run_count,
            }, { incrementFailure: true });
            console.error(`[Meta-Cron] Safety timeout: cron '${entryId}' exceeded 2h limit. Marked as failed.`);
        }, 2 * 60 * 60 * 1000);
        if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
    }
}
