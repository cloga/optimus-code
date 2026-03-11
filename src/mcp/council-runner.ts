import fs from 'fs';
import path from 'path';
import { TaskManifestManager } from '../managers/TaskManifestManager';
import { dispatchCouncilConcurrent, delegateTaskSingle } from './worker-spawner';
import { parseGitRemote, commentOnGitHubIssue, closeGitHubIssue } from '../utils/githubApi';

function verifyOutputPath(outputPath: string | undefined): 'verified' | 'partial' {
    if (!outputPath) return 'partial';
    try {
        const stat = fs.statSync(outputPath);
        if (stat.isFile() && stat.size > 0) return 'verified';
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
                task.master_info
            );
        } else if (task.type === 'dispatch_council') {
            await dispatchCouncilConcurrent(
                task.role_specs || task.roles!,
                task.proposal_path!,
                task.output_path!, // Actually reviews path
                `async_council_${taskId}`,
                task.workspacePath
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
                if (fs.existsSync(reviewFile)) {
                    synthesisContent += `## ${i + 1}. Review from ${role}\n\n`;
                    synthesisContent += fs.readFileSync(reviewFile, 'utf8');
                    synthesisContent += `\n\n---\n\n`;
                } else {
                    synthesisContent += `## ${i + 1}. Review from ${role}\n\n`;
                    synthesisContent += `*Worker failed to produce a review artifact.*\n\n---\n\n`;
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
                    task.workspacePath
                );
                console.error(`[Runner] PM verdict generated at ${verdictPath}`);
            } catch (reduceErr: any) {
                console.error(`[Runner] PM reduce phase failed (non-fatal): ${reduceErr.message}`);
            }
        }

        // Verify output artifacts exist before marking completed
        const outputTarget = task.type === 'dispatch_council'
            ? path.join(task.output_path!, 'COUNCIL_SYNTHESIS.md')
            : task.output_path;
        const verificationStatus = verifyOutputPath(outputTarget);
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

        const statusEmoji = status === 'verified' ? '✅' : status === 'partial' ? '⚠️' : '❌';
        let comment = `## ${statusEmoji} Task Completion Report\n\n`;
        comment += `**Status:** \`${status}\`\n`;
        comment += `**Task ID:** \`${taskId}\`\n`;
        if (outputPath) comment += `**Output:** \`${outputPath}\`\n`;
        if (errorMsg) comment += `**Error:** ${errorMsg}\n`;
        comment += `\n*Auto-generated by Optimus MCP Runner*`;

        await commentOnGitHubIssue(remote.owner, remote.repo, task.github_issue_number, comment);

        if (status === 'verified' || status === 'failed') {
            await closeGitHubIssue(remote.owner, remote.repo, task.github_issue_number);
        }
    } catch {
        // Best-effort — never block task completion
    }
}