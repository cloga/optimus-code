/**
 * ACP Process Pool — Persistent ACP adapter manager.
 *
 * Keeps ACP agent processes alive between task invocations to eliminate
 * cold-start overhead (process spawn + initialize handshake ≈ 1-2s per task).
 *
 * Key behaviors:
 *   - One persistent adapter per engine key (e.g., "claude-agent-acp")
 *   - If adapter is busy with a concurrent task, returns an ephemeral adapter
 *   - Idle adapters are evicted after a configurable timeout (default: 5 min)
 *   - Dead adapters are auto-replaced on next request
 *   - Graceful shutdown on process exit
 */
import { AcpAdapter } from '../adapters/AcpAdapter';
import { debugLog } from '../debugLogger';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;       // check every 60s

export class AcpProcessPool {
    private static _instance: AcpProcessPool;

    private pool = new Map<string, AcpAdapter>();
    private idleSweepTimer?: ReturnType<typeof setInterval>;
    private idleTimeoutMs: number;
    private _totalReuses = 0;
    private _totalCreations = 0;

    constructor(idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS) {
        this.idleTimeoutMs = idleTimeoutMs;
    }

    static getInstance(): AcpProcessPool {
        if (!AcpProcessPool._instance) {
            AcpProcessPool._instance = new AcpProcessPool();
            AcpProcessPool._instance.startIdleSweep();
        }
        return AcpProcessPool._instance;
    }

    /** Reset singleton — for testing only */
    static resetInstance(): void {
        if (AcpProcessPool._instance) {
            AcpProcessPool._instance.shutdownAll();
            AcpProcessPool._instance = undefined!;
        }
    }

    /**
     * Get a persistent adapter for the given engine key.
     * Returns warm idle adapter if available, creates new persistent one if not.
     * Falls back to ephemeral adapter if existing adapter is busy (concurrent tasks).
     */
    getOrCreateAdapter(
        key: string,
        executable: string,
        args: string[],
        activityTimeoutMs: number
    ): AcpAdapter {
        const existing = this.pool.get(key);

        if (existing) {
            if (existing.isAlive() && !existing.isBusy()) {
                // Warm hit
                this._totalReuses++;
                const idleMs = existing.idleSince > 0 ? Date.now() - existing.idleSince : 0;
                console.error(`[AcpPool] ♻️  Reusing warm adapter for ${key} (idle ${Math.round(idleMs / 1000)}s, invocations: ${existing.invocationCount})`);
                return existing;
            }

            if (existing.isBusy()) {
                // Multi-session concurrency: reuse the same persistent adapter
                // AcpAdapter now supports concurrent sessions via per-session context routing
                this._totalReuses++;
                console.error(`[AcpPool] 🔀 Reusing busy adapter for ${key} (concurrent session, active sessions: ${existing.invocationCount})`);
                return existing;
            }

            // Dead process — clean up
            console.error(`[AcpPool] 💀 Adapter for ${key} is dead, replacing`);
            existing.shutdown();
            this.pool.delete(key);
        }

        // Create new persistent adapter
        this._totalCreations++;
        const adapter = new AcpAdapter(
            `acp-${key}`,
            `🚀 ${key}`,
            executable, args, activityTimeoutMs,
            true // persistent
        );
        this.pool.set(key, adapter);
        console.error(`[AcpPool] 🆕 Created persistent adapter for ${key}`);
        return adapter;
    }

    /** Start periodic idle sweep */
    private startIdleSweep(): void {
        if (this.idleSweepTimer) return;
        this.idleSweepTimer = setInterval(() => {
            this.evictIdle();
        }, IDLE_SWEEP_INTERVAL_MS);
        // Don't prevent process exit
        if (typeof this.idleSweepTimer.unref === 'function') {
            this.idleSweepTimer.unref();
        }
    }

    /** Evict adapters idle longer than the timeout */
    private evictIdle(): void {
        const now = Date.now();
        for (const [key, adapter] of this.pool) {
            if (!adapter.isBusy() && adapter.idleSince > 0) {
                const idleMs = now - adapter.idleSince;
                if (idleMs >= this.idleTimeoutMs) {
                    console.error(`[AcpPool] 🗑️  Evicting idle adapter ${key} (idle ${Math.round(idleMs / 1000)}s, invocations: ${adapter.invocationCount})`);
                    adapter.shutdown();
                    this.pool.delete(key);
                }
            }
        }
    }

    /** Shutdown all adapters and clear the pool */
    shutdownAll(): void {
        console.error(`[AcpPool] Shutting down all adapters (${this.pool.size} in pool, reuses: ${this._totalReuses}, creations: ${this._totalCreations})`);
        if (this.idleSweepTimer) {
            clearInterval(this.idleSweepTimer);
            this.idleSweepTimer = undefined;
        }
        for (const [key, adapter] of this.pool) {
            try {
                adapter.shutdown();
            } catch (err: any) {
                debugLog('[AcpPool]', `Error shutting down ${key}: ${err.message}`);
            }
        }
        this.pool.clear();
    }

    // --- Stats ---

    get size(): number { return this.pool.size; }
    get totalReuses(): number { return this._totalReuses; }
    get totalCreations(): number { return this._totalCreations; }

    getStatus(): { key: string; alive: boolean; busy: boolean; idleMs: number; invocations: number }[] {
        const result: any[] = [];
        for (const [key, adapter] of this.pool) {
            result.push({
                key,
                alive: adapter.isAlive(),
                busy: adapter.isBusy(),
                idleMs: adapter.idleSince > 0 ? Date.now() - adapter.idleSince : 0,
                invocations: adapter.invocationCount,
            });
        }
        return result;
    }
}
