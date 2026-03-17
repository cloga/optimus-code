import { describe, it, expect } from 'vitest';
import { VcsProviderFactory } from '../adapters/vcs/VcsProviderFactory.js';

// The regex used internally by VcsProviderFactory.getGitHubInfo (private)
const GITHUB_REGEX = /github\.com[\/:]+([^\/]+)\/([^\/.]+)/;

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
});
