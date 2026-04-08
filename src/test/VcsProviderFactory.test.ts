import { afterEach, describe, it, expect } from 'vitest';
import { VcsProviderFactory } from '../adapters/vcs/VcsProviderFactory.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The regex used internally by VcsProviderFactory.getGitHubInfo (private)
const GITHUB_REGEX = /github\.com[\/:]+([^\/]+)\/([^\/.]+)/;

afterEach(() => {
  VcsProviderFactory.clearCache();
});

describe('VcsProviderFactory', () => {
  it('module imports without throwing', () => {
    expect(VcsProviderFactory).toBeDefined();
  });

  it('clearCache() resets static fields without error', () => {
    expect(() => VcsProviderFactory.clearCache()).not.toThrow();
  });

  it('clearCache() can be called multiple times', () => {
    VcsProviderFactory.clearCache();
    expect(() => VcsProviderFactory.clearCache()).not.toThrow();
  });

  describe('GitHub URL regex parsing', () => {
    it('parses HTTPS URL with .git suffix', () => {
      const url = 'https://github.com/cloga/optimus-code.git';
      const match = url.match(GITHUB_REGEX);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('cloga');
      expect(match![2]).toBe('optimus-code');
    });

    it('parses HTTPS URL without .git suffix', () => {
      const url = 'https://github.com/org/my-repo';
      const match = url.match(GITHUB_REGEX);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('org');
      expect(match![2]).toBe('my-repo');
    });

    it('parses SSH URL format', () => {
      const url = 'git@github.com:owner/repo.git';
      const match = url.match(GITHUB_REGEX);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('owner');
      expect(match![2]).toBe('repo');
    });

    it('returns null for non-GitHub URL', () => {
      const url = 'https://dev.azure.com/org/project/_git/repo';
      const match = url.match(GITHUB_REGEX);
      expect(match).toBeNull();
    });
  });

  describe('config diagnostics', () => {
    it('reports the resolved config path and cache state for an explicit project config', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-vcs-diag-'));
      const optimusConfigDir = path.join(workspace, '.optimus', 'config');
      fs.mkdirSync(optimusConfigDir, { recursive: true });
      fs.writeFileSync(path.join(optimusConfigDir, 'vcs.json'), JSON.stringify({
        provider: 'github',
        github: {
          owner: 'cloga',
          repo: 'optimus-code'
        }
      }), 'utf8');

      const before = VcsProviderFactory.getConfigDiagnostics(workspace);
      expect(before.resolvedConfigPath).toBe(path.join(workspace, '.optimus', 'config', 'vcs.json'));
      expect(before.fileExists).toBe(true);
      expect(before.cacheHit).toBe(false);
      expect(before.configuredProvider).toBe('github');

      const provider = await VcsProviderFactory.getProvider(workspace);
      expect(provider.getProviderName()).toBe('github');

      const after = VcsProviderFactory.getConfigDiagnostics(workspace);
      expect(after.cacheHit).toBe(true);
      expect(after.cacheAgeMs).toBeTypeOf('number');
      expect(after.resolutionChain.some(line => line.includes('[exists]'))).toBe(true);
    });
  });
});
