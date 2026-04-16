import path from 'path';
import { AsyncPlanItem, canonicalizeDelegateOutputPath } from './async-plan-dispatch';

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

function includesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some(pattern => pattern.test(text));
}

function collectSignals(taskDescription: string): OptimusSignalSet {
    const text = taskDescription.toLowerCase();
    const wantsImplementation = includesAny(text, [
        /\bimplement\b/, /\bbuild\b/, /\bfix\b/, /\badd\b/, /\bupdate\b/, /\bchange\b/,
        /\bmodify\b/, /\brefactor\b/, /\bwire\b/, /\bintegrat(e|ion)\b/, /\bstart implementation\b/
    ]);
    const wantsVerification = includesAny(text, [
        /\btest\b/, /\btests\b/, /\bverify\b/, /\bvalidation\b/, /\bvalidate\b/, /\bsmoke\b/,
        /\bqa\b/, /\breview\b/, /\baudit\b/
    ]);
    const wantsArchitecture = includesAny(text, [
        /\barchitect(?:ure)?\b/, /\bdesign\b/, /\bproposal\b/, /\bprotocol\b/, /\bschema\b/,
        /\btrade-?off\b/, /\bdirection\b/, /\bapproach\b/, /\bmigration\b/
    ]);
    const wantsResearch = includesAny(text, [
        /\bresearch\b/, /\binvestigat(e|ion)\b/, /\banaly(s|z)e\b/, /\banalysis\b/, /\bcompare\b/,
        /\bexplore\b/, /\bplan\b/
    ]);
    const wantsSecurity = includesAny(text, [
        /\bsecurity\b/, /\bauth\b/, /\bpermission\b/, /\bcredential\b/, /\bsecret\b/,
        /\bvulnerab(?:ility|le)\b/, /\bharden\b/
    ]);
    const wantsPerformance = includesAny(text, [
        /\bperformance\b/, /\blatency\b/, /\bthroughput\b/, /\bscale\b/, /\bscalability\b/,
        /\bconcurrency\b/, /\bruntime\b/
    ]);
    const wantsDocs = includesAny(text, [
        /\bdocument\b/, /\bdocumentation\b/, /\breadme\b/, /\bchangelog\b/, /\bdocs\b/
    ]);
    const looksMultiStep = /\n\s*(?:[-*]|\d+\.)\s+/.test(taskDescription)
        || /\b(?:first|then|finally)\b/.test(text)
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

    return { items };
}

export function buildOptimusDispatchPlan(input: OptimusPlannerInput): OptimusDispatchPlan {
    const summaryOutputPath = canonicalizeDelegateOutputPath(input.workspacePath, input.outputPath);
    const signals = collectSignals(input.taskDescription);
    const rationale: string[] = [];

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
}): string {
    const lines: string[] = [
        '---',
        'type: report',
        'status: queued',
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