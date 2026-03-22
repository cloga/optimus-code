import fs from 'fs';
import path from 'path';
import { TaskManifestManager } from '../managers/TaskManifestManager';
import { resolveOptimusPath } from '../utils/worktree';

type PrepareAsyncCouncilDispatchArgs = {
    workspacePath: string;
    proposalPath: string;
    roles: string[];
    parentIssueNumber?: number;
    roleDescriptions?: Record<string, string>;
    taskId?: string;
    delegationDepth?: number;
};

export type PreparedAsyncCouncilDispatch = {
    taskId: string;
    reviewsPath: string;
    statusPath: string;
};

export function prepareAsyncCouncilDispatch({
    workspacePath,
    proposalPath,
    roles,
    parentIssueNumber,
    roleDescriptions,
    taskId,
    delegationDepth,
}: PrepareAsyncCouncilDispatchArgs): PreparedAsyncCouncilDispatch {
    const resolvedTaskId = taskId ?? `council_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const reviewsPath = resolveOptimusPath(workspacePath, 'reviews', resolvedTaskId);
    const statusPath = path.join(reviewsPath, 'STATUS.md');

    fs.mkdirSync(reviewsPath, { recursive: true });
    const statusQueued = [
        `# Council Status`,
        ``,
        `**council_id:** ${resolvedTaskId}`,
        `**phase:** queued`,
        `**roles:** ${roles.join(', ')}`,
        `**proposal:** ${proposalPath}`,
        `**queued_at:** ${new Date().toISOString()}`,
        ``,
        `_Background worker has been spawned and will update this file when execution starts._`,
    ].join('\n') + '\n';
    fs.writeFileSync(statusPath, statusQueued, 'utf8');

    TaskManifestManager.createTask(workspacePath, {
        taskId: resolvedTaskId,
        type: 'dispatch_council',
        roles,
        proposal_path: proposalPath,
        output_path: reviewsPath,
        workspacePath,
        delegation_depth: delegationDepth ?? 0,
        parent_issue_number: parentIssueNumber,
        role_descriptions: roleDescriptions,
    });

    return { taskId: resolvedTaskId, reviewsPath, statusPath };
}