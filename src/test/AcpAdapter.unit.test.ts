import { describe, it, expect } from 'vitest';
import { AcpAdapter } from '../adapters/AcpAdapter.js';

describe('AcpAdapter (unit)', () => {
  it('module imports without throwing', () => {
    expect(AcpAdapter).toBeDefined();
  });

  describe('constructor', () => {
    it('sets id and name from args', () => {
      const adapter = new AcpAdapter('test-id', 'test-name', 'node');
      expect(adapter.id).toBe('test-id');
      expect(adapter.name).toBe('test-name');
    });

    it('sets isEnabled = true by default', () => {
      const adapter = new AcpAdapter('id', 'name', 'node');
      expect(adapter.isEnabled).toBe(true);
    });

    it('sets modes = [plan, agent] by default', () => {
      const adapter = new AcpAdapter('id', 'name', 'node');
      expect(adapter.modes).toEqual(['plan', 'agent']);
    });

    it('lastSessionId starts as undefined', () => {
      const adapter = new AcpAdapter('id', 'name', 'node');
      expect(adapter.lastSessionId).toBeUndefined();
    });
  });

  describe('extractThinking', () => {
    it('returns empty thinking and full text as output', () => {
      const adapter = new AcpAdapter('id', 'name', 'node');
      const result = adapter.extractThinking('raw output text');
      expect(result.thinking).toBe('');
      expect(result.output).toBe('raw output text');
    });

    it('handles empty string', () => {
      const adapter = new AcpAdapter('id', 'name', 'node');
      const result = adapter.extractThinking('');
      expect(result.thinking).toBe('');
      expect(result.output).toBe('');
    });
  });

  describe('stop()', () => {
    it('does not throw when no process is running', () => {
      const adapter = new AcpAdapter('id', 'name', 'node');
      expect(() => adapter.stop()).not.toThrow();
    });
  });

  describe('spawn env sanitization', () => {
    it('strips repo GitHub tokens for Copilot ACP launches by default', () => {
      const adapter = new AcpAdapter('github-copilot', 'GitHub Copilot', 'copilot', ['--acp', '--stdio']);
      const env = {
        GITHUB_TOKEN: 'repo-pat',
        GH_TOKEN: 'repo-gh-token',
      } as NodeJS.ProcessEnv;

      (adapter as any).sanitizeSpawnEnv(env);

      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
    });

    it('preserves explicit Copilot token overrides for Copilot ACP launches', () => {
      const adapter = new AcpAdapter('github-copilot', 'GitHub Copilot', 'C:\\tools\\copilot.cmd', ['--acp', '--stdio']);
      const env = {
        GITHUB_TOKEN: 'repo-pat',
        GH_TOKEN: 'repo-gh-token',
        COPILOT_GITHUB_TOKEN: 'copilot-token',
      } as NodeJS.ProcessEnv;

      (adapter as any).sanitizeSpawnEnv(env);

      expect(env.GITHUB_TOKEN).toBe('repo-pat');
      expect(env.GH_TOKEN).toBe('repo-gh-token');
    });

    it('does not strip GitHub tokens for non-Copilot ACP launches', () => {
      const adapter = new AcpAdapter('claude-code', 'Claude Code', 'claude-agent-acp', ['--acp', '--stdio']);
      const env = {
        GITHUB_TOKEN: 'repo-pat',
        GH_TOKEN: 'repo-gh-token',
      } as NodeJS.ProcessEnv;

      (adapter as any).sanitizeSpawnEnv(env);

      expect(env.GITHUB_TOKEN).toBe('repo-pat');
      expect(env.GH_TOKEN).toBe('repo-gh-token');
    });
  });
});
