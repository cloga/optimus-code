import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { TaskManifestManager } from '../managers/TaskManifestManager';
import { dispatchCouncilConcurrent, delegateTaskSingle } from './worker-spawner';
import { parseGitRemote, commentOnGitHubIssue, closeGitHubIssue } from '../utils/githubApi';
import { agentSignature } from '../utils/agentSignature';
import { sanitizeExternalContent } from '../utils/sanitizeExternalContent';
import { resolveOptimusPath } from '../utils/worktree';

/**
 * Spawn a detached background worker for an async task.
 * Centralized helper used by delegate_task_async, dispatch_council_async, and dependency unblocking.
 */
export function spawnAsyncWorker(taskId: string, workspacePath: string): void {
    // __filename resolves to the compiled mcp-server.js at runtime (council-runner is bundled alongside)
    const mcpServerPath = path.join(__dirname, 'mcp-server.js');
    const child = spawn(process.execPath, [mcpServerPath, "--run-task", taskId, workspacePath], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: workspacePath
    });
    child.unref();
}

/**
 * Run a task in the current process (no subprocess spawn).
 * Uses the shared AcpProcessPool for warm adapter reuse across runs.
 * Safe for long-lived processes (HTTP server, CLI daemon) — never calls process.exit().
 */
export async function runWorkerInProcess(taskId: string, workspacePath: string): Promise<string | undefined> {
    console.error(`[Runner] Starting in-process execution for task: ${taskId}`);
    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[taskId];
    if (!task) {
        throw new Error(`[Runner] Task not found: ${taskId}`);
    }

    if (task.status !== 'pending') {
        console.error(`[Runner] Task already running or completed: ${taskId}`);
        return;
    }

    const parentDepth = task.delegation_depth !== undefined ? task.delegation_depth : undefined;
    const parentIssueNumber = task.github_issue_number ?? task.parent_issue_number;

    TaskManifestManager.updateTask(workspacePath, taskId, { status: 'running', pid: process.pid });
    TaskManifestManager.heartbeat(workspacePath, taskId);

    const heartbeatInterval = setInterval(() => {
        TaskManifestManager.heartbeat(workspacePath, taskId);
    }, 15000);

    try {
        let delegateResult: string | undefined;
        if (task.type === 'delegate_task') {
            delegateResult = await delegateTaskSingle(
                task.role!,
                task.task_artifact_path || task.task_description!,
                task.output_path!,
                `async_${taskId}`,
                task.workspacePath,
                task.context_files,
                {
                    description: task.role_description,
                    engine: task.role_engine,
                    model: task.role_model,
                    requiredSkills: task.required_skills
                },
                parentDepth,
                parentIssueNumber,
                task.github_issue_number,
                task.agent_id
            );
        } else if (task.type === 'dispatch_council') {
            // Council tasks still use subprocess to avoid blocking the caller
            throw new Error(`[Runner] dispatch_council not supported in-process; use spawnAsyncWorker`);
        }

        const verificationStatus = verifyOutputPath(task.output_path);
        let errorMessage: string | undefined;
        if (verificationStatus === 'failed') errorMessage = 'Agent produced no usable output.';
        else if (verificationStatus === 'partial') errorMessage = 'Agent produced partial output.';

        const statusUpdate: Partial<import('../managers/TaskManifestManager').TaskRecord> = {
            status: verificationStatus,
            completed_at: Date.now()
        };
        if (errorMessage) statusUpdate.error_message = errorMessage;
        TaskManifestManager.updateTask(workspacePath, taskId, statusUpdate);
        console.error(`[Runner] Task ${taskId} finished in-process with status: ${verificationStatus}.`);

        if (verificationStatus === 'verified') {
            try {
                const unblockedTasks = TaskManifestManager.unblockDependents(workspacePath, taskId);
                for (const unblockedId of unblockedTasks) {
                    console.error(`[Runner] Unblocked dependent task: ${unblockedId} — running in-process`);
                    // Fire-and-forget: don't await dependents (they run concurrently)
                    runWorkerInProcess(unblockedId, workspacePath).catch(e =>
                        console.error(`[Runner] Dependent ${unblockedId} failed:`, e.message)
                    );
                }
            } catch (depErr: any) {
                console.error(`[Runner] Warning: failed to unblock dependents for ${taskId}: ${depErr.message}`);
            }
        }

        await updateTaskGitHubIssue(workspacePath, taskId, verificationStatus, task.output_path);
        return delegateResult;
    } catch (err: any) {
        console.error(`[Runner] Task ${taskId} failed (in-process):`, err);
        const latestManifest = TaskManifestManager.loadManifest(workspacePath);
        const latestTask = latestManifest[taskId];
        if (latestTask?.status !== 'cancelled') {
            TaskManifestManager.updateTask(workspacePath, taskId, {
                status: 'failed',
                error_message: err.message,
                completed_at: Date.now()
            });
        }
        if (latestTask?.status !== 'cancelled') {
            await updateTaskGitHubIssue(workspacePath, taskId, 'failed', undefined, err.message);
        }
    } finally {
        clearInterval(heartbeatInterval);
        // No process.exit() — caller stays alive
    }
}

function verifyOutputPath(outputPath: string | undefined): 'verified' | 'partial' | 'failed' {
    if (!outputPath) return 'partial';
    try {
        const stat = fs.statSync(outputPath);
        if (stat.isFile()) {
            if (stat.size === 0) return 'partial';

            // Scan first 5 lines for error patterns
            const fd = fs.openSync(outputPath, 'r');
            const buffer = Buffer.alloc(1024);
            const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
            fs.closeSync(fd);

            const content = buffer.slice(0, bytesRead).toString('utf8');
            const lines = content.split('\n').slice(0, 5);

            for (const line of lines) {
                if (line.includes('API Error: 5') ||
                    line.includes('> [LOG] Error:') ||
                    line.includes('> [LOG] error:') ||
                    line.includes('Worker execution failed:') ||
                    line.startsWith('❌')) {
                    return 'failed';
                }
            }
            return 'verified';
        }
        if (stat.isDirectory()) {
            const files = fs.readdirSync(outputPath);
            return files.length > 0 ? 'verified' : 'partial';
        }
        return 'partial';
    } catch (e: any) {
        console.error(`[Verification] Warning: failed to verify output at '${outputPath}': ${e.message}. Marking as partial.`);
        return 'partial';
    }
}

export async function runAsyncWorker(taskId: string, workspacePath: string) {
    console.error(`[Runner] Starting async execution for task: ${taskId}`);
    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[taskId];
    if (!task) {
        console.error(`[Runner] Task not found: ${taskId}`);
        process.exit(1);
    }

    if (task.status !== 'pending') {
        console.error(`[Runner] Task already running or completed: ${taskId}`);
        process.exit(0);
    }

    // Resolve delegation depth from the persisted task record (no process.env mutation)
    const parentDepth = task.delegation_depth !== undefined ? task.delegation_depth : undefined;
    if (parentDepth !== undefined) {
        console.error(`[Runner] Restored delegation depth: ${parentDepth} from task record`);
    }

    // The child's OWN issue becomes the parent for grandchildren.
    // Fall back to task.parent_issue_number (grandparent) when GitHub issue creation failed.
    const parentIssueNumber = task.github_issue_number ?? task.parent_issue_number;
    if (parentIssueNumber !== undefined) {
        console.error(`[Runner] Setting OPTIMUS_PARENT_ISSUE=${parentIssueNumber} for child agents (source: ${task.github_issue_number !== undefined ? 'own issue' : 'inherited parent'})`);
    }

    TaskManifestManager.updateTask(workspacePath, taskId, { status: 'running', pid: process.pid });
    TaskManifestManager.heartbeat(workspacePath, taskId);  // Immediate first heartbeat

    // Update STATUS.md to 'running' — users can distinguish queued vs. active execution
    if (task.type === 'dispatch_council' && task.output_path) {
        try {
            const statusRunning = [
                `# Council Status`,
                ``,
                `**council_id:** ${taskId}`,
                `**phase:** running`,
                `**roles:** ${(task.roles || []).join(', ')}`,
                `**proposal:** ${task.proposal_path || ''}`,
                `**pid:** ${process.pid}`,
                `**started_at:** ${new Date().toISOString()}`,
                ``,
                `_Workers are executing. Per-role placeholder files are present in this directory._`,
                `_Check individual \`<role>_review.md\` files to see per-role progress._`,
            ].join('\n') + '\n';
            fs.writeFileSync(path.join(task.output_path, 'STATUS.md'), statusRunning, 'utf8');
        } catch { /* best-effort — don't fail the task */ }
    }

    // Set up heartbeat every 15 seconds
    const heartbeatInterval = setInterval(() => {
        TaskManifestManager.heartbeat(workspacePath, taskId);
    }, 15000);

    try {
        if (task.type === 'delegate_task') {
            await delegateTaskSingle(
                task.role!,
                task.task_artifact_path || task.task_description!,
                task.output_path!,
                `async_${taskId}`,
                task.workspacePath,
                task.context_files,
                {
                    description: task.role_description,
                    engine: task.role_engine,
                    model: task.role_model,
                    requiredSkills: task.required_skills
                },
                parentDepth,
                parentIssueNumber,
                task.github_issue_number,  // auto-created tracking issue
                task.agent_id
            );
        } else if (task.type === 'dispatch_council') {
            await dispatchCouncilConcurrent(
                task.roles!,
                task.proposal_path!,
                task.output_path!, // Actually reviews path
                `async_council_${taskId}`,
                task.workspacePath,
                parentDepth,
                parentIssueNumber,
                task.role_descriptions
            );

            // Phase 3: Concatenate into COUNCIL_SYNTHESIS.md
            const reviewsPath = task.output_path!;
            const synthesisPath = path.join(reviewsPath, 'COUNCIL_SYNTHESIS.md');

            let synthesisContent = `# Council Synthesis Report\n\n`;
            synthesisContent += `**Proposal:** \`${task.proposal_path}\`\n`;
            synthesisContent += `**Council:** ${task.roles!.map(r => `\`${r}\``).join(', ')}\n\n`;

            let synthesisVerifiedCount = 0;
            let synthesisFailedRoles: string[] = [];

            for (let i = 0; i < task.roles!.length; i++) {
                const role = task.roles![i];
                const reviewFile = path.join(reviewsPath, `${role}_review.md`);
                const status = verifyOutputPath(reviewFile);

                if (status === 'verified') {
                    synthesisVerifiedCount++;
                    synthesisContent += `## ${i + 1}. Review from ${role}\n\n`;
                    const rawReview = fs.readFileSync(reviewFile, 'utf8');
                    const { sanitized: reviewContent } = sanitizeExternalContent(rawReview, `review:${role}`);
                    synthesisContent += reviewContent;
                    synthesisContent += `\n\n---\n\n`;
                } else {
                    synthesisFailedRoles.push(role);
                    synthesisContent += `## ${i + 1}. Review from ${role}\n\n`;
                    synthesisContent += `*Worker '${role}' failed to produce a valid review artifact (Status: ${status}). Check .optimus/agents/ for the worker's T1 instance file — it may contain error context in its frontmatter.*\n\n---\n\n`;
                }
            }

            if (synthesisFailedRoles.length > 0) {
                const header = `> **Partial Results Warning:** ${synthesisFailedRoles.length} of ${task.roles!.length} workers failed: ${synthesisFailedRoles.map(r => `\`${r}\``).join(', ')}. Synthesis is based on ${synthesisVerifiedCount} successful review(s).\n\n`;
                synthesisContent = synthesisContent.replace(
                    `**Council:** ${task.roles!.map(r => `\`${r}\``).join(', ')}\n\n`,
                    `**Council:** ${task.roles!.map(r => `\`${r}\``).join(', ')}\n\n${header}`
                );
            }

            fs.writeFileSync(synthesisPath, synthesisContent, 'utf8');
            console.error(`[Runner] Generated COUNCIL_SYNTHESIS.md at ${synthesisPath}`);

            // Phase 4: True Map-Reduce — delegate PM to synthesize a unified verdict
            try {
                // Load VERDICT template from external config (customizable), with hardcoded fallback
                let verdictTemplate = `## Unified Council Verdict
**Decision**: APPROVED / REJECTED / APPROVED_WITH_CONDITIONS
**Consensus Level**: UNANIMOUS / MAJORITY / SPLIT

### Key Agreements
- (list points all reviewers agree on)

### Conditions (if any)
- (list required changes before implementation)

### Conflicts (if any)
- (list unresolved disagreements)

### Implementation Priority
1. (ordered action items)`;

                const templatePath = resolveOptimusPath(task.workspacePath, 'config', 'verdict-template.md');
                try {
                    if (fs.existsSync(templatePath)) {
                        verdictTemplate = fs.readFileSync(templatePath, 'utf8').trim();
                        console.error(`[Runner] Using custom VERDICT template from ${templatePath}`);
                    }
                } catch { /* use default */ }

                const pmSynthesisPrompt = `You are the PM arbiter for this council review.

Read the following council synthesis report and produce a UNIFIED VERDICT.

Your output MUST follow this exact format:
${verdictTemplate}

Here is the synthesis report:\n\n${synthesisContent}`;

                const verdictPath = path.join(reviewsPath, 'VERDICT.md');
                await delegateTaskSingle(
                    'pm',
                    pmSynthesisPrompt,
                    verdictPath,
                    `reduce_${taskId}`,
                    task.workspacePath,
                    undefined,
                    undefined,
                    parentDepth
                );
                console.error(`[Runner] PM verdict generated at ${verdictPath}`);
            } catch (reduceErr: any) {
                console.error(`[Runner] PM reduce phase failed: ${reduceErr.message}. Council reviews are still available but unified VERDICT.md was not generated. Read individual review files in the reviews directory instead.`);
            }
        }


        let verificationStatus: 'verified' | 'partial' | 'failed' | 'degraded' = 'partial';
        let errorMessage: string | undefined;
        if (task.type === 'dispatch_council') {
            let successCount = 0;
            let failureCount = 0;
            const failedWorkers: string[] = [];
            const reviewsPath = task.output_path!;
            for (const role of task.roles!) {
                const reviewFile = path.join(reviewsPath, `${role}_review.md`);
                const status = verifyOutputPath(reviewFile);
                if (status === 'verified') successCount++;
                else { failureCount++; failedWorkers.push(role); }
            }

            if (failureCount === 0) verificationStatus = 'verified';
            else if (successCount === 0) { verificationStatus = 'failed'; errorMessage = `All ${failureCount} council workers failed: ${failedWorkers.join(', ')}`; }
            else { verificationStatus = 'partial'; errorMessage = `${failureCount} of ${task.roles!.length} workers failed: ${failedWorkers.join(', ')}. ${successCount} succeeded.`; }

            // Ensure synthesis exists regardless
            const synthesisPath = path.join(task.output_path!, 'COUNCIL_SYNTHESIS.md');
            if (verificationStatus !== 'failed' && !fs.existsSync(synthesisPath)) {
                verificationStatus = 'failed';
                errorMessage = 'COUNCIL_SYNTHESIS.md was not generated';
            }
        } else {
            const status = verifyOutputPath(task.output_path);
            if (status === 'partial') verificationStatus = 'partial';
            else verificationStatus = status; // 'verified' or 'failed'
        }

        const latestManifest = TaskManifestManager.loadManifest(workspacePath);
        const latestTask = latestManifest[taskId];
        if (latestTask?.status === 'cancelled') {
            console.error(`[Runner] Task ${taskId} was cancelled while executing. Preserving cancelled status.`);
            clearInterval(heartbeatInterval);
            process.exit(0);
        }

        const statusUpdate: Partial<import('../managers/TaskManifestManager').TaskRecord> = {
            status: verificationStatus,
            completed_at: Date.now()
        };
        if (errorMessage) statusUpdate.error_message = errorMessage;
        TaskManifestManager.updateTask(workspacePath, taskId, statusUpdate);
        console.error(`[Runner] Task ${taskId} finished with status: ${verificationStatus}.`);

        // Update STATUS.md to final phase
        if (task.type === 'dispatch_council' && task.output_path) {
            try {
                const statusEmoji = verificationStatus === 'verified' ? '✅' : (verificationStatus === 'partial' ? '⚠️' : '❌');
                const statusFinal = [
                    `# Council Status`,
                    ``,
                    `**council_id:** ${taskId}`,
                    `**phase:** ${verificationStatus}`,
                    `**roles:** ${(task.roles || []).join(', ')}`,
                    `**proposal:** ${task.proposal_path || ''}`,
                    `**completed_at:** ${new Date().toISOString()}`,
                    `**result:** ${statusEmoji} ${verificationStatus}`,
                    ...(errorMessage ? [`**error:** ${errorMessage}`] : []),
                    ``,
                    `_See COUNCIL_SYNTHESIS.md and VERDICT.md for full results._`,
                ].join('\n') + '\n';
                fs.writeFileSync(path.join(task.output_path, 'STATUS.md'), statusFinal, 'utf8');
            } catch { /* best-effort */ }
        }

        // Unblock dependent tasks if this task was verified
        if (verificationStatus === 'verified') {
            try {
                const unblockedTasks = TaskManifestManager.unblockDependents(workspacePath, taskId);
                for (const unblockedId of unblockedTasks) {
                    console.error(`[Runner] Unblocked dependent task: ${unblockedId} — spawning worker`);
                    spawnAsyncWorker(unblockedId, workspacePath);
                }
            } catch (depErr: any) {
                console.error(`[Runner] Warning: failed to unblock dependents for ${taskId}: ${depErr.message}`);
            }
        }

        // Best-effort: update GitHub Issue with completion status
        await updateTaskGitHubIssue(workspacePath, taskId, verificationStatus, task.output_path);
    } catch (err: any) {
        console.error(`[Runner] Task ${taskId} failed:`, err);
        const latestManifest = TaskManifestManager.loadManifest(workspacePath);
        const latestTask = latestManifest[taskId];
        if (latestTask?.status !== 'cancelled') {
            TaskManifestManager.updateTask(workspacePath, taskId, {
                status: 'failed',
                error_message: err.message,
                completed_at: Date.now()
            });
        }

        // Best-effort: comment failure on GitHub Issue
        if (latestTask?.status !== 'cancelled') {
            await updateTaskGitHubIssue(workspacePath, taskId, 'failed', undefined, err.message);
        }
    } finally {
        clearInterval(heartbeatInterval);
        process.exit(0);
    }
}

async function updateTaskGitHubIssue(
    workspacePath: string, taskId: string, status: string, outputPath?: string, errorMsg?: string
) {
    try {
        const manifest = TaskManifestManager.loadManifest(workspacePath);
        const task = manifest[taskId];
        if (!task?.github_issue_number) return;

        const remote = parseGitRemote(workspacePath);
        if (!remote) return;

        const statusEmoji = status === 'verified' ? '✅' : (status === 'partial' || status === 'degraded') ? '⚠️' : '❌';
        let comment = `## ${statusEmoji} Task Completion Report\n\n`;
        comment += `**Status:** \`${status}\`\n`;
        comment += `**Task ID:** \`${taskId}\`\n`;
        if (outputPath) comment += `**Output:** \`${outputPath}\`\n`;
        if (errorMsg) comment += `**Error:** ${errorMsg}\n`;
        comment += agentSignature('council-runner', taskId);

        await commentOnGitHubIssue(remote.owner, remote.repo, task.github_issue_number, comment);

        // DO NOT automatically close the issue here, pending PM review or further work.
    } catch (e: any) {
        console.error(`[Runner] Warning: failed to update GitHub issue for task ${taskId}: ${e.message}. Task completion not affected.`);
    }
}
