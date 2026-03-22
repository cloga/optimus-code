import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface WorktreeContext {
    /** Whether the workspace is a git worktree (not the main working tree) */
    isWorktree: boolean;
    /** The root of the current working tree (always set) */
    currentRoot: string;
    /** The root of the main working tree (same as currentRoot if not a worktree) */
    mainRoot: string;
}

const worktreeCache = new Map<string, WorktreeContext>();

/**
 * Detect whether the given workspace is a git worktree and resolve the main worktree root.
 *
 * In a worktree layout:
 *   main:      /repo/.git/           (real git dir)
 *   worktree:  /repo-feature/.git    (file pointing to /repo/.git/worktrees/feature)
 *
 * We use `git rev-parse --show-toplevel` (current worktree root) and
 * `git rev-parse --git-common-dir` (shared .git) to find the main root.
 */
export function detectWorktreeContext(workspacePath: string): WorktreeContext {
    const resolved = path.resolve(workspacePath);
    const cached = worktreeCache.get(resolved);
    if (cached) return cached;

    try {
        const currentRoot = execSync('git rev-parse --show-toplevel', {
            cwd: resolved,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        const gitCommonDir = execSync('git rev-parse --git-common-dir', {
            cwd: resolved,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        // git-common-dir returns a path relative to cwd or absolute.
        // For the main worktree it returns ".git"; for linked worktrees it returns
        // something like "/repo/.git" or "../../.git" (relative).
        const absoluteCommonDir = path.resolve(resolved, gitCommonDir);

        // The main worktree root is the parent of the common .git dir
        const mainRoot = path.dirname(absoluteCommonDir);

        // Normalize to forward slashes for comparison, then compare
        const normalizedCurrent = path.resolve(currentRoot);
        const normalizedMain = path.resolve(mainRoot);
        const isWorktree = normalizedCurrent !== normalizedMain;

        const ctx: WorktreeContext = {
            isWorktree,
            currentRoot: normalizedCurrent,
            mainRoot: normalizedMain
        };
        worktreeCache.set(resolved, ctx);
        return ctx;
    } catch {
        // Not inside a git repo — treat as non-worktree
        const ctx: WorktreeContext = {
            isWorktree: false,
            currentRoot: resolved,
            mainRoot: resolved
        };
        worktreeCache.set(resolved, ctx);
        return ctx;
    }
}

// ---------------------------------------------------------------------------
// Centralized .optimus path resolution
// ---------------------------------------------------------------------------

// Directories that are "shared" project assets — resolve from main worktree.
// These contain config, code, roles, skills, etc. that should be the same
// across all worktrees.
const SHARED_DIRS = new Set([
    'config',
    'dist',
    'roles',
    'skills',
    'memory',
    'specs',
    'personas',
    'runtime-prompts',
    'tasks',
    'scaffold'
]);

// Directories that hold per-workspace runtime state — always resolve locally.
// `agents` are T1 instances with session data, so they're per-worktree.
const STATE_DIRS = new Set([
    'state',
    'results',
    'reviews',
    'system',
    'agents'
]);

/**
 * Resolve a path under `.optimus/`.
 *
 * - Shared resources (config, dist, roles, skills, …) resolve from the main
 *   worktree so all worktrees share one set of project definitions.
 * - State resources (state, results, reviews, system) resolve locally so
 *   each worktree has isolated runtime data.
 *
 * Falls back to main worktree if the local path doesn't exist for shared dirs.
 */
export function resolveOptimusPath(workspacePath: string, ...segments: string[]): string {
    const ctx = detectWorktreeContext(workspacePath);

    if (!ctx.isWorktree || segments.length === 0) {
        // Not a worktree or root-level .optimus — use workspacePath directly
        return path.join(workspacePath, '.optimus', ...segments);
    }

    const topSegment = segments[0];

    if (STATE_DIRS.has(topSegment)) {
        // Per-worktree state — always local
        return path.join(ctx.currentRoot, '.optimus', ...segments);
    }

    if (SHARED_DIRS.has(topSegment)) {
        // Shared resource — prefer main worktree
        const mainPath = path.join(ctx.mainRoot, '.optimus', ...segments);
        const localPath = path.join(ctx.currentRoot, '.optimus', ...segments);

        // If the file/dir exists in main, use it; otherwise fall back to local
        if (fs.existsSync(mainPath)) {
            return mainPath;
        }
        return localPath;
    }

    // Unknown segment — default to local
    return path.join(workspacePath, '.optimus', ...segments);
}

/**
 * Convenience: resolve a shared resource path (config, dist, roles, etc.).
 * Always resolves from main worktree.
 */
export function resolveSharedPath(workspacePath: string, ...segments: string[]): string {
    const ctx = detectWorktreeContext(workspacePath);
    return path.join(ctx.mainRoot, '.optimus', ...segments);
}

/**
 * Convenience: resolve a state path (state, results, reviews, system).
 * Always resolves locally per worktree.
 */
export function resolveStatePath(workspacePath: string, ...segments: string[]): string {
    const ctx = detectWorktreeContext(workspacePath);
    return path.join(ctx.currentRoot, '.optimus', ...segments);
}

/**
 * Ensure state directories exist in the current worktree.
 * Called during MCP server startup.
 */
export function ensureWorktreeStateDirs(workspacePath: string): void {
    const ctx = detectWorktreeContext(workspacePath);
    const root = ctx.currentRoot;

    const stateDirs = [
        path.join(root, '.optimus', 'state'),
        path.join(root, '.optimus', 'state', 'agent-runtime'),
        path.join(root, '.optimus', 'results'),
        path.join(root, '.optimus', 'results', 'agent-runtime'),
        path.join(root, '.optimus', 'reviews'),
        path.join(root, '.optimus', 'system'),
        path.join(root, '.optimus', 'system', 'cron-locks'),
        path.join(root, '.optimus', 'system', 'cron-logs'),
        path.join(root, '.optimus', 'agents')
    ];

    for (const dir of stateDirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

/** Clear detection cache — useful for testing. */
export function clearWorktreeCache(): void {
    worktreeCache.clear();
}
