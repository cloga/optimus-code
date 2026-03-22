import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { AcpAdapter } from '../adapters/AcpAdapter.js';
import { AcpProcessPool } from '../utils/acpProcessPool.js';

const MOCK_SERVER = path.resolve(__dirname, '..', '..', 'test-ipc', 'mock-acp-server.js');

describe('AcpProcessPool', () => {
  beforeEach(() => {
    AcpProcessPool.resetInstance();
  });

  afterEach(() => {
    AcpProcessPool.resetInstance();
  });

  describe('singleton', () => {
    it('getInstance returns the same instance', () => {
      const a = AcpProcessPool.getInstance();
      const b = AcpProcessPool.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance clears the singleton', () => {
      const a = AcpProcessPool.getInstance();
      AcpProcessPool.resetInstance();
      const b = AcpProcessPool.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('getOrCreateAdapter', () => {
    it('creates a persistent adapter on first call', () => {
      const pool = AcpProcessPool.getInstance();
      const adapter = pool.getOrCreateAdapter('test-engine', 'node', ['--version'], 0);
      expect(adapter).toBeInstanceOf(AcpAdapter);
      expect(adapter.persistent).toBe(true);
      expect(pool.size).toBe(1);
      expect(pool.totalCreations).toBe(1);
      expect(pool.totalReuses).toBe(0);
    });

    it('returns same adapter on second call (when not alive, creates new)', () => {
      const pool = AcpProcessPool.getInstance();
      const adapter1 = pool.getOrCreateAdapter('test-engine', 'node', ['--version'], 0);
      // adapter1 is not alive (never invoked), so pool replaces it
      const adapter2 = pool.getOrCreateAdapter('test-engine', 'node', ['--version'], 0);
      expect(pool.size).toBe(1);
      // The dead adapter is replaced, so totalCreations = 2
      expect(pool.totalCreations).toBe(2);
    });

    it('creates adapters with different keys independently', () => {
      const pool = AcpProcessPool.getInstance();
      const a = pool.getOrCreateAdapter('engine-a', 'node', [], 0);
      const b = pool.getOrCreateAdapter('engine-b', 'node', [], 0);
      expect(a).not.toBe(b);
      expect(pool.size).toBe(2);
    });
  });

  describe('shutdownAll', () => {
    it('clears all adapters', () => {
      const pool = AcpProcessPool.getInstance();
      pool.getOrCreateAdapter('a', 'node', [], 0);
      pool.getOrCreateAdapter('b', 'node', [], 0);
      expect(pool.size).toBe(2);
      pool.shutdownAll();
      expect(pool.size).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('returns status for all pooled adapters', () => {
      const pool = AcpProcessPool.getInstance();
      pool.getOrCreateAdapter('engine-1', 'node', [], 0);
      const status = pool.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].key).toBe('engine-1');
      expect(status[0].alive).toBe(false); // never invoked
      expect(status[0].busy).toBe(false);
      expect(status[0].invocations).toBe(0);
    });
  });
});

describe('AcpAdapter persistent mode', () => {
  it('persistent flag is set correctly', () => {
    const ephemeral = new AcpAdapter('e', 'E', 'node', [], 0, false);
    expect(ephemeral.persistent).toBe(false);

    const persistent = new AcpAdapter('p', 'P', 'node', [], 0, true);
    expect(persistent.persistent).toBe(true);
  });

  it('isAlive returns false before first invoke', () => {
    const adapter = new AcpAdapter('p', 'P', 'node', [], 0, true);
    expect(adapter.isAlive()).toBe(false);
  });

  it('isBusy returns false when idle', () => {
    const adapter = new AcpAdapter('p', 'P', 'node', [], 0, true);
    expect(adapter.isBusy()).toBe(false);
  });

  it('invocationCount starts at 0', () => {
    const adapter = new AcpAdapter('p', 'P', 'node', [], 0, true);
    expect(adapter.invocationCount).toBe(0);
  });

  it('idleSince starts at 0', () => {
    const adapter = new AcpAdapter('p', 'P', 'node', [], 0, true);
    expect(adapter.idleSince).toBe(0);
  });

  it('shutdown does not throw on uninitialized adapter', () => {
    const adapter = new AcpAdapter('p', 'P', 'node', [], 0, true);
    expect(() => adapter.shutdown()).not.toThrow();
  });

  it('stop does not throw on persistent adapter', () => {
    const adapter = new AcpAdapter('p', 'P', 'node', [], 0, true);
    expect(() => adapter.stop()).not.toThrow();
  });
});

describe('AcpAdapter persistent mode (integration)', () => {
  it('reuses process across multiple invocations', async () => {
    const adapter = new AcpAdapter('persist-test', 'Persist', 'node', [MOCK_SERVER, '--ndjson'], 0, true);

    try {
      // First invocation — spawns process + initialize
      const result1 = await adapter.invoke('hello 1', 'agent');
      expect(result1).toContain('Hello, this is a test response.');
      expect(adapter.invocationCount).toBe(1);
      expect(adapter.isAlive()).toBe(true);
      expect(adapter.isBusy()).toBe(false);
      expect(adapter.idleSince).toBeGreaterThan(0);

      // Second invocation — reuses warm process (no re-spawn, no re-initialize)
      const result2 = await adapter.invoke('hello 2', 'agent');
      expect(result2).toContain('Hello, this is a test response.');
      expect(adapter.invocationCount).toBe(2);
      expect(adapter.isAlive()).toBe(true);

      // Third invocation — still warm
      const result3 = await adapter.invoke('hello 3', 'agent');
      expect(result3).toContain('Hello, this is a test response.');
      expect(adapter.invocationCount).toBe(3);
    } finally {
      adapter.shutdown();
    }

    expect(adapter.isAlive()).toBe(false);
  });

  it('auto-recovers from process crash', async () => {
    const adapter = new AcpAdapter('crash-test', 'Crash', 'node', [MOCK_SERVER, '--ndjson'], 0, true);

    try {
      // Normal invocation
      const result1 = await adapter.invoke('hello', 'agent');
      expect(result1).toContain('Hello, this is a test response.');
      expect(adapter.invocationCount).toBe(1);

      // Kill the process to simulate crash
      adapter.shutdown();
      expect(adapter.isAlive()).toBe(false);

      // Next invocation should auto-recover (respawn + reinitialize)
      const result2 = await adapter.invoke('hello again', 'agent');
      expect(result2).toContain('Hello, this is a test response.');
      expect(adapter.invocationCount).toBe(2);
      expect(adapter.isAlive()).toBe(true);
    } finally {
      adapter.shutdown();
    }
  });

  it('ephemeral adapter kills process after invoke', async () => {
    const adapter = new AcpAdapter('eph-test', 'Eph', 'node', [MOCK_SERVER, '--ndjson'], 0, false);

    const result = await adapter.invoke('hello', 'agent');
    expect(result).toContain('Hello, this is a test response.');
    // Ephemeral: process is killed after invoke
    expect(adapter.isAlive()).toBe(false);
    expect(adapter.persistent).toBe(false);
  });

  it('pool returns warm adapter for reuse', async () => {
    const pool = new AcpProcessPool();

    try {
      const adapter = pool.getOrCreateAdapter('mock-engine', 'node', [MOCK_SERVER, '--ndjson'], 0);
      expect(adapter.persistent).toBe(true);

      // Invoke to make it alive
      const result1 = await adapter.invoke('hello', 'agent');
      expect(result1).toContain('Hello, this is a test response.');
      expect(adapter.isAlive()).toBe(true);
      expect(pool.totalCreations).toBe(1);

      // Get adapter again — should reuse warm one
      const adapter2 = pool.getOrCreateAdapter('mock-engine', 'node', [MOCK_SERVER, '--ndjson'], 0);
      expect(adapter2).toBe(adapter); // Same instance
      expect(pool.totalReuses).toBe(1);
      expect(pool.totalCreations).toBe(1);

      // Invoke on reused adapter
      const result2 = await adapter2.invoke('hello again', 'agent');
      expect(result2).toContain('Hello, this is a test response.');
      expect(adapter2.invocationCount).toBe(2);
    } finally {
      pool.shutdownAll();
    }
  });
});
