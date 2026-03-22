import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
    listWorktrees,
    createWorktree,
    removeWorktree,
    findWorktreeByBranch,
    ensureWorktreeForBranch
} from '../utils/worktreeManager';
import { clearWorktreeCache } from '../utils/worktree';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mgr-test-'));
    tmpDirs.push(dir);
    return dir;
}

function initGitRepo(): string {
    const dir = makeTmpDir();
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
    return dir;
}

afterEach(() => {
    clearWorktreeCache();
    // Clean up worktrees before removing dirs
    for (const dir of tmpDirs) {
        try {
            const worktrees = listWorktrees(dir);
            for (const wt of worktrees) {
                if (!wt.isMain) {
                    try { execSync(`git worktree remove "${wt.path}" --force`, { cwd: dir, stdio: 'pipe' }); } catch {}
                }
            }
        } catch {}
    }
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
});

describe('worktree manager — list', () => {
    it('lists the main worktree for a normal repo', () => {
        const repo = initGitRepo();
        const worktrees = listWorktrees(repo);
        expect(worktrees.length).toBe(1);
        expect(worktrees[0].isMain).toBe(true);
        expect(worktrees[0].branch).toBeTruthy();
    });

    it('returns empty for non-git directory', () => {
        const dir = makeTmpDir();
        const worktrees = listWorktrees(dir);
        expect(worktrees).toEqual([]);
    });
});

describe('worktree manager — create', () => {
    it('creates a new worktree with a new branch', () => {
        const repo = initGitRepo();
        const result = createWorktree(repo, { branch: 'feat-test' });

        expect(result.created).toBe(true);
        expect(result.branch).toBe('feat-test');
        expect(fs.existsSync(result.worktreePath)).toBe(true);
        tmpDirs.push(result.worktreePath);

        // Should have .optimus/state set up
        expect(fs.existsSync(path.join(result.worktreePath, '.optimus', 'state'))).toBe(true);

        // Should show up in list
        const worktrees = listWorktrees(repo);
        expect(worktrees.length).toBe(2);
    });

    it('returns existing worktree without re-creating', () => {
        const repo = initGitRepo();
        const result1 = createWorktree(repo, { branch: 'feat-existing' });
        tmpDirs.push(result1.worktreePath);

        const result2 = createWorktree(repo, { branch: 'feat-existing' });
        expect(result2.created).toBe(false);
        expect(result2.worktreePath).toBe(result1.worktreePath);
    });

    it('creates worktree from a specified base branch', () => {
        const repo = initGitRepo();
        execSync('git checkout -b develop', { cwd: repo, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "develop commit"', { cwd: repo, stdio: 'pipe' });
        execSync('git checkout master', { cwd: repo, stdio: 'pipe' });

        const result = createWorktree(repo, { branch: 'feat-from-develop', baseBranch: 'develop' });
        tmpDirs.push(result.worktreePath);
        expect(result.created).toBe(true);
    });
});

describe('worktree manager — find', () => {
    it('finds worktree by branch name', () => {
        const repo = initGitRepo();
        const created = createWorktree(repo, { branch: 'feat-find' });
        tmpDirs.push(created.worktreePath);

        const found = findWorktreeByBranch(repo, 'feat-find');
        expect(found).not.toBeNull();
        expect(found!.branch).toBe('feat-find');
        expect(found!.path).toBe(created.worktreePath);
    });

    it('returns null for non-existent branch', () => {
        const repo = initGitRepo();
        expect(findWorktreeByBranch(repo, 'nonexistent')).toBeNull();
    });
});

describe('worktree manager — remove', () => {
    it('removes an existing worktree', () => {
        const repo = initGitRepo();
        const created = createWorktree(repo, { branch: 'feat-remove' });
        tmpDirs.push(created.worktreePath);

        const message = removeWorktree(repo, 'feat-remove');
        expect(message).toContain('Removed');
        expect(listWorktrees(repo).length).toBe(1);
    });

    it('throws when removing non-existent worktree', () => {
        const repo = initGitRepo();
        expect(() => removeWorktree(repo, 'nonexistent')).toThrow('No worktree found');
    });

    it('throws when trying to remove main worktree', () => {
        const repo = initGitRepo();
        const worktrees = listWorktrees(repo);
        const mainBranch = worktrees[0].branch;
        expect(() => removeWorktree(repo, mainBranch)).toThrow('Cannot remove the main worktree');
    });
});

describe('worktree manager — ensureWorktreeForBranch', () => {
    it('creates worktree on first call and returns same path on second', () => {
        const repo = initGitRepo();
        const path1 = ensureWorktreeForBranch(repo, 'feat-ensure');
        tmpDirs.push(path1);
        expect(fs.existsSync(path1)).toBe(true);

        clearWorktreeCache();
        const path2 = ensureWorktreeForBranch(repo, 'feat-ensure');
        expect(path2).toBe(path1);
    });
});
