import fs from 'fs';
import path from 'path';
import { TaskManifestManager } from '../managers/TaskManifestManager';
import { resolveOptimusPath } from '../utils/worktree';

export interface AsyncDelegateTaskSpec {
    role: string;
    task_description: string;
    output_path: string;
    workspace_path: string;
    role_description?: string;
    role_engine?: string;
    role_model?: string;
    context_files?: string[];
    required_skills?: string[];
    parent_issue_number?: number;
    agent_id?: string;
    depends_on?: string[];
    heartbeat_timeout_ms?: number;
    startup_timeout_ms?: number;
    synthesis_required?: boolean;
    synthesis_role?: string;
    task_id?: string;
    delegation_depth?: number;
}

export interface AsyncPlanItem {
    id: string;
    role: string;
    task_description: string;
    output_path: string;
    role_description?: string;
    role_engine?: string;
    role_model?: string;
    context_files?: string[];
    required_skills?: string[];
    depends_on?: string[];
    heartbeat_timeout_ms?: number;
    startup_timeout_ms?: number;
    synthesis_required?: boolean;
    synthesis_role?: string;
}

export interface PreparedAsyncDelegateTask {
    taskId: string;
    role: string;
    outputPath: string;
    blockedBy: string[];
    dependsOn?: string[];
}

export interface PreparedAsyncPlanDispatch {
    planId: string;
    tasks: PreparedAsyncDelegateTask[];
    readyTaskIds: string[];
    blockedTaskIds: string[];
    itemTaskIds: Record<string, string>;
}

export function writeDelegateTaskArtifact(workspacePath: string, taskId: string, taskDescription: string): string {
    const tasksDir = resolveOptimusPath(workspacePath, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const taskArtifactPath = path.join(tasksDir, `${taskId}.md`);
    fs.writeFileSync(taskArtifactPath, taskDescription, 'utf8');
    return taskArtifactPath;
}

export function canonicalizeDelegateOutputPath(workspacePath: string, outputPath: string): string {
    const optimusDir = path.join(workspacePath, '.optimus');
    const resolvedOutputPath = path.resolve(workspacePath, outputPath);
    return resolvedOutputPath.startsWith(optimusDir)
        ? resolvedOutputPath
        : path.join(optimusDir, 'results', path.basename(outputPath));
}

export function createAsyncDelegateTask(spec: AsyncDelegateTaskSpec): PreparedAsyncDelegateTask {
    const {
        role,
        task_description,
        output_path,
        workspace_path,
        role_description,
        role_engine,
        role_model,
        context_files,
        required_skills,
        parent_issue_number,
        agent_id,
        depends_on,
        heartbeat_timeout_ms,
        startup_timeout_ms,
        synthesis_required,
        synthesis_role,
        task_id,
        delegation_depth,
    } = spec;

    const taskId = task_id || `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const canonicalOutputPath = canonicalizeDelegateOutputPath(workspace_path, output_path);
    const taskArtifactPath = writeDelegateTaskArtifact(workspace_path, taskId, task_description);
    fs.mkdirSync(path.dirname(canonicalOutputPath), { recursive: true });

    TaskManifestManager.createTask(workspace_path, {
        taskId,
        type: 'delegate_task',
        role,
        task_description,
        task_artifact_path: taskArtifactPath,
        output_path: canonicalOutputPath,
        workspacePath: workspace_path,
        context_files: context_files || [],
        role_description,
        role_engine,
        role_model,
        required_skills,
        delegation_depth: delegation_depth ?? 0,
        parent_issue_number,
        agent_id: agent_id || undefined,
        depends_on: Array.isArray(depends_on) && depends_on.length > 0 ? depends_on : undefined,
        heartbeat_timeout_ms,
        startup_timeout_ms,
        synthesis_required: synthesis_required || undefined,
        synthesis_role: synthesis_role || undefined,
    });

    const manifest = TaskManifestManager.loadManifest(workspace_path);
    const blockedBy = (depends_on || []).filter(depId => {
        const dep = manifest[depId];
        return !dep || dep.status !== 'verified';
    });

    if (blockedBy.length > 0) {
        const manifest = TaskManifestManager.loadManifest(workspace_path);
        const task = manifest[taskId];
        if (task) {
            task.status = 'blocked';
            task.blocked_by = blockedBy;
            TaskManifestManager.saveManifest(workspace_path, manifest);
        }
    }

    return {
        taskId,
        role,
        outputPath: canonicalOutputPath,
        blockedBy,
        dependsOn: depends_on,
    };
}

function sanitizePlanItemId(value: string): string {
    const trimmed = value.trim();
    const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!sanitized) {
        throw new Error(`Invalid plan item id '${value}'. Fix: use letters, numbers, underscores, or dashes.`);
    }
    if (sanitized !== trimmed) {
        throw new Error(
            `Invalid plan item id '${value}'. Fix: use a stable id with only letters, numbers, underscores, or dashes ` +
            `(for example: 'design-api' or 'write_tests').`
        );
    }
    return sanitized;
}

export function prepareAsyncPlanDispatch(args: {
    workspacePath: string;
    items: AsyncPlanItem[];
    parentIssueNumber?: number;
    delegationDepth?: number;
    planId?: string;
}): PreparedAsyncPlanDispatch {
    const { workspacePath, items, parentIssueNumber, delegationDepth, planId } = args;
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('dispatch_plan_async requires a non-empty items array.');
    }

    const resolvedPlanId = planId ?? `plan_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const itemTaskIds: Record<string, string> = {};
    const seenItemIds = new Set<string>();

    for (const item of items) {
        const itemId = sanitizePlanItemId(item.id);
        if (seenItemIds.has(itemId)) {
            throw new Error(`Duplicate plan item id '${item.id}'. Fix: make every item.id unique.`);
        }
        seenItemIds.add(itemId);
        itemTaskIds[itemId] = `${resolvedPlanId}__${itemId}`;
    }

    const existingManifest = TaskManifestManager.loadManifest(workspacePath);
    for (const item of items) {
        const deps = item.depends_on || [];
        for (const dep of deps) {
            const normalizedDep = dep.trim();
            if (!normalizedDep) {
                throw new Error(`Plan item '${item.id}' has an empty dependency. Fix: remove blank depends_on entries.`);
            }
            const depIsInBatch = Object.prototype.hasOwnProperty.call(itemTaskIds, normalizedDep);
            const depExistsAlready = Object.prototype.hasOwnProperty.call(existingManifest, normalizedDep);
            if (!depIsInBatch && !depExistsAlready) {
                throw new Error(
                    `Plan item '${item.id}' depends on unknown task '${dep}'. ` +
                    `Fix: reference another item.id from this plan or an existing task ID from the manifest.`
                );
            }
        }
    }

    const tasks: PreparedAsyncDelegateTask[] = [];
    for (const item of items) {
        const normalizedItemId = sanitizePlanItemId(item.id);
        const mappedDependsOn = (item.depends_on || []).map(dep => {
            const normalizedDep = dep.trim();
            return itemTaskIds[normalizedDep] || normalizedDep;
        });

        const created = createAsyncDelegateTask({
            role: item.role,
            task_description: item.task_description,
            output_path: item.output_path,
            workspace_path: workspacePath,
            role_description: item.role_description,
            role_engine: item.role_engine,
            role_model: item.role_model,
            context_files: item.context_files,
            required_skills: item.required_skills,
            parent_issue_number: parentIssueNumber,
            depends_on: mappedDependsOn,
            heartbeat_timeout_ms: item.heartbeat_timeout_ms,
            startup_timeout_ms: item.startup_timeout_ms,
            synthesis_required: item.synthesis_required,
            synthesis_role: item.synthesis_role,
            task_id: itemTaskIds[normalizedItemId],
            delegation_depth: delegationDepth,
        });
        tasks.push(created);
    }

    return {
        planId: resolvedPlanId,
        tasks,
        readyTaskIds: tasks.filter(task => task.blockedBy.length === 0).map(task => task.taskId),
        blockedTaskIds: tasks.filter(task => task.blockedBy.length > 0).map(task => task.taskId),
        itemTaskIds,
    };
}
