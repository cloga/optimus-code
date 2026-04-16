import fs from 'fs';
import path from 'path';
import { AsyncPlanItem, canonicalizeDelegateOutputPath } from './async-plan-dispatch';
import type { TaskRecord } from '../managers/TaskManifestManager';

export type OptimusStrategy = 'delegate' | 'council' | 'plan';
export type OptimusModeHint = 'auto' | OptimusStrategy;

type OptimusSignalSet = {
    wantsImplementation: boolean;
    wantsVerification: boolean;
    wantsArchitecture: boolean;
    wantsResearch: boolean;
    wantsSecurity: boolean;
    wantsPerformance: boolean;
    wantsDocs: boolean;
    looksMultiStep: boolean;
};

export interface OptimusPlannerInput {
    workspacePath: string;
    taskDescription: string;
    outputPath: string;
    intentSignals?: Partial<OptimusSignalSet>;
    contextFiles?: string[];
    modeHint?: OptimusModeHint;
    registeredRoles?: Array<{ canonical: string; aliases: string[]; category?: string }>;
    heartbeatTimeoutMs?: number;
    startupTimeoutMs?: number;
}

export interface OptimusDelegateSpec {
    role: string;
    role_description?: string;
    task_description: string;
    output_path: string;
    context_files: string[];
    required_skills?: string[];
    heartbeat_timeout_ms?: number;
    startup_timeout_ms?: number;
}

export interface OptimusCouncilSpec {
    proposalPath: string;
    proposalContent: string;
    roles: string[];
    roleDescriptions?: Record<string, string>;
}

export interface OptimusPlanSpec {
    items: AsyncPlanItem[];
}

export interface OptimusDispatchPlan {
    strategy: OptimusStrategy;
    rationale: string[];
    summaryOutputPath: string;
    delegateSpec?: OptimusDelegateSpec;
    councilSpec?: OptimusCouncilSpec;
    planSpec?: OptimusPlanSpec;
}

export type OptimusEffectiveTaskStatus = TaskRecord['status'] | 'missing' | 'verified' | 'partial';
export type OptimusCompletionState = 'queued' | 'running' | 'verified' | 'awaiting_input' | 'failed' | 'mixed' | 'timed_out';

export interface OptimusTaskSnapshot {
    taskId: string;
    status: TaskRecord['status'] | 'missing';
    effectiveStatus: OptimusEffectiveTaskStatus;
    outputPath?: string;
    errorMessage?: string;
    githubIssueNumber?: number;
}

export interface OptimusTaskSettlement {
    settled: boolean;
    overallStatus: OptimusCompletionState;
    tasks: OptimusTaskSnapshot[];
}

function outputArtifactExists(task: TaskRecord): boolean {
    if (!task.output_path) return false;
    try {
        const stat = fs.statSync(task.output_path);
        return stat.isFile() ? stat.size > 0 : fs.readdirSync(task.output_path).length > 0;
    } catch {
        return false;
    }
}

export function resolveEffectiveTaskStatus(task?: TaskRecord): OptimusEffectiveTaskStatus {
    if (!task) return 'missing';
    if (task.status === 'completed') {
        return outputArtifactExists(task) ? 'verified' : 'partial';
    }
    return task.status;
}

export function isSettledTaskStatus(status: OptimusEffectiveTaskStatus): boolean {
    return new Set<OptimusEffectiveTaskStatus>([
        'verified',
        'failed',
        'partial',
        'degraded',
        'expired',
        'cancelled',
        'awaiting_input',
        'blocked_human_intervention',
        'missing',
    ]).has(status);
}

export function summarizeOptimusTaskSettlement(taskIds: string[], manifest: Record<string, TaskRecord>): OptimusTaskSettlement {
    const tasks = taskIds.map(taskId => {
        const task = manifest[taskId];
        const effectiveStatus = resolveEffectiveTaskStatus(task);
        return {
            taskId,
            status: task?.status ?? 'missing',
            effectiveStatus,
            outputPath: task?.output_path,
            errorMessage: task?.error_message,
            githubIssueNumber: task?.github_issue_number,
        } satisfies OptimusTaskSnapshot;
    });

    const settled = tasks.every(task => isSettledTaskStatus(task.effectiveStatus));
    if (!settled) {
        return { settled: false, overallStatus: 'running', tasks };
    }

    if (tasks.length === 0) {
        return { settled: true, overallStatus: 'failed', tasks };
    }

    if (tasks.every(task => task.effectiveStatus === 'verified')) {
        return { settled: true, overallStatus: 'verified', tasks };
    }

    const hasAwaitingInput = tasks.some(task => task.effectiveStatus === 'awaiting_input' || task.effectiveStatus === 'blocked_human_intervention');
    const hasFailures = tasks.some(task => new Set<OptimusEffectiveTaskStatus>([
        'failed',
        'partial',
        'degraded',
        'expired',
        'cancelled',
        'missing',
    ]).has(task.effectiveStatus));

    if (hasAwaitingInput && !hasFailures) {
        return { settled: true, overallStatus: 'awaiting_input', tasks };
    }

    if (hasFailures && tasks.every(task => task.effectiveStatus !== 'verified')) {
        return { settled: true, overallStatus: 'failed', tasks };
    }

    return { settled: true, overallStatus: 'mixed', tasks };
}

function includesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some(pattern => pattern.test(text));
}

function collectSignals(taskDescription: string): OptimusSignalSet {
    const text = taskDescription.toLowerCase();
    const wantsImplementation = includesAny(text, [
        /\bimplement\b/, /\bbuild\b/, /\bfix\b/, /\badd\b/, /\bupdate\b/, /\bchange\b/,
        /\bmodify\b/, /\brefactor\b/, /\bwire\b/, /\bintegrat(e|ion)\b/, /\bstart implementation\b/,
        /实现/, /修复/, /添加/, /更新/, /修改/, /重构/, /写代码/, /发包/, /发布/, /版本/, /构建/, /做一下/
    ]);
    const wantsVerification = includesAny(text, [
        /\btest\b/, /\btests\b/, /\bverify\b/, /\bvalidation\b/, /\bvalidate\b/, /\bsmoke\b/,
        /\bqa\b/, /\breview\b/, /\baudit\b/,
        /测试/, /验证/, /审查/, /跑一下/, /报错/, /查bug/, /检查/
    ]);
    const wantsArchitecture = includesAny(text, [
        /\barchitect(?:ure)?\b/, /\bdesign\b/, /\bproposal\b/, /\bprotocol\b/, /\bschema\b/,
        /\btrade-?off\b/, /\bdirection\b/, /\bapproach\b/, /\bmigration\b/,
        /架构/, /设计/, /方案/, /蓝图/, /技术选型/, /结构/
    ]);
    const wantsResearch = includesAny(text, [
        /\bresearch\b/, /\binvestigat(e|ion)\b/, /\banaly(s|z)e\b/, /\banalysis\b/, /\bcompare\b/,
        /\bexplore\b/, /\bplan\b/,
        /调研/, /分析/, /研究/, /排查/, /探索/
    ]);
    const wantsSecurity = includesAny(text, [
        /\bsecurity\b/, /\bauth\b/, /\bpermission\b/, /\bcredential\b/, /\bsecret\b/,
        /\bvulnerab(?:ility|le)\b/, /\bharden\b/,
        /安全/, /漏洞/, /权限/, /认证/, /密码/, /加密/
    ]);
    const wantsPerformance = includesAny(text, [
        /\bperformance\b/, /\blatency\b/, /\bthroughput\b/, /\bscale\b/, /\bscalability\b/,
        /\bconcurrency\b/, /\bruntime\b/,
        /性能/, /延迟/, /吞吐/, /并发/, /提速/, /卡顿/, /内存泄漏/
    ]);
    const wantsDocs = includesAny(text, [
        /\bdocument\b/, /\bdocumentation\b/, /\breadme\b/, /\bchangelog\b/, /\bdocs\b/,
        /文档/, /说明/, /注释/
    ]);
    const looksMultiStep = /\n\s*(?:[-*]|\d+\.)\s+/.test(taskDescription)
        || /\b(?:first|then|finally)\b/.test(text)
        || /然后|接着|最后|第一步|其次|首先/.test(text)
        || (wantsImplementation && (wantsVerification || wantsArchitecture || wantsResearch || wantsDocs));

    return {
        wantsImplementation,
        wantsVerification,
        wantsArchitecture,
        wantsResearch,
        wantsSecurity,
        wantsPerformance,
        wantsDocs,
        looksMultiStep,
    };
}

function rankRoles(input: OptimusPlannerInput): Set<string> {
    const roles = new Set<string>();
    for (const role of input.registeredRoles || []) {
        roles.add(role.canonical);
        for (const alias of role.aliases) {
            roles.add(alias);
        }
    }
    return roles;
}

function selectRole(candidates: string[], knownRoles: Set<string>): string {
    for (const candidate of candidates) {
        if (knownRoles.has(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}

function buildSiblingOutputPath(summaryOutputPath: string, suffix: string): string {
    const parsed = path.parse(summaryOutputPath);
    const ext = parsed.ext || '.md';
    return path.join(parsed.dir, `${parsed.name}__${suffix}${ext}`);
}

function buildDelegateSkillSet(signals: OptimusSignalSet): string[] | undefined {
    const skills: string[] = [];
    if (signals.wantsImplementation) {
        skills.push('feature-dev');
    }
    if (signals.wantsVerification || signals.wantsPerformance) {
        skills.push('runtime-integration');
    }
    return skills.length > 0 ? skills : undefined;
}

function buildDelegateSpec(input: OptimusPlannerInput, summaryOutputPath: string, signals: OptimusSignalSet): OptimusDelegateSpec {
    const knownRoles = rankRoles(input);
    const role = signals.wantsVerification && !signals.wantsImplementation
        ? selectRole(['qa-engineer', 'code-reviewer', 'dev'], knownRoles)
        : signals.wantsDocs && !signals.wantsImplementation
            ? selectRole(['documentation-specialist', 'pm', 'dev'], knownRoles)
            : selectRole(['dev', 'senior-full-stack-builder', 'qa-engineer'], knownRoles);

    return {
        role,
        role_description: role === 'dev'
            ? 'Implementation-focused engineer for direct code changes and focused bug fixes.'
            : undefined,
        task_description: input.taskDescription,
        output_path: buildSiblingOutputPath(summaryOutputPath, 'delegate'),
        context_files: input.contextFiles || [],
        required_skills: buildDelegateSkillSet(signals),
        heartbeat_timeout_ms: input.heartbeatTimeoutMs,
        startup_timeout_ms: input.startupTimeoutMs,
    };
}

function buildCouncilSpec(input: OptimusPlannerInput, summaryOutputPath: string, signals: OptimusSignalSet): OptimusCouncilSpec {
    const knownRoles = rankRoles(input);
    const candidates = [
        signals.wantsSecurity ? 'security' : 'code-architect',
        signals.wantsPerformance ? 'distributed-systems-expert' : 'architect',
        'qa-engineer',
        'code-reviewer',
    ];
    const roles = Array.from(new Set(candidates.map(candidate => selectRole([candidate], knownRoles)))).slice(0, 3);
    const proposalPath = buildSiblingOutputPath(summaryOutputPath, 'problem');
    const roleDescriptions: Record<string, string> = {
        'code-architect': 'Reviews design seams, system boundaries, and migration risks.',
        architect: 'Evaluates high-level orchestration and product fit tradeoffs.',
        'qa-engineer': 'Examines validation coverage, regressions, and testability.',
        'code-reviewer': 'Reviews implementation risk, maintainability, and likely edge cases.',
        security: 'Reviews authentication, permissions, secret handling, and abuse cases.',
        'distributed-systems-expert': 'Reviews concurrency, runtime isolation, and scaling risks.',
    };

    return {
        proposalPath,
        proposalContent: renderOptimusCouncilProposal(input.taskDescription, roles),
        roles,
        roleDescriptions: Object.fromEntries(roles.map(role => [role, roleDescriptions[role] || 'Expert reviewer for this council lane.'])),
    };
}

function buildPlanSpec(input: OptimusPlannerInput, summaryOutputPath: string, signals: OptimusSignalSet): OptimusPlanSpec {
    const knownRoles = rankRoles(input);
    const items: AsyncPlanItem[] = [];
    const contextFiles = input.contextFiles || [];

    if (signals.wantsArchitecture || signals.wantsResearch) {
        items.push({
            id: 'design',
            role: selectRole([
                signals.wantsSecurity ? 'security' : 'code-architect',
                signals.wantsPerformance ? 'distributed-systems-expert' : 'architect',
                'dev'
            ], knownRoles),
            task_description: [
                'Analyze the task, identify the minimum safe implementation plan, and highlight the main risks before code changes begin.',
                '',
                '## Original Request',
                input.taskDescription,
            ].join('\n'),
            output_path: buildSiblingOutputPath(summaryOutputPath, 'design'),
            context_files: contextFiles,
            synthesis_required: true,
        });
    }

    const implementDependsOn = items.length > 0 ? ['design'] : undefined;
    items.push({
        id: 'implement',
        role: selectRole(['dev', 'senior-full-stack-builder', 'qa-engineer'], knownRoles),
        task_description: input.taskDescription,
        output_path: buildSiblingOutputPath(summaryOutputPath, 'implement'),
        context_files: contextFiles,
        required_skills: buildDelegateSkillSet(signals),
        depends_on: implementDependsOn,
        heartbeat_timeout_ms: input.heartbeatTimeoutMs,
        startup_timeout_ms: input.startupTimeoutMs,
    });

    items.push({
        id: 'verify',
        role: selectRole(['qa-engineer', 'code-reviewer', 'dev'], knownRoles),
        task_description: [
            'Verify the implementation against the original request. Focus on regressions, missing tests, and behavioral gaps.',
            '',
            '## Original Request',
            input.taskDescription,
        ].join('\n'),
        output_path: buildSiblingOutputPath(summaryOutputPath, 'verify'),
        context_files: contextFiles,
        depends_on: ['implement'],
        required_skills: signals.wantsPerformance || signals.wantsVerification ? ['runtime-integration'] : undefined,
    });

    items.push({
        id: 'reflect',
        role: selectRole(['architect', 'code-architect', 'senior-full-stack-builder', 'dev'], knownRoles),
        task_description: [
            'Evaluate the implementation and review any errors encountered during the task.',
            'Identify new insights, architectural patterns, or recurring mistakes to avoid in the future.',
            'If the task was trivial (e.g. simple typo fix, simple version bump) or encountered no meaningful errors, simply output a short acknowledgment and DO NOT append memory.',
            'If you found structural insights or recurring pitfalls, use the `append_memory` tool (level: "repo", category: "workflow-or-architecture") to permanently store these learnings for system self-evolution.',
            '',
            '## Original Request',
            input.taskDescription,
        ].join('\n'),
        output_path: buildSiblingOutputPath(summaryOutputPath, 'reflect'),
        context_files: contextFiles,
        depends_on: ['verify'],
    });

    return { items };
}

export function buildOptimusDispatchPlan(input: OptimusPlannerInput): OptimusDispatchPlan {
    const summaryOutputPath = canonicalizeDelegateOutputPath(input.workspacePath, input.outputPath);
    const regexSignals = collectSignals(input.taskDescription);
    const signals: OptimusSignalSet = { ...regexSignals, ...input.intentSignals };
    const rationale: string[] = [];

    if (input.intentSignals) {
        rationale.push('Used agent-provided explicit intent classification (agent-native fallback overrides skipped).');
    }

    let strategy: OptimusStrategy;
    if (input.modeHint && input.modeHint !== 'auto') {
        strategy = input.modeHint;
        rationale.push(`Mode hint forced '${input.modeHint}' strategy.`);
    } else if ((signals.wantsArchitecture || signals.wantsResearch) && !signals.wantsImplementation) {
        strategy = 'council';
        rationale.push('Request is analysis/design-heavy without a direct implementation verb, so multi-expert review is the safest default.');
    } else if (signals.looksMultiStep) {
        strategy = 'plan';
        rationale.push('Request mixes implementation with validation/design/doc work, so dependency-aware orchestration is a better fit than a single worker.');
    } else {
        strategy = 'plan';
        rationale.push('E2E Default: Request focuses on implementation, automatically wrapped in an End-to-End Implementation -> Verification plan for self-healing.');
    }

    if (signals.wantsSecurity) {
        rationale.push('Security-sensitive keywords detected.');
    }
    if (signals.wantsPerformance) {
        rationale.push('Runtime/performance-sensitive keywords detected.');
    }

    const plan: OptimusDispatchPlan = {
        strategy,
        rationale,
        summaryOutputPath,
    };

    if (strategy === 'delegate') {
        plan.delegateSpec = buildDelegateSpec(input, summaryOutputPath, signals);
    } else if (strategy === 'council') {
        plan.councilSpec = buildCouncilSpec(input, summaryOutputPath, signals);
    } else {
        plan.planSpec = buildPlanSpec(input, summaryOutputPath, signals);
    }

    return plan;
}

export function renderOptimusSummary(plan: OptimusDispatchPlan, taskDescription: string, metadata?: {
    parentIssueNumber?: number;
    optimusIssueUrl?: string;
    taskIds?: string[];
    itemTaskIds?: Record<string, string>;
    reviewsPath?: string;
    status?: OptimusCompletionState;
    finalTasks?: OptimusTaskSnapshot[];
    waitForCompletion?: boolean;
    completionTimeoutMs?: number;
}): string {
    const lines: string[] = [
        '---',
        'type: report',
        `status: ${metadata?.status || 'queued'}`,
        `strategy: ${plan.strategy}`,
        ...(typeof metadata?.parentIssueNumber === 'number' ? [`parent_issue: ${metadata.parentIssueNumber}`] : []),
        '---',
        '',
        '# Optimus Dispatch Summary',
        '',
        `- Strategy: ${plan.strategy}`,
        ...plan.rationale.map(reason => `- Rationale: ${reason}`),
        ...(metadata?.optimusIssueUrl ? [`- Optimus Issue: ${metadata.optimusIssueUrl}`] : []),
        ...(metadata?.reviewsPath ? [`- Reviews Path: ${metadata.reviewsPath}`] : []),
        ...(metadata?.waitForCompletion ? [`- Wait For Completion: enabled (${Math.round((metadata.completionTimeoutMs || 0) / 1000)}s timeout)`] : []),
        '',
        '## Original Request',
        taskDescription,
    ];

    if (metadata?.taskIds && metadata.taskIds.length > 0) {
        lines.push('', '## Spawned Tasks');
        for (const taskId of metadata.taskIds) {
            lines.push(`- ${taskId}`);
        }
    }

    if (metadata?.itemTaskIds && Object.keys(metadata.itemTaskIds).length > 0) {
        lines.push('', '## Item Mapping');
        for (const [itemId, taskId] of Object.entries(metadata.itemTaskIds)) {
            lines.push(`- ${itemId} -> ${taskId}`);
        }
    }

    if (metadata?.finalTasks && metadata.finalTasks.length > 0) {
        lines.push('', '## Final Task Statuses');
        for (const task of metadata.finalTasks) {
            const fragments = [`- ${task.taskId}: ${task.effectiveStatus}`];
            if (task.githubIssueNumber) fragments.push(`issue #${task.githubIssueNumber}`);
            if (task.outputPath) fragments.push(`output ${task.outputPath}`);
            if (task.errorMessage && task.effectiveStatus !== 'verified') fragments.push(`error ${task.errorMessage}`);
            lines.push(fragments.join(' | '));
        }
    }

    return lines.join('\n') + '\n';
}

export function renderOptimusCouncilProposal(taskDescription: string, roles: string[]): string {
    return [
        '# PROBLEM: Optimus Orchestration Analysis',
        '',
        '## Request',
        taskDescription,
        '',
        '## Review Goals',
        `- Evaluate whether the request should be handled by one worker, a dependency-aware plan, or deeper orchestration.`,
        `- Focus review lanes: ${roles.join(', ')}.`,
        '- Call out the main risks, missing context, and the minimum safe next step.',
    ].join('\n') + '\n';
}
