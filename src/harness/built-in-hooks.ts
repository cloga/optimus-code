import { HookHandler, LifecycleHookContext } from './lifecycle-hooks.js';

/**
 * Built-in hook: Log all lifecycle events to stderr for debugging.
 * Enable by registering on desired phases.
 */
export const loggingHook: HookHandler = async (ctx: LifecycleHookContext) => {
    const parts = [`[Hook:${ctx.phase}]`];
    if (ctx.role) parts.push(`role=${ctx.role}`);
    if (ctx.engine) parts.push(`engine=${ctx.engine}`);
    if (ctx.taskId) parts.push(`task=${ctx.taskId}`);
    console.error(parts.join(' '));
};

/**
 * Built-in hook: Track task completion metrics.
 * Logs task outcome summary for observability.
 */
export const taskMetricsHook: HookHandler = async (ctx: LifecycleHookContext) => {
    if (ctx.phase !== 'TaskCompleted') return;
    const status = ctx.payload.finalStatus as string || 'unknown';
    const role = ctx.role || 'unknown';
    console.error(`[Metrics] Task ${ctx.taskId} completed: role=${role}, status=${status}`);
};

/**
 * Built-in hook: Warn on long-running executions.
 * Fires on PostExecute if execution took > 5 minutes.
 */
export const slowExecutionHook: HookHandler = async (ctx: LifecycleHookContext) => {
    if (ctx.phase !== 'PostExecute') return;
    const durationMs = ctx.payload.durationMs as number;
    if (durationMs && durationMs > 300_000) {
        console.error(`[Hook:SlowExecution] role=${ctx.role} took ${Math.round(durationMs / 1000)}s (> 5min threshold)`);
    }
};
