import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
    detectWorktreeContext,
    resolveOptimusPath,
    resolveSharedPath,
    resolveStatePath,
    ensureWorktreeStateDirs,
    clearWorktreeCache
} from '../utils/worktree';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    clearWorktreeCache();
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
});

describe('worktree detection', () => {
    it('detects non-worktree (main repo) correctly', () => {
        // Use the actual repo we're running in
        const ctx = detectWorktreeContext(process.cwd());
        // In the main repo, isWorktree should be false and roots should match
        expect(ctx.isWorktree).toBe(false);
        expect(ctx.currentRoot).toBe(ctx.mainRoot);
    });

    it('returns non-worktree for directories outside a git repo', () => {
        const tmpDir = makeTmpDir();
        const ctx = detectWorktreeContext(tmpDir);
        expect(ctx.isWorktree).toBe(false);
        expect(ctx.currentRoot).toBe(path.resolve(tmpDir));
        expect(ctx.mainRoot).toBe(path.resolve(tmpDir));
    });

    it('caches results for the same path', () => {
        const ctx1 = detectWorktreeContext(process.cwd());
        const ctx2 = detectWorktreeContext(process.cwd());
        expect(ctx1).toBe(ctx2); // same object reference
    });

    it('cache is cleared by clearWorktreeCache', () => {
        const ctx1 = detectWorktreeContext(process.cwd());
        clearWorktreeCache();
        const ctx2 = detectWorktreeContext(process.cwd());
        expect(ctx1).not.toBe(ctx2); // different object references
        expect(ctx1).toEqual(ctx2); // but same values
    });
});

describe('worktree path resolution — non-worktree', () => {
    it('resolves shared paths under .optimus/', () => {
        const cwd = process.cwd();
        const result = resolveOptimusPath(cwd, 'config', 'system-instructions.md');
        expect(result).toBe(path.join(cwd, '.optimus', 'config', 'system-instructions.md'));
    });

    it('resolves state paths under .optimus/', () => {
        const cwd = process.cwd();
        const result = resolveOptimusPath(cwd, 'state', 'task-manifest.json');
        expect(result).toBe(path.join(cwd, '.optimus', 'state', 'task-manifest.json'));
    });

    it('resolves roles, skills, agents correctly', () => {
        const cwd = process.cwd();
        expect(resolveOptimusPath(cwd, 'roles')).toBe(path.join(cwd, '.optimus', 'roles'));
        expect(resolveOptimusPath(cwd, 'skills', 'role-creator', 'SKILL.md'))
            .toBe(path.join(cwd, '.optimus', 'skills', 'role-creator', 'SKILL.md'));
        expect(resolveOptimusPath(cwd, 'agents'))
            .toBe(path.join(cwd, '.optimus', 'agents'));
    });

    it('resolveSharedPath always uses mainRoot', () => {
        const cwd = process.cwd();
        const result = resolveSharedPath(cwd, 'config', 'vcs.json');
        expect(result).toBe(path.join(cwd, '.optimus', 'config', 'vcs.json'));
    });

    it('resolveStatePath always uses currentRoot', () => {
        const cwd = process.cwd();
        const result = resolveStatePath(cwd, 'state', 'engine-health.json');
        expect(result).toBe(path.join(cwd, '.optimus', 'state', 'engine-health.json'));
    });
});

describe('worktree path resolution — with real worktree', () => {
    let mainDir: string;
    let worktreeDir: string;
    let hasWorktree = false;

    // Create a real git repo + worktree for integration testing
    function setupWorktree() {
        mainDir = makeTmpDir();
        worktreeDir = makeTmpDir();
        // Remove worktreeDir so git worktree add can create it
        fs.rmSync(worktreeDir, { recursive: true });

        try {
            execSync('git init', { cwd: mainDir, stdio: 'pipe' });
            execSync('git commit --allow-empty -m "init"', { cwd: mainDir, stdio: 'pipe' });
            execSync('git branch feature-x', { cwd: mainDir, stdio: 'pipe' });
            execSync(`git worktree add "${worktreeDir}" feature-x`, { cwd: mainDir, stdio: 'pipe' });
            hasWorktree = true;

            // Create .optimus shared resources in main
            fs.mkdirSync(path.join(mainDir, '.optimus', 'config'), { recursive: true });
            fs.mkdirSync(path.join(mainDir, '.optimus', 'roles'), { recursive: true });
            fs.writeFileSync(path.join(mainDir, '.optimus', 'config', 'system-instructions.md'), '# test', 'utf8');
            fs.writeFileSync(path.join(mainDir, '.optimus', 'roles', 'architect.md'), '# architect', 'utf8');
        } catch {
            hasWorktree = false;
        }
    }

    afterEach(() => {
        if (hasWorktree) {
            try {
                execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: mainDir, stdio: 'pipe' });
            } catch {}
        }
    });

    it('detects worktree vs main correctly', () => {
        setupWorktree();
        if (!hasWorktree) return; // skip if git worktree not available

        clearWorktreeCache();
        const mainCtx = detectWorktreeContext(mainDir);
        expect(mainCtx.isWorktree).toBe(false);

        clearWorktreeCache();
        const wtCtx = detectWorktreeContext(worktreeDir);
        expect(wtCtx.isWorktree).toBe(true);
        expect(path.resolve(wtCtx.mainRoot)).toBe(path.resolve(mainDir));
        expect(path.resolve(wtCtx.currentRoot)).toBe(path.resolve(worktreeDir));
    });

    it('resolves shared resources from main worktree', () => {
        setupWorktree();
        if (!hasWorktree) return;

        clearWorktreeCache();
        // Config exists in main → should resolve from main
        const configPath = resolveOptimusPath(worktreeDir, 'config', 'system-instructions.md');
        expect(configPath).toBe(path.join(mainDir, '.optimus', 'config', 'system-instructions.md'));
        expect(fs.existsSync(configPath)).toBe(true);

        // Roles exist in main → should resolve from main
        const rolePath = resolveOptimusPath(worktreeDir, 'roles', 'architect.md');
        expect(rolePath).toBe(path.join(mainDir, '.optimus', 'roles', 'architect.md'));
    });

    it('resolves state paths locally in worktree', () => {
        setupWorktree();
        if (!hasWorktree) return;

        clearWorktreeCache();
        const statePath = resolveOptimusPath(worktreeDir, 'state', 'task-manifest.json');
        expect(statePath).toBe(path.join(worktreeDir, '.optimus', 'state', 'task-manifest.json'));

        const agentsPath = resolveOptimusPath(worktreeDir, 'agents');
        expect(agentsPath).toBe(path.join(worktreeDir, '.optimus', 'agents'));
    });

    it('ensureWorktreeStateDirs creates dirs in worktree', () => {
        setupWorktree();
        if (!hasWorktree) return;

        clearWorktreeCache();
        ensureWorktreeStateDirs(worktreeDir);

        expect(fs.existsSync(path.join(worktreeDir, '.optimus', 'state'))).toBe(true);
        expect(fs.existsSync(path.join(worktreeDir, '.optimus', 'results'))).toBe(true);
        expect(fs.existsSync(path.join(worktreeDir, '.optimus', 'reviews'))).toBe(true);
        expect(fs.existsSync(path.join(worktreeDir, '.optimus', 'system'))).toBe(true);
        expect(fs.existsSync(path.join(worktreeDir, '.optimus', 'agents'))).toBe(true);
        // Should NOT create shared dirs in worktree
        expect(fs.existsSync(path.join(worktreeDir, '.optimus', 'config'))).toBe(false);
        expect(fs.existsSync(path.join(worktreeDir, '.optimus', 'roles'))).toBe(false);
    });
});

describe('ensureWorktreeStateDirs — non-worktree', () => {
    it('creates all state directories', () => {
        const tmpDir = makeTmpDir();
        ensureWorktreeStateDirs(tmpDir);

        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'state'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'state', 'agent-runtime'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'results'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'results', 'agent-runtime'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'reviews'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'system'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'system', 'cron-locks'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'system', 'cron-logs'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.optimus', 'agents'))).toBe(true);
    });
});
