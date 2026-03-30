/**
 * T3 Usage Tracking
 *
 * Tracks T3 (zero-shot) role invocations, successes, failures,
 * and consecutive failure counts. Used by delegateTaskSingle()
 * to record role usage metrics.
 *
 * Extracted from worker-spawner.ts for modularity.
 */
import fs from "fs";
import path from "path";
import { resolveOptimusPath } from '../utils/worktree';

// ─── Role Name Sanitization (prevents path traversal) ───

export function sanitizeRoleName(role: string): string {
    return role.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100);
}

// ─── T3 Usage Log ───

// File-level mutex to prevent concurrent read-modify-write on t3-usage-log.json
let t3LogMutex: Promise<void> = Promise.resolve();

export interface T3UsageEntry {
    role: string;
    invocations: number;
    successes: number;
    failures: number;
    consecutive_failures: number;
    lastUsed: string;
    engine: string;
    model?: string;
}

function getT3UsageLogPath(workspacePath: string): string {
    return resolveOptimusPath(workspacePath, 'state', 't3-usage-log.json');
}

export function loadT3UsageLog(workspacePath: string): Record<string, T3UsageEntry> {
    const logPath = getT3UsageLogPath(workspacePath);
    try {
        if (fs.existsSync(logPath)) {
            return JSON.parse(fs.readFileSync(logPath, 'utf8'));
        }
    } catch (e: any) { console.error(`[T3UsageLog] Warning: failed to read usage log: ${e.message}`); }
    return {};
}

export function saveT3UsageLog(workspacePath: string, log: Record<string, T3UsageEntry>): void {
    const logPath = getT3UsageLogPath(workspacePath);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
}

export function trackT3Usage(workspacePath: string, role: string, success: boolean, engine: string, model?: string): void {
    // Serialize access via mutex to prevent concurrent overwrites
    t3LogMutex = t3LogMutex.then(() => {
        const log = loadT3UsageLog(workspacePath);
        if (!log[role]) {
            log[role] = { role, invocations: 0, successes: 0, failures: 0, consecutive_failures: 0, lastUsed: '', engine, model };
        }
        if (log[role].consecutive_failures === undefined) {
            log[role].consecutive_failures = 0;
        }
        log[role].invocations++;
        if (success) {
            log[role].successes++;
            log[role].consecutive_failures = 0;
        } else {
            log[role].failures++;
            log[role].consecutive_failures++;
        }
        log[role].lastUsed = new Date().toISOString();
        log[role].engine = engine;
        if (model) log[role].model = model;
        saveT3UsageLog(workspacePath, log);
    }).catch(() => {});
}
