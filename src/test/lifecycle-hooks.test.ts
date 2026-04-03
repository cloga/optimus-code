import { describe, it, expect, beforeEach } from 'vitest';
import {
    LifecycleHookRegistry,
    HookPhase,
    LifecycleHookContext,
    HookHandler,
    buildHookContext,
    fireHook,
    getGlobalHookRegistry,
} from '../harness/lifecycle-hooks.js';

describe('LifecycleHookRegistry', () => {
    let registry: LifecycleHookRegistry;

    beforeEach(() => {
        registry = new LifecycleHookRegistry();
    });

    describe('register and fire', () => {
        it('fires a registered handler with correct context', async () => {
            const calls: LifecycleHookContext[] = [];
            const handler: HookHandler = async (ctx) => { calls.push(ctx); };

            registry.register('PreExecute', handler);
            const ctx = buildHookContext('PreExecute', { promptLength: 1000 }, { role: 'dev' });
            await registry.fire(ctx);

            expect(calls).toHaveLength(1);
            expect(calls[0].phase).toBe('PreExecute');
            expect(calls[0].role).toBe('dev');
            expect(calls[0].payload.promptLength).toBe(1000);
            expect(calls[0].timestamp).toBeGreaterThan(0);
        });

        it('does not fire handlers for unregistered phases', async () => {
            const calls: string[] = [];
            registry.register('PreExecute', async () => { calls.push('fired'); });

            await registry.fire(buildHookContext('PostExecute', {}));

            expect(calls).toHaveLength(0);
        });
    });

    describe('multiple handlers', () => {
        it('fires multiple handlers in registration order', async () => {
            const order: number[] = [];
            registry.register('TaskStarted', async () => { order.push(1); });
            registry.register('TaskStarted', async () => { order.push(2); });
            registry.register('TaskStarted', async () => { order.push(3); });

            await registry.fire(buildHookContext('TaskStarted', {}));

            expect(order).toEqual([1, 2, 3]);
        });
    });

    describe('error isolation', () => {
        it('catches handler errors and continues', async () => {
            const calls: string[] = [];
            registry.register('PostExecute', async () => { throw new Error('boom'); });
            registry.register('PostExecute', async () => { calls.push('second'); });

            // Should not throw
            const vetoed = await registry.fire(buildHookContext('PostExecute', {}));

            expect(vetoed).toBe(false);
            expect(calls).toEqual(['second']);
        });
    });

    describe('veto mechanism', () => {
        it('returns true when a handler vetoes', async () => {
            registry.register('PreDelegation', async () => {
                return { veto: true, reason: 'Rate limited' };
            });

            const vetoed = await registry.fire(buildHookContext('PreDelegation', {}));
            expect(vetoed).toBe(true);
        });

        it('stops processing after veto', async () => {
            const calls: string[] = [];
            registry.register('PreDelegation', async () => {
                calls.push('first');
                return { veto: true, reason: 'blocked' };
            });
            registry.register('PreDelegation', async () => {
                calls.push('second'); // should NOT be called
            });

            await registry.fire(buildHookContext('PreDelegation', {}));
            expect(calls).toEqual(['first']);
        });

        it('does not veto when handler returns void', async () => {
            registry.register('PreExecute', async () => { /* no return */ });

            const vetoed = await registry.fire(buildHookContext('PreExecute', {}));
            expect(vetoed).toBe(false);
        });
    });

    describe('unregister', () => {
        it('removes a specific handler', async () => {
            const calls: string[] = [];
            const handler: HookHandler = async () => { calls.push('fired'); };

            registry.register('TaskCompleted', handler);
            registry.unregister('TaskCompleted', handler);
            await registry.fire(buildHookContext('TaskCompleted', {}));

            expect(calls).toHaveLength(0);
        });
    });

    describe('clear', () => {
        it('removes all handlers', async () => {
            registry.register('PreExecute', async () => {});
            registry.register('PostExecute', async () => {});
            expect(registry.totalHandlerCount()).toBe(2);

            registry.clear();
            expect(registry.totalHandlerCount()).toBe(0);
        });
    });

    describe('handlerCount', () => {
        it('returns correct count per phase', () => {
            registry.register('PreExecute', async () => {});
            registry.register('PreExecute', async () => {});
            registry.register('PostExecute', async () => {});

            expect(registry.handlerCount('PreExecute')).toBe(2);
            expect(registry.handlerCount('PostExecute')).toBe(1);
            expect(registry.handlerCount('TaskStarted')).toBe(0);
        });
    });

    describe('getGlobalHookRegistry', () => {
        it('returns a singleton', () => {
            const a = getGlobalHookRegistry();
            const b = getGlobalHookRegistry();
            expect(a).toBe(b);
        });
    });
});
