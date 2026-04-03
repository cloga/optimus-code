import { TaskDelegationResult } from '../types/TaskDelegationResult.js';

/**
 * Lifecycle hook phases covering the complete task execution pipeline.
 * Inspired by Claude Code's hook system (PreToolUse, PostToolUse, etc.)
 */
export type HookPhase =
    // Task Lifecycle (council-runner.ts)
    | 'PreTaskSpawn'
    | 'TaskStarted'
    | 'PreDelegation'
    | 'PostDelegation'
    | 'PreSynthesis'
    | 'TaskCompleted'
    // Execution Phases (worker-spawner.ts)
    | 'PreRoleResolution'
    | 'PreSkillLoad'
    | 'SkillInjected'
    | 'PrePromptConstruct'
    | 'PreExecute'
    | 'PostExecute'
    | 'ValidationGate'
    | 'LoopDetection'
    | 'RogueOutputRescue'
    // MCP Dispatch (mcp-server.ts)
    | 'PreToolDispatch'
    | 'PostToolDispatch';

/**
 * Context passed to every hook handler.
 */
export interface LifecycleHookContext {
    /** Which phase fired this hook */
    phase: HookPhase;
    /** Task ID (if within a task context) */
    taskId?: string;
    /** Role executing the task */
    role?: string;
    /** Workspace root path */
    workspacePath?: string;
    /** Engine used for execution */
    engine?: string;
    /** Model used for execution */
    model?: string;
    /** Session ID for the execution */
    sessionId?: string;
    /** Phase-specific payload data */
    payload: Record<string, unknown>;
    /** When the hook fired (epoch ms) */
    timestamp: number;
}

/**
 * Result returned by a hook handler.
 * - Return void or undefined to continue normally
 * - Return { veto: true } to block the operation (only for Pre* phases)
 */
export interface HookResult {
    /** If true, the operation should be blocked (only honored for Pre* phases) */
    veto?: boolean;
    /** Reason for veto (logged if veto is true) */
    reason?: string;
}

/**
 * A hook handler function.
 * Must be async and should complete quickly (< 1s).
 * Errors are caught and logged — hooks never block execution.
 */
export type HookHandler = (context: LifecycleHookContext) => Promise<HookResult | void>;

/**
 * Registry for lifecycle hooks. Provides register/unregister/fire operations.
 * Handlers for the same phase fire serially in registration order.
 * All handler errors are caught and logged — hooks are best-effort.
 */
export class LifecycleHookRegistry {
    private handlers = new Map<HookPhase, HookHandler[]>();

    /** Register a handler for a specific phase */
    register(phase: HookPhase, handler: HookHandler): void {
        const list = this.handlers.get(phase) || [];
        list.push(handler);
        this.handlers.set(phase, list);
    }

    /** Unregister a handler */
    unregister(phase: HookPhase, handler: HookHandler): void {
        const list = this.handlers.get(phase);
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
    }

    /** Get the count of registered handlers for a phase */
    handlerCount(phase: HookPhase): number {
        return this.handlers.get(phase)?.length ?? 0;
    }

    /** Get total count of all registered handlers */
    totalHandlerCount(): number {
        let count = 0;
        for (const list of this.handlers.values()) {
            count += list.length;
        }
        return count;
    }

    /**
     * Fire all handlers for a phase serially.
     * Returns true if any handler vetoed the operation.
     * Errors in individual handlers are caught and logged — they never propagate.
     */
    async fire(context: LifecycleHookContext): Promise<boolean> {
        const list = this.handlers.get(context.phase);
        if (!list || list.length === 0) return false;

        let vetoed = false;
        for (const handler of list) {
            try {
                const result = await handler(context);
                if (result?.veto) {
                    vetoed = true;
                    const reason = result.reason || 'No reason provided';
                    console.error(`[LifecycleHook] ${context.phase} vetoed by handler: ${reason}`);
                    break; // Stop processing further handlers after veto
                }
            } catch (err) {
                // Best-effort: log and continue
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[LifecycleHook] Error in ${context.phase} handler: ${msg}`);
            }
        }
        return vetoed;
    }

    /** Remove all handlers (useful for testing) */
    clear(): void {
        this.handlers.clear();
    }
}

// Singleton instance
let globalRegistry: LifecycleHookRegistry | null = null;

/**
 * Get the global lifecycle hook registry (singleton).
 * Lazily created on first access.
 */
export function getGlobalHookRegistry(): LifecycleHookRegistry {
    if (!globalRegistry) {
        globalRegistry = new LifecycleHookRegistry();
    }
    return globalRegistry;
}

/**
 * Helper to build a LifecycleHookContext with defaults.
 */
export function buildHookContext(
    phase: HookPhase,
    payload: Record<string, unknown>,
    options?: Partial<Omit<LifecycleHookContext, 'phase' | 'payload' | 'timestamp'>>
): LifecycleHookContext {
    return {
        phase,
        payload,
        timestamp: Date.now(),
        ...options,
    };
}

/**
 * Fire a hook on the global registry. Convenience wrapper.
 * Returns true if vetoed, false otherwise.
 */
export async function fireHook(
    phase: HookPhase,
    payload: Record<string, unknown>,
    options?: Partial<Omit<LifecycleHookContext, 'phase' | 'payload' | 'timestamp'>>
): Promise<boolean> {
    return getGlobalHookRegistry().fire(buildHookContext(phase, payload, options));
}
