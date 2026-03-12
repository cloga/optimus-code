import fs from 'fs';
import path from 'path';
import { TaskManifestManager } from '../managers/TaskManifestManager';
import { dispatchCouncilConcurrent, delegateTaskSingle } from './worker-spawner';
import { parseGitRemote, commentOnGitHubIssue, closeGitHubIssue } from '../utils/githubApi';

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
    } catch {
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

    // Set up heartbeat every 1 minute
    const heartbeatInterval = setInterval(() => {
        TaskManifestManager.heartbeat(workspacePath, taskId);
    }, 60000);

    try {
        if (task.type === 'delegate_task') {
            await delegateTaskSingle(
                task.role!,
                task.task_description!,
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
                parentIssueNumber
            );
        } else if (task.type === 'dispatch_council') {
            await dispatchCouncilConcurrent(
                task.roles!,
                task.proposal_path!,
                task.output_path!, // Actually reviews path
                `async_council_${taskId}`,
                task.workspacePath,
                parentDepth,
                parentIssueNumber
            );

            // Phase 3: Concatenate into COUNCIL_SYNTHESIS.md
            const reviewsPath = task.output_path!;
            const synthesisPath = path.join(reviewsPath, 'COUNCIL_SYNTHESIS.md');
            
            let synthesisContent = `# Council Synthesis Report\n\n`;
            synthesisContent += `**Proposal:** \`${task.proposal_path}\`\n`;
            synthesisContent += `**Council:** ${task.roles!.map(r => `\`${r}\``).join(', ')}\n\n`;

            for (let i = 0; i < task.roles!.length; i++) {
                const role = task.roles![i];
                const reviewFile = path.join(reviewsPath, `${role}_review.md`);
                // Use verifyOutputPath to check for error patterns
                const status = verifyOutputPath(reviewFile);

                if (status === 'verified') {
                    synthesisContent += `## ${i + 1}. Review from ${role}\n\n`;
                    synthesisContent += fs.readFileSync(reviewFile, 'utf8');
                    synthesisContent += `\n\n---\n\n`;
                } else {
                    synthesisContent += `## ${i + 1}. Review from ${role}\n\n`;
                    synthesisContent += `*Worker failed to produce a valid review artifact (Status: ${status}).*\n\n---\n\n`;
                }
            }

            fs.writeFileSync(synthesisPath, synthesisContent, 'utf8');
            console.error(`[Runner] Generated COUNCIL_SYNTHESIS.md at ${synthesisPath}`);

            // Phase 4: True Map-Reduce — delegate PM to synthesize a unified verdict
            try {
                const pmSynthesisPrompt = `You are the PM arbiter for this council review.

Read the following council synthesis report and produce a UNIFIED VERDICT.

Your output MUST follow this exact format:
## Unified Council Verdict
**Decision**: APPROVED / REJECTED / APPROVED_WITH_CONDITIONS
**Consensus Level**: UNANIMOUS / MAJORITY / SPLIT

### Key Agreements
- (list points all reviewers agree on)

### Conditions (if any)
- (list required changes before implementation)

### Conflicts (if any)
- (list unresolved disagreements)

### Implementation Priority
1. (ordered action items)

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
                console.error(`[Runner] PM reduce phase failed (non-fatal): ${reduceErr.message}`);
            }
        }


        let verificationStatus: 'verified' | 'partial' | 'failed' | 'degraded' = 'partial';
        if (task.type === 'dispatch_council') {
            let successCount = 0;
            let failureCount = 0;
            const reviewsPath = task.output_path!;
            for (const role of task.roles!) {
                const reviewFile = path.join(reviewsPath, `${role}_review.md`);
                const status = verifyOutputPath(reviewFile);
                if (status === 'verified') successCount++;
                else failureCount++;
            }

            if (failureCount === 0) verificationStatus = 'verified';
            else if (successCount === 0) verificationStatus = 'failed';
            else verificationStatus = 'degraded';

            // Ensure synthesis exists regardless
            const synthesisPath = path.join(task.output_path!, 'COUNCIL_SYNTHESIS.md');
            if (verificationStatus !== 'failed' && !fs.existsSync(synthesisPath)) {
                verificationStatus = 'failed';
            }
        } else {
            const status = verifyOutputPath(task.output_path);
            if (status === 'partial') verificationStatus = 'partial';
            else verificationStatus = status; // 'verified' or 'failed'
        }

        TaskManifestManager.updateTask(workspacePath, taskId, { status: verificationStatus });
        console.error(`[Runner] Task ${taskId} finished with status: ${verificationStatus}.`);

        // Best-effort: update GitHub Issue with completion status
        await updateTaskGitHubIssue(workspacePath, taskId, verificationStatus, task.output_path);
    } catch (err: any) {
        console.error(`[Runner] Task ${taskId} failed:`, err);
        TaskManifestManager.updateTask(workspacePath, taskId, { status: 'failed', error_message: err.message });

        // Best-effort: comment failure on GitHub Issue
        await updateTaskGitHubIssue(workspacePath, taskId, 'failed', undefined, err.message);
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

        const statusEmoji = status === 'verified' ? '✅' : status === 'degraded' ? '⚠️' : '❌';
        let comment = `## ${statusEmoji} Task Completion Report\n\n`;
        comment += `**Status:** \`${status}\`\n`;
        comment += `**Task ID:** \`${taskId}\`\n`;
        if (outputPath) comment += `**Output:** \`${outputPath}\`\n`;
        if (errorMsg) comment += `**Error:** ${errorMsg}\n`;
        comment += `\n*Auto-generated by Optimus MCP Runner. This issue remains open until final approval.*`;

        await commentOnGitHubIssue(remote.owner, remote.repo, task.github_issue_number, comment);

        // DO NOT automatically close the issue here, pending PM review or further work.
    } catch {
        // Best-effort — never block task completion
    }
}