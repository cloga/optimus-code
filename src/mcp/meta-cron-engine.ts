import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { TaskManifestManager } from "../managers/TaskManifestManager";

// ─── Cron Entry Schema ───

interface CronEntry {
    id: string;
    cron_expression: string;
    role: string;
    required_skills: string[];
    capability_tier: string;
    concurrency_policy: string;
    max_actions: number;
    dry_run_remaining: number;
    enabled: boolean;
    last_run: string | null;
    last_status: string | null;
    run_count: number;
    fail_count: number;
    created_at: string;
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

function isLocked(workspacePath: string, id: string): boolean {
    const lockPath = getLockPath(workspacePath, id);
    try {
        if (!fs.existsSync(lockPath)) return false;
        const stat = fs.statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        return ageMs < 60 * 60 * 1000;
    } catch (e: any) {
        console.error(`[Meta-Cron] Warning: failed to check lock for '${id}': ${e.message}. Treating as unlocked.`);
        return false;
    }
}

function createLock(workspacePath: string, id: string): boolean {
    try {
        const lockDir = getLockDir(workspacePath);
        if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(getLockPath(workspacePath, id), JSON.stringify({
            pid: process.pid,
            locked_at: new Date().toISOString()
        }), 'utf8');
        return true;
    } catch (e: any) {
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
    fs.writeFileSync(crontabPath, JSON.stringify(data, null, 2), 'utf8');
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
            task_description: taskDescription,
            output_path: `.optimus/reports/cron-${entry.id}-${new Date().toISOString().slice(0, 10)}.md`,
            workspacePath: this.workspacePath,
            required_skills: entry.required_skills,
            delegation_depth: 0,
        });

        const child = spawn(process.execPath, [
            path.join(__dirname, '..', '..', 'dist', 'mcp-server.js'),
            '--run-task', taskId, this.workspacePath
        ], {
            detached: true, stdio: 'ignore', windowsHide: true,
            env: { ...process.env, OPTIMUS_DELEGATION_DEPTH: '0', OPTIMUS_CRON_TRIGGERED: 'true' }
        });
        child.unref();

        const entryId = entry.id;
        const ws = this.workspacePath;

        const checkInterval = setInterval(() => {
            try {
                const manifest = TaskManifestManager.loadManifest(ws);
                const task = manifest[taskId];
                if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'verified' || task.status === 'partial')) {
                    clearInterval(checkInterval);
                    deleteLock(ws, entryId);
                    MetaCronEngine.runningCount = Math.max(0, MetaCronEngine.runningCount - 1);
                    const freshCrontab = loadCrontab(ws);
                    if (freshCrontab) {
                        const freshEntry = freshCrontab.crons.find(c => c.id === entryId);
                        if (freshEntry) {
                            freshEntry.last_status = task.status;
                            if (task.status === 'failed') freshEntry.fail_count++;
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
        }, 2 * 60 * 60 * 1000);
        if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
    }
}
