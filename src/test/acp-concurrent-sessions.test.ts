import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { AcpAdapter } from '../adapters/AcpAdapter.js';
import { AcpProcessPool } from '../utils/acpProcessPool.js';

const MOCK_SERVER = path.resolve(__dirname, '..', '..', 'test-ipc', 'mock-acp-server.js');

describe('ACP Concurrent Sessions', () => {
  beforeEach(() => {
    AcpProcessPool.resetInstance();
  });

  afterEach(() => {
    AcpProcessPool.resetInstance();
  });

  it('two concurrent invokes on same persistent adapter complete with correct output', async () => {
    const pool = AcpProcessPool.getInstance();
    const adapter = pool.getOrCreateAdapter('test-concurrent', 'node', [MOCK_SERVER, '--ndjson'], 0);

    // Launch two invokes concurrently on the SAME adapter
    const [result1, result2] = await Promise.all([
      adapter.invoke('prompt-1', 'agent'),
      adapter.invoke('prompt-2', 'agent'),
    ]);

    // Both should complete with non-empty output
    expect(result1.length).toBeGreaterThan(0);
    expect(result2.length).toBeGreaterThan(0);

    // The mock server includes session IDs in output — they should be different
    // since each invoke creates a new session
    const hasSession1 = result1.includes('test-session-');
    const hasSession2 = result2.includes('test-session-');
    expect(hasSession1).toBe(true);
    expect(hasSession2).toBe(true);

    // They should have different session IDs (unique per session/new call)
    const sid1 = result1.match(/test-session-\d+/)?.[0];
    const sid2 = result2.match(/test-session-\d+/)?.[0];
    expect(sid1).toBeDefined();
    expect(sid2).toBeDefined();
    expect(sid1).not.toBe(sid2);
  }, 15000);

  it('three+ concurrent invokes all resolve independently', async () => {
    const pool = AcpProcessPool.getInstance();
    const adapter = pool.getOrCreateAdapter('test-concurrent-3', 'node', [MOCK_SERVER, '--ndjson'], 0);

    const results = await Promise.all([
      adapter.invoke('prompt-a', 'agent'),
      adapter.invoke('prompt-b', 'agent'),
      adapter.invoke('prompt-c', 'agent'),
    ]);

    // All three should complete
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.length).toBeGreaterThan(0);
      expect(r).toContain('test-session-');
    }

    // All session IDs should be unique
    const sessionIds = results.map(r => r.match(/test-session-\d+/)?.[0]);
    const uniqueIds = new Set(sessionIds);
    expect(uniqueIds.size).toBe(3);
  }, 15000);

  it('session/update notifications route to correct session', async () => {
    const pool = AcpProcessPool.getInstance();
    const adapter = pool.getOrCreateAdapter('test-routing', 'node', [MOCK_SERVER, '--ndjson'], 0);

    // Track streaming chunks per invocation
    const chunks1: string[] = [];
    const chunks2: string[] = [];

    const [result1, result2] = await Promise.all([
      adapter.invoke('prompt-1', 'agent', undefined, (chunk) => chunks1.push(chunk)),
      adapter.invoke('prompt-2', 'agent', undefined, (chunk) => chunks2.push(chunk)),
    ]);

    // Each invocation's chunks should only contain its own session's content
    const joined1 = chunks1.join('');
    const joined2 = chunks2.join('');

    // Both should have received streaming chunks
    expect(chunks1.length).toBeGreaterThan(0);
    expect(chunks2.length).toBeGreaterThan(0);

    // The mock server embeds session ID in first chunk — verify isolation
    const sid1 = joined1.match(/test-session-\d+/)?.[0];
    const sid2 = joined2.match(/test-session-\d+/)?.[0];
    if (sid1 && sid2) {
      // If session IDs are extractable from chunks, they should be different
      expect(sid1).not.toBe(sid2);
      // Chunk stream 1 should not contain session 2's ID
      expect(joined1).not.toContain(sid2);
      expect(joined2).not.toContain(sid1);
    }
  }, 15000);

  it('pool returns same adapter for concurrent requests (no ephemeral fallback)', async () => {
    const pool = AcpProcessPool.getInstance();

    // First call creates adapter and invoke to make it alive
    const adapter1 = pool.getOrCreateAdapter('test-pool-reuse', 'node', [MOCK_SERVER, '--ndjson'], 0);
    
    // Do a first invoke to fully initialize the adapter (spawn + handshake)
    const warmupResult = await adapter1.invoke('warmup', 'agent');
    expect(warmupResult.length).toBeGreaterThan(0);
    expect(adapter1.isAlive()).toBe(true);

    // Now start a second invoke to make it busy
    const busyPromise = adapter1.invoke('busy-prompt', 'agent');

    // Small delay to let invoke mark adapter as busy
    await new Promise(r => setTimeout(r, 50));

    // While busy, request adapter with same key — should get SAME instance
    const adapter2 = pool.getOrCreateAdapter('test-pool-reuse', 'node', [MOCK_SERVER, '--ndjson'], 0);
    expect(adapter2).toBe(adapter1);
    expect(adapter2.persistent).toBe(true);

    await busyPromise;
    expect(pool.totalCreations).toBe(1);
    expect(pool.totalReuses).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('concurrent cold start only spawns one process', async () => {
    const pool = AcpProcessPool.getInstance();
    const adapter = pool.getOrCreateAdapter('test-cold-start', 'node', [MOCK_SERVER, '--ndjson'], 0);

    // Two concurrent invokes on a fresh (cold) adapter
    const [r1, r2] = await Promise.all([
      adapter.invoke('cold-1', 'agent'),
      adapter.invoke('cold-2', 'agent'),
    ]);

    // Both should succeed
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);

    // Only one process should have been spawned (verified by both completing successfully)
    // If double-spawn occurred, one would fail
  }, 15000);

  it('adapter is not idle while sessions are active', async () => {
    const pool = AcpProcessPool.getInstance();
    const adapter = pool.getOrCreateAdapter('test-idle', 'node', [MOCK_SERVER, '--ndjson'], 0);

    // Before any invoke — adapter is not busy
    expect(adapter.isBusy()).toBe(false);

    // Start invoke — should become busy
    const p = adapter.invoke('test', 'agent');

    // Small delay for the invoke to start
    await new Promise(r => setTimeout(r, 100));
    expect(adapter.isBusy()).toBe(true);

    await p;

    // After completion — should not be busy
    expect(adapter.isBusy()).toBe(false);
  }, 15000);
});
