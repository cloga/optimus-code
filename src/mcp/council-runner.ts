import { TaskManifestManager } from '../managers/TaskManifestManager';
import { dispatchCouncilConcurrent, delegateTaskSingle } from './worker-spawner';

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
                task.context_files
            );
        } else if (task.type === 'dispatch_council') {
            await dispatchCouncilConcurrent(
                task.roles!,
                task.proposal_path!,
                task.output_path!, // Actually reviews path
                `async_council_${taskId}`,
                task.workspacePath
            );

            // Phase 3: Concatenate into COUNCIL_SYNTHESIS.md
            const fs = require('fs');
            const path = require('path');
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
        }

        TaskManifestManager.updateTask(workspacePath, taskId, { status: 'completed' });
        console.error(`[Runner] Task ${taskId} completed successfully.`);
    } catch (err: any) {
        console.error(`[Runner] Task ${taskId} failed:`, err);
        TaskManifestManager.updateTask(workspacePath, taskId, { status: 'failed', error_message: err.message });
    } finally {
        clearInterval(heartbeatInterval);
        process.exit(0);
    }
}