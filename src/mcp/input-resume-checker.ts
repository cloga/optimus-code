import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { TaskManifestManager, TaskRecord } from "../managers/TaskManifestManager";
import { VcsProviderFactory } from "../adapters/vcs/VcsProviderFactory";
import { sanitizeExternalContent, wrapUntrusted } from "../utils/sanitizeExternalContent";
import { AgentLockManager } from "./worker-spawner";

const DEFAULT_PAUSE_TIMEOUT_MS = 48 * 60 * 60 * 1000; // 48 hours
const ALLOWED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Checks all awaiting_input tasks and resumes them if a human has responded,
 * or expires them if the timeout has elapsed.
 */
export async function checkAndResumeAwaitingTasks(workspacePath: string): Promise<string> {
    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const awaitingTasks = Object.values(manifest).filter(
        (t: TaskRecord) => t.status === 'awaiting_input'
    );

    if (awaitingTasks.length === 0) return '';

    const actions: string[] = [];
    const lockManager = new AgentLockManager(workspacePath);
    lockManager.cleanStaleLocks();

    for (const task of awaitingTasks) {
        try {
            const result = await processAwaitingTask(task, workspacePath, lockManager);
            if (result) actions.push(result);
        } catch (e: any) {
            console.error(`[ResumeChecker] Error processing task ${task.taskId}: ${e.message}`);
            actions.push(`Error on ${task.taskId}: ${e.message}`);
        }
    }

    return actions.length > 0 ? actions.join('; ') : '';
}

async function processAwaitingTask(
    task: TaskRecord,
    workspacePath: string,
    lockManager: AgentLockManager
): Promise<string | null> {
    const timeoutMs = task.max_pause_timeout_ms || DEFAULT_PAUSE_TIMEOUT_MS;
    const pauseTimestamp = task.pause_timestamp || task.heartbeatTime;
    const elapsed = Date.now() - pauseTimestamp;

    // Check timeout → expire
    if (elapsed > timeoutMs) {
        TaskManifestManager.updateTask(workspacePath, task.taskId, {
            status: 'expired',
            error_message: 'Human input request expired without a response after 48h.'
        });

        // Best-effort: comment on the linked Issue
        if (task.github_issue_number) {
            try {
                const vcs = await VcsProviderFactory.getProvider(workspacePath);
                await vcs.addComment(
                    'workitem',
                    task.github_issue_number,
                    `⏰ **Input Request Expired**\n\nThe question asked by agent \`${task.role || 'unknown'}\` has expired without a response (48h timeout). Task has been marked as \`expired\`.`
                );
            } catch (e: any) {
                console.error(`[ResumeChecker] Failed to post expiry comment on issue #${task.github_issue_number}: ${e.message}`);
            }
        }

        return `Expired task ${task.taskId}`;
    }

    // No linked issue → can't check for comments
    if (!task.github_issue_number) return null;

    // Fetch comments since pause
    let vcs;
    try {
        vcs = await VcsProviderFactory.getProvider(workspacePath);
    } catch (e: any) {
        console.error(`[ResumeChecker] Failed to get VCS provider: ${e.message}`);
        return null;
    }

    const sinceIso = new Date(pauseTimestamp).toISOString();
    let comments;
    try {
        comments = await vcs.getComments('workitem', task.github_issue_number, sinceIso);
    } catch (e: any) {
        console.error(`[ResumeChecker] Failed to fetch comments for issue #${task.github_issue_number}: ${e.message}`);
        return null;
    }

    // Filter: human-only comments (author_association in allowed set, not bots)
    const humanComments = comments.filter(c => {
        if (!c.author_association || !ALLOWED_AUTHOR_ASSOCIATIONS.has(c.author_association)) return false;
        if (c.author.endsWith('[bot]')) return false;
        // Skip our own pause question comment
        if (task.pause_github_comment_id && c.id === task.pause_github_comment_id) return false;
        return true;
    });

    if (humanComments.length === 0) return null;

    // Use the latest human comment as the answer
    const answer = humanComments[humanComments.length - 1];

    // Acquire lock to prevent duplicate resume
    const lockKey = `resume_${task.taskId}`;
    try {
        await lockManager.acquireLock(lockKey);
    } catch (e: any) {
        console.error(`[ResumeChecker] Failed to acquire lock for ${task.taskId}: ${e.message}`);
        return null;
    }

    try {
        // Re-check status under lock (another tick may have already processed this)
        const freshManifest = TaskManifestManager.loadManifest(workspacePath);
        const freshTask = freshManifest[task.taskId];
        if (!freshTask || freshTask.status !== 'awaiting_input') {
            return null; // Already processed
        }

        // Sanitize the human answer
        const { sanitized: sanitizedAnswer } = sanitizeExternalContent(answer.body, `human-answer:issue-${task.github_issue_number}`);

        // Build resume context for the fresh agent
        const resumeTaskDescription = buildResumeContext(task, sanitizedAnswer);

        // Create a new task record for the resume agent
        const resumeTaskId = `resume_${task.taskId}_${Date.now()}`;
        const outputPath = task.output_path || `.optimus/results/resume_${task.taskId}.md`;

        // Mark original task as completed (not running) to prevent the reaper from killing it.
        // Only the new resume task should be in running state.
        TaskManifestManager.updateTask(workspacePath, task.taskId, {
            status: 'completed',
            human_answer: sanitizedAnswer,
            resume_task_id: resumeTaskId
        });

        TaskManifestManager.createTask(workspacePath, {
            taskId: resumeTaskId,
            type: 'delegate_task',
            role: task.role || 'senior-full-stack-builder',
            task_description: resumeTaskDescription,
            output_path: outputPath,
            workspacePath,
            parent_issue_number: task.parent_issue_number,
            github_issue_number: task.github_issue_number,
            delegation_depth: task.delegation_depth || 0
        });

        // Spawn fresh agent process
        const child = spawn(process.execPath, [
            path.join(__dirname, '..', '..', 'dist', 'mcp-server.js'),
            '--run-task', resumeTaskId, workspacePath
        ], {
            detached: true, stdio: 'ignore', windowsHide: true,
            env: {
                ...process.env,
                OPTIMUS_DELEGATION_DEPTH: String(task.delegation_depth || 0),
                OPTIMUS_PARENT_ISSUE: task.github_issue_number ? String(task.github_issue_number) : undefined
            }
        });
        child.unref();

        // Comment on Issue that agent resumed
        try {
            await vcs.addComment(
                'workitem',
                task.github_issue_number!,
                `▶️ **Agent Resumed**\n\nAgent \`${task.role || 'unknown'}\` has been resumed with your answer. Resume task ID: \`${resumeTaskId}\``
            );
        } catch (e: any) {
            console.error(`[ResumeChecker] Failed to post resume comment on issue #${task.github_issue_number}: ${e.message}`);
        }

        return `Resumed task ${task.taskId} → ${resumeTaskId} (answer by ${answer.author})`;
    } finally {
        lockManager.releaseLock(lockKey);
    }
}

function buildResumeContext(task: TaskRecord, humanAnswer: string): string {
    return `You are resuming a previously paused task.

## Original Task
${task.task_description || '(no description available)'}

## What You Were Working On
${task.pause_context || '(no context available)'}

## Question You Asked
${task.pause_question || '(no question recorded)'}

## Human's Answer
${wrapUntrusted(humanAnswer, 'human-answer')}

## Instructions
Continue the original task, incorporating the human's answer. Write your final output to the same output_path.`;
}
