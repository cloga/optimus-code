/**
 * WorktreeManager — Git worktree lifecycle management
 *
 * Enables multi-branch parallel development by creating isolated worktrees,
 * each with its own working directory and state, sharing the same git history.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ensureWorktreeStateDirs } from './worktree';

export interface WorktreeInfo {
    /** Absolute path to the worktree directory */
    path: string;
    /** Branch checked out in this worktree */
    branch: string;
    /** HEAD commit SHA */
    head: string;
    /** Whether this is the main worktree */
    isMain: boolean;
    /** Whether the worktree has .optimus/ state set up */
    hasOptimusState: boolean;
}

export interface CreateWorktreeOptions {
    /** Branch name to create/checkout */
    branch: string;
    /** Base branch to create from (defaults to current branch) */
    baseBranch?: string;
    /** Explicit path for the worktree (auto-generated if omitted) */
    worktreePath?: string;
    /** Create new branch (-b) or checkout existing */
    createBranch?: boolean;
}

export interface CreateWorktreeResult {
    worktreePath: string;
    branch: string;
    created: boolean;
    message: string;
}

/**
 * Generate default worktree path: `../<repo-name>-wt-<branch>/`
 */
function defaultWorktreePath(mainRoot: string, branch: string): string {
    const repoName = path.basename(mainRoot);
    const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '-');
    return path.resolve(mainRoot, '..', `${repoName}-wt-${safeBranch}`);
}

/**
 * List all git worktrees for the repository.
 */
export function listWorktrees(workspacePath: string): WorktreeInfo[] {
    try {
        const raw = execSync('git worktree list --porcelain', {
            cwd: workspacePath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const worktrees: WorktreeInfo[] = [];
        const blocks = raw.split('\n\n').filter(b => b.trim());

        for (const block of blocks) {
            const lines = block.split('\n');
            let wtPath = '';
            let head = '';
            let branch = '';
            let isMain = false;

            for (const line of lines) {
                if (line.startsWith('worktree ')) {
                    wtPath = line.slice('worktree '.length).trim();
                } else if (line.startsWith('HEAD ')) {
                    head = line.slice('HEAD '.length).trim();
                } else if (line.startsWith('branch ')) {
                    branch = line.slice('branch '.length).trim()
                        .replace('refs/heads/', '');
                } else if (line.trim() === 'bare') {
                    // skip bare repos
                }
            }

            if (wtPath) {
                const normalizedPath = path.resolve(wtPath); // normalize slashes
                const hasOptimusState = fs.existsSync(path.join(normalizedPath, '.optimus', 'state'));
                worktrees.push({
                    path: normalizedPath,
                    branch: branch || '(detached)',
                    head: head.slice(0, 8),
                    isMain: worktrees.length === 0, // first entry is always main
                    hasOptimusState
                });
            }
        }

        return worktrees;
    } catch (e: any) {
        console.error(`[WorktreeManager] Failed to list worktrees: ${e.message}`);
        return [];
    }
}

/**
 * Find an existing worktree by branch name.
 */
export function findWorktreeByBranch(workspacePath: string, branch: string): WorktreeInfo | null {
    const worktrees = listWorktrees(workspacePath);
    return worktrees.find(w => w.branch === branch) || null;
}

/**
 * Create a new git worktree for parallel development.
 * If the worktree already exists, returns it without modification.
 */
export function createWorktree(workspacePath: string, options: CreateWorktreeOptions): CreateWorktreeResult {
    const { branch, baseBranch, createBranch = true } = options;

    // Check if worktree for this branch already exists
    const existing = findWorktreeByBranch(workspacePath, branch);
    if (existing) {
        ensureWorktreeStateDirs(existing.path);
        return {
            worktreePath: existing.path,
            branch,
            created: false,
            message: `Worktree for branch '${branch}' already exists at ${existing.path}`
        };
    }

    const wtPath = options.worktreePath || defaultWorktreePath(workspacePath, branch);

    // Check if branch already exists
    let branchExists = false;
    try {
        execSync(`git rev-parse --verify ${branch}`, {
            cwd: workspacePath,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        branchExists = true;
    } catch {
        branchExists = false;
    }

    // Build git worktree add command
    let cmd: string;
    if (branchExists) {
        cmd = `git worktree add "${wtPath}" ${branch}`;
    } else if (createBranch) {
        const base = baseBranch || 'HEAD';
        cmd = `git worktree add -b ${branch} "${wtPath}" ${base}`;
    } else {
        throw new Error(`Branch '${branch}' does not exist and createBranch is false`);
    }

    execSync(cmd, {
        cwd: workspacePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Ensure .optimus state directories exist in the new worktree
    ensureWorktreeStateDirs(wtPath);

    return {
        worktreePath: wtPath,
        branch,
        created: true,
        message: `Created worktree at ${wtPath} on branch '${branch}'${branchExists ? '' : ` (new branch from ${baseBranch || 'HEAD'})`}`
    };
}

/**
 * Remove a git worktree.
 */
export function removeWorktree(workspacePath: string, branch: string, force: boolean = false): string {
    const existing = findWorktreeByBranch(workspacePath, branch);
    if (!existing) {
        throw new Error(`No worktree found for branch '${branch}'`);
    }
    if (existing.isMain) {
        throw new Error(`Cannot remove the main worktree`);
    }

    const forceFlag = force ? ' --force' : '';
    execSync(`git worktree remove "${existing.path}"${forceFlag}`, {
        cwd: workspacePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
    });

    return `Removed worktree at ${existing.path} (branch: ${branch})`;
}

/**
 * Ensure a worktree exists for the given branch, creating it if necessary.
 * Returns the worktree path. Used by delegate_task when `branch` is specified.
 */
export function ensureWorktreeForBranch(
    workspacePath: string,
    branch: string,
    baseBranch?: string
): string {
    const result = createWorktree(workspacePath, { branch, baseBranch });
    if (result.created) {
        console.error(`[WorktreeManager] ${result.message}`);
    }
    return result.worktreePath;
}
