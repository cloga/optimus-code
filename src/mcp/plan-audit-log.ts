import * as fs from 'fs';
import * as path from 'path';
import { resolveOptimusPath } from '../utils/worktree';
import type { OptimusStrategy, OptimusDispatchPlan } from './optimus-orchestrator';

/**
 * Phase 0 of End-to-End Accountability: Plan Audit Log.
 *
 * Every orchestrator strategy decision is appended to `.optimus/logs/plan-audit.jsonl`
 * so that retrospectives can answer questions like:
 *   - Which strategy (delegate / council / plan) was chosen for this request shape?
 *   - Did the agent planner or the code heuristic produce the plan?
 *   - How many tasks did the plan actually spawn?
 *   - What was the rationale, and did the resulting tasks verify or fail?
 *
 * The log is intentionally append-only JSONL so existing tools (grep, jq, DuckDB)
 * can parse it without custom readers. Each entry is one line.
 *
 * Concurrency: writes are serialized through an in-process mutex to avoid
 * interleaved lines when multiple orchestrator calls run in parallel inside the
 * same MCP server. Cross-process concurrency (separate MCP server instances)
 * can still interleave; this is accepted — each entry is a self-contained JSON
 * object and a corrupt line can be discarded by consumers.
 */

export interface PlanAuditEntry {
    /** ISO timestamp of the decision */
    timestamp: string;
    /** Strategy chosen by the orchestrator */
    strategy: OptimusStrategy;
    /** Which planner produced the plan */
    planner_mode: 'agent' | 'code' | 'auto';
    /** Human-readable rationale lines */
    rationale: string[];
    /** First 200 chars of the original request (for grep-ability) */
    task_description_preview: string;
    /** Task IDs spawned by this plan, if any (empty on dispatch failure) */
    task_ids: string[];
    /** Parent GitHub/ADO issue number, if tracked */
    parent_issue_number?: number;
    /** Final outcome of the dispatch step itself */
    dispatch_outcome: 'dispatched' | 'failed';
    /** Error message when dispatch_outcome === 'failed' */
    error_message?: string;
    /** Summary artifact path the orchestrator chose */
    summary_output_path: string;
    /** For council/plan strategies: how many roles / items */
    fanout: number;
}

const PREVIEW_MAX_CHARS = 200;
let auditMutex: Promise<void> = Promise.resolve();

function withAuditLock<T>(fn: () => T): Promise<T> {
    let release: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const prev = auditMutex;
    auditMutex = next;
    return prev.then(() => {
        try {
            return fn();
        } finally {
            release!();
        }
    });
}

function computeFanout(plan: OptimusDispatchPlan): number {
    if (plan.strategy === 'delegate') return 1;
    if (plan.strategy === 'council' && plan.councilSpec) return plan.councilSpec.roles.length;
    if (plan.strategy === 'plan' && plan.planSpec) return plan.planSpec.items.length;
    return 0;
}

function truncatePreview(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > PREVIEW_MAX_CHARS
        ? normalized.slice(0, PREVIEW_MAX_CHARS) + '…'
        : normalized;
}

/**
 * Resolve the audit log path and ensure its parent directory exists.
 * Exported for tests.
 */
export function getPlanAuditLogPath(workspacePath: string): string {
    const logPath = resolveOptimusPath(workspacePath, 'logs', 'plan-audit.jsonl');
    const dir = path.dirname(logPath);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        // Directory might already exist or be inaccessible — appendFileSync will surface it.
    }
    return logPath;
}

export interface AppendPlanAuditOptions {
    workspacePath: string;
    plan: OptimusDispatchPlan;
    plannerMode: 'agent' | 'code' | 'auto';
    taskDescription: string;
    taskIds: string[];
    parentIssueNumber?: number;
    dispatchOutcome: 'dispatched' | 'failed';
    errorMessage?: string;
}

/**
 * Append a single audit entry to the plan audit log.
 *
 * This is best-effort telemetry: errors are logged to stderr but never thrown.
 * The orchestrator must not be blocked by a logging failure.
 */
export async function appendPlanAudit(opts: AppendPlanAuditOptions): Promise<void> {
    const entry: PlanAuditEntry = {
        timestamp: new Date().toISOString(),
        strategy: opts.plan.strategy,
        planner_mode: opts.plannerMode,
        rationale: opts.plan.rationale,
        task_description_preview: truncatePreview(opts.taskDescription),
        task_ids: opts.taskIds,
        parent_issue_number: opts.parentIssueNumber,
        dispatch_outcome: opts.dispatchOutcome,
        error_message: opts.errorMessage,
        summary_output_path: opts.plan.summaryOutputPath,
        fanout: computeFanout(opts.plan),
    };

    await withAuditLock(() => {
        try {
            const logPath = getPlanAuditLogPath(opts.workspacePath);
            fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
        } catch (err: any) {
            console.error(`[PlanAudit] Failed to append entry: ${err?.message || err}`);
        }
    });
}

/**
 * Read all audit entries. Intended for tests and retrospective tooling.
 * Silently skips malformed lines (one corrupt interleaved write does not
 * poison the whole log).
 */
export function readPlanAuditEntries(workspacePath: string): PlanAuditEntry[] {
    const logPath = getPlanAuditLogPath(workspacePath);
    if (!fs.existsSync(logPath)) return [];
    const contents = fs.readFileSync(logPath, 'utf8');
    const entries: PlanAuditEntry[] = [];
    for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        try {
            entries.push(JSON.parse(line) as PlanAuditEntry);
        } catch {
            // skip corrupt line
        }
    }
    return entries;
}
