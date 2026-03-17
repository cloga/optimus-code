import { describe, it, expect } from 'vitest';
import {
  parseMemoryEntries,
  validateUserMemoryContent,
  scoreEntry,
  buildMemoryEntry,
  getUserMemoryPath,
  type MemoryEntry,
} from '../managers/MemoryManager.js';

describe('MemoryManager', () => {
  it('module imports without throwing', () => {
    expect(parseMemoryEntries).toBeDefined();
  });

  describe('parseMemoryEntries', () => {
    it('returns [] for empty string', () => {
      expect(parseMemoryEntries('')).toEqual([]);
    });

    it('returns [] for whitespace-only string', () => {
      expect(parseMemoryEntries('   \n  ')).toEqual([]);
    });

    it('parses entry with valid frontmatter', () => {
      const content = `---
id: test_001
date: 2026-01-01T00:00:00.000Z
level: project
category: architecture
tags: [testing, ci]
author: agent
---
This is the body text.`;
      const entries = parseMemoryEntries(content);
      expect(entries.length).toBe(1);
      expect(entries[0].id).toBe('test_001');
      expect(entries[0].category).toBe('architecture');
      expect(entries[0].tags).toContain('testing');
      expect(entries[0].tags).toContain('ci');
      expect(entries[0].body).toBe('This is the body text.');
    });

    it('wraps unstructured text as legacy entry', () => {
      const content = 'Just some plain text without frontmatter.';
      const entries = parseMemoryEntries(content);
      expect(entries.length).toBe(1);
      expect(entries[0].category).toBe('legacy');
    });
  });

  describe('validateUserMemoryContent', () => {
    it('returns valid:true for plain text', () => {
      expect(validateUserMemoryContent('hello world')).toEqual({ valid: true });
    });

    it('returns valid:false for password= pattern', () => {
      const result = validateUserMemoryContent('password=secret');
      expect(result.valid).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('returns valid:false for api_key= pattern', () => {
      const result = validateUserMemoryContent('api_key=abc123');
      expect(result.valid).toBe(false);
    });

    it('returns valid:false for shell command injection', () => {
      const result = validateUserMemoryContent('$(rm -rf /)');
      expect(result.valid).toBe(false);
    });
  });

  describe('scoreEntry', () => {
    const baseEntry: MemoryEntry = {
      id: 'test_score',
      date: new Date().toISOString(),  // today — gets recency bonus
      level: 'project',
      category: 'pm',
      tags: ['planning'],
      author: 'agent',
      body: 'some content',
    };

    it('returns score > 0 when category matches role', () => {
      const score = scoreEntry(baseEntry, 'pm');
      expect(score).toBeGreaterThan(0);
    });

    it('returns score >= 0 for non-matching role', () => {
      const score = scoreEntry(baseEntry, 'security-expert');
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('returns higher score for matching vs non-matching role (same entry)', () => {
      const matchScore = scoreEntry(baseEntry, 'pm');
      const noMatchScore = scoreEntry({ ...baseEntry, date: '' }, 'random-role');
      expect(matchScore).toBeGreaterThan(noMatchScore);
    });
  });

  describe('buildMemoryEntry', () => {
    it('returns string containing frontmatter delimiters and keys', () => {
      const entry = buildMemoryEntry({
        level: 'project',
        category: 'architecture',
        tags: ['ci', 'testing'],
        content: 'Test memory content',
        author: 'senior-full-stack-builder',
      });
      expect(entry).toContain('---');
      expect(entry).toContain('id:');
      expect(entry).toContain('level:');
      expect(entry).toContain('category:');
      expect(entry).toContain('Test memory content');
    });
  });

  describe('getUserMemoryPath', () => {
    it('returns a non-empty string', () => {
      const p = getUserMemoryPath();
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });

    it('path contains user-memory.md', () => {
      const p = getUserMemoryPath();
      expect(p).toContain('user-memory.md');
    });
  });
});
