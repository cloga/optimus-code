import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PersistentAgentAdapter } from '../adapters/PersistentAgentAdapter';
import {
    CompleteTurnInput,
    SharedTaskState,
    StartTurnInput,
    StartTurnResult,
    TaskSnapshot,
    TurnRecord,
} from '../types/SharedTaskContext';

export class SharedTaskStateManager {
    private static readonly storageKey = 'optimusTaskStates';
    private static readonly maxTasks = 25;
    private static readonly defaultCompactThreshold = 800000;

    constructor(private readonly globalState: vscode.Memento) {}

    public getCompactThreshold(): number {
        const configured = vscode.workspace.getConfiguration('optimusCode').get<number>('compactThresholdTokens');
        if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 1000) {
            return SharedTaskStateManager.defaultCompactThreshold;
        }
        return Math.floor(configured);
    }

    public async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
        const tasks = this.getTasks();
        const now = Date.now();

        let taskState = input.taskId
            ? tasks.find(task => task.taskId === input.taskId)
            : undefined;

        if (taskState && taskState.masterAgentType && input.masterAgentType && taskState.masterAgentType !== input.masterAgentType) {
            throw new Error(`Task '${taskState.title}' is bound to agent '${taskState.masterAgentType}'. You cannot switch to '${input.masterAgentType}' mid-session.`);
        }

        const isNewTask = !taskState;

        if (!taskState) {
            taskState = {
                taskId: this.buildId('task'),
                masterAgentType: input.masterAgentType,
                createdAt: now,
                updatedAt: now,
                title: this.buildTaskTitle(input.prompt),
                status: 'active',
                workspacePath: PersistentAgentAdapter.getWorkspacePath(),
                userIntentHistory: [],
                plannerContributions: [],
                executorOutcomes: [],
                turnHistory: [],
                latestSummary: 'New task created. No execution history yet.',
                openQuestions: [],
                blockedReasons: [],
            };
            tasks.unshift(taskState);
        }

        taskState.updatedAt = now;
        taskState.status = 'active';
        taskState.userIntentHistory.push(input.prompt);

        // Recover any zombie in_progress turns left by a previous abrupt shutdown
        for (const turn of taskState.turnHistory) {
            if (turn.status === 'in_progress') {
                turn.status = 'failed';
                turn.completedAt = now;
                turn.failureReason = 'Interrupted: VS Code was closed before this turn completed.';
            }
        }

        const turnRecord: TurnRecord = {
            turnId: this.buildId('turn'),
            sequence: taskState.turnHistory.length + 1,
            prompt: input.prompt,
            startedAt: now,
            selectedAgentIds: input.selectedAgentIds,
            executorId: input.executorId,
            status: 'in_progress',
            plannerContributions: [],
            referencedTurnSequences: input.referencedTurnSequences,
            attachments: input.attachments,
        };

        taskState.turnHistory.push(turnRecord);

        await this.saveTasks(tasks);
        return {
            taskState: this.clone(taskState),
            turnRecord: this.clone(turnRecord),
            isNewTask,
        };
    }

    public buildPlannerPrompt(taskState: SharedTaskState, turnRecord: TurnRecord, enrichedPrompt: string): string {
        const previousTurns = taskState.turnHistory.filter(turn => turn.turnId !== turnRecord.turnId);
        const recentTurns = previousTurns
            .filter(turn => turn.executorOutcome)
            .slice(-3)
            .map(turn => `Turn ${turn.sequence}:\n  User: ${turn.prompt}\n  Outcome: ${turn.executorOutcome!.summary}`)
            .join('\n');

        const taskSummary = taskState.latestSummary || 'New task — no prior execution history.';

        const openQuestions = taskState.openQuestions.length
            ? taskState.openQuestions.slice(-5).map(q => `- ${q}`).join('\n')
            : '- None recorded.';

        const blockedReasons = taskState.blockedReasons.length
            ? taskState.blockedReasons.slice(-5).map(r => `- ${r}`).join('\n')
            : '- None recorded.';

        const rulesContent = this.readRulesMd();
        const rulesParts: string[] = rulesContent
            ? ['', '<project-rules>', rulesContent.trim(), '</project-rules>', '']
            : [];

        const memoryContent = this.readMemoryMd();
        const memoryParts: string[] = memoryContent
            ? ['', '<project-memory>', memoryContent.trim(), '</project-memory>', '']
            : [];

        const referencedContext = this.buildReferencedTurnsContext(taskState, turnRecord.referencedTurnSequences);

        const parts: string[] = [
            'You are a planner agent for Optimus Code.',
            'Your role is read-only analysis and planning.',
            'Do not modify files, do not attempt to call edit/write/apply_patch/create/delete tools, and do not describe failed edit attempts or permission workarounds.',
            'If implementation is needed, propose the concrete next steps for the executor instead of trying to perform them yourself.',
            ...rulesParts,
            ...memoryParts,
            '',
            `Task ID: ${taskState.taskId}`,
            `Turn: ${turnRecord.sequence}`,
            `Current user request: "${turnRecord.prompt}"`,
            '',
            '<task-context>',
            `Task: ${taskState.title}`,
            '',
            'What has been accomplished so far:',
            taskSummary,
            '',
            recentTurns ? 'Recent turns:\n' + recentTurns : 'No prior executor outcomes.',
            '',
            'Known open questions:',
            openQuestions,
            '',
            'Known blockers:',
            blockedReasons,
            '</task-context>',
        ];

        if (turnRecord.attachments && turnRecord.attachments.length > 0) {
            parts.push('', 'User provided attachments:');
            for (const att of turnRecord.attachments) {
                parts.push(`- [${att.mimeType}] ${att.filePath}`);
            }
        }

        if (referencedContext) {
            parts.push('', referencedContext);
        }

        parts.push('', enrichedPrompt);

        parts.push(
            '',
            'IMPORTANT: At the very end of your response, output exactly one of the following tags to indicate whether code/file changes are needed to fulfill the user\'s request:',
            '<action-required>yes</action-required>   — if code changes, file modifications, or tool execution are needed',
            '<action-required>no</action-required>    — if this is purely analysis, review, Q&A, or advisory (no files need to change)',
            '',
            'Additionally, if you determine this is a simple, straightforward execution task (e.g. single file edit, rename, one-liner fix, run a command) that does NOT benefit from multi-planner deliberation, also output:',
            '<skip-to-executor>yes</skip-to-executor>',
            'This signals the orchestrator to skip waiting for other planners and proceed directly to the executor with your plan. Only use this for clearly simple tasks — do NOT use it for complex, multi-file, or architectural changes.',
        );

        return parts.join('\n');
    }

    public buildExecutorPrompt(taskState: SharedTaskState, turnRecord: TurnRecord, currentPrompt: string, synthesis: string, plannerIntent?: 'action' | 'answer' | 'skip' | 'unknown'): string {
        const previousTurns = taskState.turnHistory.filter(turn => turn.turnId !== turnRecord.turnId);
        const recentTurns = previousTurns.slice(-3).map(turn => {
            const executorSummary = turn.executorOutcome?.summary || 'No executor outcome recorded.';
            return `Turn ${turn.sequence}: ${turn.prompt}\nOutcome: ${executorSummary}`;
        }).join('\n\n');

        const taskSummary = taskState.latestSummary || 'No prior shared summary is available yet.';
        const openQuestions = taskState.openQuestions.length
            ? taskState.openQuestions.slice(-5).map(question => `- ${question}`).join('\n')
            : '- None recorded.';
        const blockedReasons = taskState.blockedReasons.length
            ? taskState.blockedReasons.slice(-5).map(reason => `- ${reason}`).join('\n')
            : '- None recorded.';

        const rulesContent = this.readRulesMd();
        const rulesParts: string[] = rulesContent
            ? ['', '<project-rules>', rulesContent.trim(), '</project-rules>', '']
            : [];

        const memoryContent = this.readMemoryMd();
        const memoryParts: string[] = memoryContent
            ? ['', '<project-memory>', memoryContent.trim(), '</project-memory>', '']
            : [];

        const referencedContext = this.buildReferencedTurnsContext(taskState, turnRecord.referencedTurnSequences);

        const parts = [
            'You are the executor agent for Optimus Code.',
            '',
            'RESPONSE GUIDELINES:',
            '- Lead with the direct answer or result first.',
            '- Be concise and direct. Avoid filler words.',
            '- Use bullet points for lists and steps.',
            '- Do not repeat task context unless necessary.',
            '- Prioritize code snippets and technical details.',
            ...rulesParts,
            ...memoryParts,
            '',
            `Task ID: ${taskState.taskId}`,
            `Turn: ${turnRecord.sequence}`,
            `Current user request: "${currentPrompt}"`,
            '',
            'Shared task summary:',
            taskSummary,
            '',
            'Recent completed turns:',
            recentTurns || 'This is the first execution turn for this task.',
            '',
            'Known open questions:',
            openQuestions,
            '',
            'Known blockers:',
            blockedReasons,
        ];

        if (referencedContext) {
            parts.push('', referencedContext);
        }

        parts.push(
            '',
            'Planner contributions for this turn:',
            synthesis,
        );

        if (plannerIntent === 'answer') {
            parts.push(
                '',
                'Planner consensus: answer-only — all planners indicated no code changes are needed.',
                'If you agree with this assessment, provide a synthesized answer only. Do NOT modify any files or call tools.',
            );
        }

        parts.push(
            '',
            'Based on the shared task state and planner contributions above, execute the best next step. Avoid repeating work that has already been completed unless the new request clearly requires it.',
            '',
            'IMPORTANT: After making any TypeScript or JavaScript code changes, you MUST run `npm run compile` to rebuild the extension bundle (`out/extension.js`). Running `npx tsc --noEmit` alone only performs type-checking and does NOT update the bundle. Verify the rebuild succeeds before finishing.',
            '',
            'After completing your work, append a concise progress summary wrapped in <task-summary> tags. This summary should capture what was accomplished in this turn and the overall task status in 2-3 sentences. Example:',
            '<task-summary>Refactored the auth module to use JWT tokens. All tests pass. Remaining: update API docs.</task-summary>',
            '',
            'IMPORTANT: At the end of each turn, evaluate whether you learned any important project-level facts, architecture decisions, user preferences, or key technical constraints that should persist across sessions. If so, you MUST wrap them in <memory-update> tags. The orchestrator will merge this into .optimus/memory.md automatically. Example:',
            '<memory-update>This project uses esbuild bundling. Always run `npm run compile` after code changes to rebuild `out/extension.js`. `npx tsc --noEmit` is type-check only.</memory-update>',
        );

        return parts.join('\n');
    }

    public buildPlanSynthesisPrompt(taskState: SharedTaskState, turnRecord: TurnRecord, currentPrompt: string, synthesis: string): string {
        const rulesContent = this.readRulesMd();
        const rulesParts: string[] = rulesContent
            ? ['', '<project-rules>', rulesContent.trim(), '</project-rules>', '']
            : [];

        const parts = [
            'You are SYNTHESIZER for Optimus Code.',
            'Multiple planners have analyzed the user\'s request. Your ONLY job is to merge their analyses into a single, coherent response.',
            'Do NOT execute code, modify files, or call any tools. Output a unified answer only.',
            ...rulesParts,
            '',
            `Task: ${taskState.title}`,
            `Turn: ${turnRecord.sequence}`,
            `User request: "${currentPrompt}"`,
            '',
            'Planner contributions:',
            synthesis,
            '',
            'Instructions:',
            '1. Identify points of consensus across all planners.',
            '2. Note any meaningful disagreements or unique insights from individual planners.',
            '3. Produce a single, well-structured response that answers the user\'s question.',
            '4. If planners propose actionable steps, present a unified recommendation.',
            '5. Keep your response concise — do not repeat the same point from multiple planners.',
        ];

        return parts.join('\n');
    }

    /**
     * Build executor prompt for direct→auto escalation: the executor receives
     * both the raw user prompt (for full context) AND the validation planner's
     * insight (explaining why this was escalated from direct to auto mode).
     */
    public buildDirectEscalatedPrompt(taskState: SharedTaskState, turnRecord: TurnRecord, currentPrompt: string, enrichedPrompt: string, plannerInsight: string): string {
        const previousTurns = taskState.turnHistory.filter(turn => turn.turnId !== turnRecord.turnId);
        const recentTurns = previousTurns.slice(-3).map(turn => {
            const executorSummary = turn.executorOutcome?.summary || 'No executor outcome recorded.';
            return `Turn ${turn.sequence}: ${turn.prompt}\nOutcome: ${executorSummary}`;
        }).join('\n\n');

        const taskSummary = taskState.latestSummary || 'No prior shared summary is available yet.';
        const openQuestions = taskState.openQuestions.length
            ? taskState.openQuestions.slice(-5).map(question => `- ${question}`).join('\n')
            : '- None recorded.';
        const blockedReasons = taskState.blockedReasons.length
            ? taskState.blockedReasons.slice(-5).map(reason => `- ${reason}`).join('\n')
            : '- None recorded.';

        const rulesContent = this.readRulesMd();
        const rulesParts: string[] = rulesContent
            ? ['', '<project-rules>', rulesContent.trim(), '</project-rules>', '']
            : [];

        const memoryContent = this.readMemoryMd();
        const memoryParts: string[] = memoryContent
            ? ['', '<project-memory>', memoryContent.trim(), '</project-memory>', '']
            : [];

        const referencedContext = this.buildReferencedTurnsContext(taskState, turnRecord.referencedTurnSequences);

        const parts = [
            'You are the executor agent for Optimus Code.',
            'This task was initially routed as DIRECT EXECUTION, but a validation planner detected it requires more careful planning.',
            '',
            'RESPONSE GUIDELINES:',
            '- Lead with the direct answer or result first.',
            '- Be concise and direct. Avoid filler words.',
            '- Use bullet points for lists and steps.',
            '- Do not repeat task context unless necessary.',
            '- Prioritize code snippets and technical details.',
            'You have both the original user request and the planner\'s analysis below. Use the planner insight to guide your approach, but execute the full user request.',
            ...rulesParts,
            ...memoryParts,
            '',
            `Task ID: ${taskState.taskId}`,
            `Turn: ${turnRecord.sequence}`,
            `Current user request: "${currentPrompt}"`,
            '',
            'Shared task summary:',
            taskSummary,
            '',
            'Recent completed turns:',
            recentTurns || 'This is the first execution turn for this task.',
            '',
            'Known open questions:',
            openQuestions,
            '',
            'Known blockers:',
            blockedReasons,
        ];

        if (turnRecord.attachments && turnRecord.attachments.length > 0) {
            parts.push('', 'User provided attachments:');
            for (const att of turnRecord.attachments) {
                parts.push(`- [${att.mimeType}] ${att.filePath}`);
            }
        }

        if (referencedContext) {
            parts.push('', referencedContext);
        }

        parts.push(
            '',
            'Validation planner analysis(explains why this task needs careful execution):',
            plannerInsight,
            '',
            enrichedPrompt,
            '',
            'Based on the planner analysis and the user request above, execute the task carefully. Avoid repeating work that has already been completed unless the new request clearly requires it.',
            '',
            'IMPORTANT: After making any TypeScript or JavaScript code changes, you MUST run `npm run compile` to rebuild the extension bundle (`out/extension.js`). Running `npx tsc --noEmit` alone only performs type-checking and does NOT update the bundle. Verify the rebuild succeeds before finishing.',
            '',
            'After completing your work, append a concise progress summary wrapped in <task-summary> tags. This summary should capture what was accomplished in this turn and the overall task status in 2-3 sentences. Example:',
            '<task-summary>Refactored the auth module to use JWT tokens. All tests pass. Remaining: update API docs.</task-summary>',
            '',
            'IMPORTANT: At the end of each turn, evaluate whether you learned any important project-level facts, architecture decisions, user preferences, or key technical constraints that should persist across sessions. If so, you MUST wrap them in <memory-update> tags. The orchestrator will merge this into .optimus/memory.md automatically. Example:',
            '<memory-update>This project uses esbuild bundling. Always run `npm run compile` after code changes to rebuild `out/extension.js`. `npx tsc --noEmit` is type-check only.</memory-update>',
        );

        return parts.join('\n');
    }

    public buildDirectExecutorPrompt(taskState: SharedTaskState, turnRecord: TurnRecord, currentPrompt: string, enrichedPrompt: string): string {
        const previousTurns = taskState.turnHistory.filter(turn => turn.turnId !== turnRecord.turnId);
        const recentTurns = previousTurns.slice(-3).map(turn => {
            const executorSummary = turn.executorOutcome?.summary || 'No executor outcome recorded.';
            return `Turn ${turn.sequence}: ${turn.prompt}\nOutcome: ${executorSummary}`;
        }).join('\n\n');

        const taskSummary = taskState.latestSummary || 'No prior shared summary is available yet.';
        const openQuestions = taskState.openQuestions.length
            ? taskState.openQuestions.slice(-5).map(question => `- ${question}`).join('\n')
            : '- None recorded.';
        const blockedReasons = taskState.blockedReasons.length
            ? taskState.blockedReasons.slice(-5).map(reason => `- ${reason}`).join('\n')
            : '- None recorded.';

        const rulesContent = this.readRulesMd();
        const rulesParts: string[] = rulesContent
            ? ['', '<project-rules>', rulesContent.trim(), '</project-rules>', '']
            : [];

        const memoryContent = this.readMemoryMd();
        const memoryParts: string[] = memoryContent
            ? ['', '<project-memory>', memoryContent.trim(), '</project-memory>', '']
            : [];

        const referencedContext = this.buildReferencedTurnsContext(taskState, turnRecord.referencedTurnSequences);

        const parts = [
            'You are the executor agent for Optimus Code.',
            'This is a DIRECT EXECUTION turn — no planner analysis was performed. Execute the user request directly.',
            '',
            'RESPONSE GUIDELINES:',
            '- Lead with the direct answer or result first.',
            '- Be concise and direct. Avoid filler words.',
            '- Use bullet points for lists and steps.',
            '- Do not repeat task context unless necessary.',
            '- Prioritize code snippets and technical details.',
            ...rulesParts,
            ...memoryParts,
            '',
            `Task ID: ${taskState.taskId}`,
            `Turn: ${turnRecord.sequence}`,
            `Current user request: "${currentPrompt}"`,
            '',
            'Shared task summary:',
            taskSummary,
            '',
            'Recent completed turns:',
            recentTurns || 'This is the first execution turn for this task.',
            '',
            'Known open questions:',
            openQuestions,
            '',
            'Known blockers:',
            blockedReasons,
        ];

        if (turnRecord.attachments && turnRecord.attachments.length > 0) {
            parts.push('', 'User provided attachments:');
            for (const att of turnRecord.attachments) {
                parts.push(`- [${att.mimeType}] ${att.filePath}`);
            }
        }

        if (referencedContext) {
            parts.push('', referencedContext);
        }

        parts.push(
            '',
            enrichedPrompt,
            '',
            'Execute the user request above directly. Avoid repeating work that has already been completed unless the new request clearly requires it.',
            '',
            'IMPORTANT: After making any TypeScript or JavaScript code changes, you MUST run `npm run compile` to rebuild the extension bundle (`out/extension.js`). Running `npx tsc --noEmit` alone only performs type-checking and does NOT update the bundle. Verify the rebuild succeeds before finishing.',
            '',
            'After completing your work, append a concise progress summary wrapped in <task-summary> tags. This summary should capture what was accomplished in this turn and the overall task status in 2-3 sentences. Example:',
            '<task-summary>Refactored the auth module to use JWT tokens. All tests pass. Remaining: update API docs.</task-summary>',
            '',
            'IMPORTANT: At the end of each turn, evaluate whether you learned any important project-level facts, architecture decisions, user preferences, or key technical constraints that should persist across sessions. If so, you MUST wrap them in <memory-update> tags. The orchestrator will merge this into .optimus/memory.md automatically. Example:',
            '<memory-update>This project uses esbuild bundling. Always run `npm run compile` after code changes to rebuild `out/extension.js`. `npx tsc --noEmit` is type-check only.</memory-update>',
        );

        return parts.join('\n');
    }

    public async completeTurn(taskId: string, turnId: string, input: CompleteTurnInput): Promise<SharedTaskState | undefined> {
        const tasks = this.getTasks();
        const taskState = tasks.find(task => task.taskId === taskId);
        if (!taskState) {
            return undefined;
        }

        const turnRecord = taskState.turnHistory.find(turn => turn.turnId === turnId);
        if (!turnRecord) {
            return undefined;
        }

        turnRecord.status = input.executorOutcome?.status === 'error' ? 'failed' : 'completed';
        turnRecord.completedAt = Date.now();
        turnRecord.plannerContributions = input.plannerContributions;
        turnRecord.executorOutcome = input.executorOutcome;
        turnRecord.synthesisPrompt = input.synthesisPrompt;

        taskState.updatedAt = turnRecord.completedAt;
        taskState.plannerContributions.push(...input.plannerContributions);
        if (input.executorOutcome) {
            taskState.executorOutcomes.push(input.executorOutcome);
            taskState.lastOutcome = input.executorOutcome.rawText;
        }

        taskState.openQuestions = this.collectOpenQuestions(taskState.turnHistory);
        if (input.executorOutcome?.status === 'error') {
            taskState.blockedReasons = taskState.turnHistory
                .filter(turn => turn.status === 'failed' && turn.failureReason)
                .map(turn => turn.failureReason as string)
                .slice(-5);
        } else {
            // Successful turn clears stale interrupt/blocker history
            taskState.blockedReasons = [];
        }
        taskState.status = input.executorOutcome?.status === 'error' ? 'blocked' : 'active';
        taskState.latestSummary = this.buildTaskSummary(taskState);

        await this.saveTasks(tasks);
        return this.clone(taskState);
    }

    public async failTurn(taskId: string, turnId: string, failureReason: string): Promise<SharedTaskState | undefined> {
        const tasks = this.getTasks();
        const taskState = tasks.find(task => task.taskId === taskId);
        if (!taskState) {
            return undefined;
        }

        const turnRecord = taskState.turnHistory.find(turn => turn.turnId === turnId);
        if (!turnRecord) {
            return undefined;
        }

        turnRecord.status = 'failed';
        turnRecord.completedAt = Date.now();
        turnRecord.failureReason = failureReason;
        taskState.updatedAt = turnRecord.completedAt;
        taskState.status = 'blocked';
        taskState.blockedReasons = [...taskState.blockedReasons, failureReason].slice(-5);
        taskState.latestSummary = this.buildTaskSummary(taskState);

        await this.saveTasks(tasks);
        return this.clone(taskState);
    }

    public listTaskSnapshots(): TaskSnapshot[] {
        return this.getTasks().map(task => ({
            taskId: task.taskId,
            masterAgentType: task.masterAgentType,
            title: task.title,
            status: task.status,
            pinned: task.pinned,
            updatedAt: task.updatedAt,
            turnCount: task.turnHistory.length,
            latestSummary: task.latestSummary,
            latestPrompt: task.turnHistory[task.turnHistory.length - 1]?.prompt,
            workspacePath: task.workspacePath,
        }));
    }

    public getTask(taskId: string): SharedTaskState | undefined {
        const taskState = this.getTasks().find(task => task.taskId === taskId);
        return taskState ? this.clone(taskState) : undefined;
    }

    public async renameTask(taskId: string, newTitle: string): Promise<boolean> {
        const tasks = this.getTasks();
        const taskState = tasks.find(task => task.taskId === taskId);
        if (!taskState) { return false; }
        taskState.title = newTitle.trim() || taskState.title;
        taskState.updatedAt = Date.now();
        await this.saveTasks(tasks);
        return true;
    }

    public async deleteTask(taskId: string): Promise<boolean> {
        const tasks = this.getTasks();
        const index = tasks.findIndex(task => task.taskId === taskId);
        if (index === -1) { return false; }
        tasks.splice(index, 1);
        await this.saveTasks(tasks);
        return true;
    }

    public async updateTaskSummary(taskId: string, summary: string): Promise<boolean> {
        const tasks = this.getTasks();
        const taskState = tasks.find(task => task.taskId === taskId);
        if (!taskState) { return false; }
        taskState.latestSummary = summary;
        taskState.updatedAt = Date.now();
        await this.saveTasks(tasks);
        return true;
    }

    public async pinTask(taskId: string): Promise<boolean> {
        const tasks = this.getTasks();
        const taskState = tasks.find(task => task.taskId === taskId);
        if (!taskState) { return false; }
        taskState.pinned = !taskState.pinned;
        taskState.updatedAt = Date.now();
        await this.saveTasks(tasks);
        return true;
    }

    public async updateTaskCliSessionId(taskId: string, cliSessionId: string): Promise<boolean> {
        const tasks = this.getTasks();
        const taskState = tasks.find(task => task.taskId === taskId);
        if (!taskState) { return false; }
        taskState.cliSessionId = cliSessionId;
        taskState.updatedAt = Date.now();
        await this.saveTasks(tasks);
        return true;
    }

    private collectOpenQuestions(turnHistory: TurnRecord[]): string[] {
        return turnHistory
            .flatMap(turn => turn.plannerContributions.flatMap(contribution => contribution.openQuestions))
            .filter(Boolean)
            .slice(-10);
    }

    private buildReferencedTurnsContext(taskState: SharedTaskState, sequences?: number[]): string | null {
        if (!sequences || sequences.length === 0) { return null; }
        const referencedTurns = taskState.turnHistory.filter(turn => sequences.includes(turn.sequence));
        if (referencedTurns.length === 0) { return null; }

        const blocks = referencedTurns.map(turn => {
            const outcome = turn.executorOutcome?.summary ?? 'No outcome recorded.';
            const synthesis = turn.synthesisPrompt ? `\nPlanner synthesis: ${turn.synthesisPrompt}` : '';
            const plannerSummaries = turn.plannerContributions.length > 0
                ? '\nPlanner contributions: ' + turn.plannerContributions.map(c => `${c.agentName}: ${c.summary}`).join(' | ')
                : '';
            return `<referenced-turn sequence="${turn.sequence}" status="${turn.status}">\nUser request: ${turn.prompt}${plannerSummaries}${synthesis}\nExecutor outcome: ${outcome}\n</referenced-turn>`;
        });

        return '<user-referenced-turns>\nThe user explicitly referenced the following prior turns for additional context:\n' + blocks.join('\n') + '\n</user-referenced-turns>';
    }

    private buildTaskSummary(taskState: SharedTaskState): string {
        const latestTurn = taskState.turnHistory[taskState.turnHistory.length - 1];
        const plannerNames = latestTurn?.plannerContributions.map(contribution => contribution.agentName).join(', ') || 'none';
        const latestExecutor = latestTurn?.executorOutcome?.summary || 'No executor outcome recorded.';
        return [
            `Task: ${taskState.title}`,
            `Turns completed: ${taskState.turnHistory.filter(turn => turn.status !== 'in_progress').length}`,
            `Latest user intent: ${taskState.userIntentHistory[taskState.userIntentHistory.length - 1] || 'n/a'}`,
            `Latest planners: ${plannerNames}`,
            `Latest executor outcome: ${latestExecutor}`,
        ].join('\n');
    }

    private buildTaskTitle(prompt: string): string {
        const normalized = prompt.trim().replace(/\s+/g, ' ');
        return normalized.length > 80 ? normalized.slice(0, 77) + '...' : normalized || 'Untitled task';
    }

    /**
     * Rough token estimate: ~4 chars per token for English, ~2 chars per token for CJK.
     * This is a fast heuristic, not a precise tokenizer.
     */
    public estimateContextTokens(taskState: SharedTaskState): number {
        const parts: string[] = [
            taskState.title,
            taskState.latestSummary,
            ...taskState.userIntentHistory,
            ...taskState.openQuestions,
            ...taskState.blockedReasons,
        ];
        for (const turn of taskState.turnHistory) {
            parts.push(turn.prompt);
            if (turn.executorOutcome) {
                parts.push(turn.executorOutcome.summary);
                parts.push(turn.executorOutcome.rawText);
            }
            for (const c of turn.plannerContributions) {
                parts.push(c.summary);
                parts.push(c.rawText);
            }
            if (turn.synthesisPrompt) {
                parts.push(turn.synthesisPrompt);
            }
        }
        const text = parts.filter(Boolean).join(' ');
        // Mixed heuristic: CJK chars count ~0.5 tokens each, ASCII ~0.25
        // Use regex to count CJK characters in one pass instead of char-by-char loop
        const cjkCount = (text.match(/[\u2E80-\uFFFF]/g) || []).length;
        const tokens = (text.length - cjkCount) * 0.25 + cjkCount * 0.5;
        return Math.round(tokens);
    }

    /**
     * Check if context exceeds threshold and needs compaction.
     */
    public needsCompaction(taskState: SharedTaskState): boolean {
        return this.estimateContextTokens(taskState) > this.getCompactThreshold();
    }

    /**
     * Compact context: summarize old turns into latestSummary and trim history.
     * Keeps only the most recent N turns with full data.
     */
    public async compactContext(taskId: string): Promise<SharedTaskState | undefined> {
        const tasks = this.getTasks();
        const taskState = tasks.find(task => task.taskId === taskId);
        if (!taskState) { return undefined; }

        const keepRecent = 2;
        if (taskState.turnHistory.length <= keepRecent) {
            return this.clone(taskState);
        }

        const oldTurns = taskState.turnHistory.slice(0, -keepRecent);
        const keptTurns = taskState.turnHistory.slice(-keepRecent);

        // Build a compacted summary from old turns
        const oldTurnSummaries = oldTurns.map(turn => {
            const outcome = turn.executorOutcome?.summary || 'no outcome';
            return `Turn ${turn.sequence} (${turn.status}): ${turn.prompt.slice(0, 100)} → ${outcome}`;
        }).join('\n');

        const previousSummary = taskState.latestSummary || '';
        taskState.latestSummary = [
            previousSummary,
            '',
            'Compacted history:',
            oldTurnSummaries,
        ].join('\n').trim();

        // Trim old turns: keep only lightweight records
        for (const turn of oldTurns) {
            turn.plannerContributions = turn.plannerContributions.map(c => ({
                ...c,
                rawText: c.summary,
            }));
            if (turn.executorOutcome) {
                turn.executorOutcome.rawText = turn.executorOutcome.summary;
            }
            turn.synthesisPrompt = undefined;
        }

        // Also trim top-level accumulated arrays
        taskState.plannerContributions = taskState.plannerContributions.slice(-5);
        taskState.executorOutcomes = taskState.executorOutcomes.slice(-5);
        taskState.userIntentHistory = taskState.userIntentHistory.slice(-5);

        taskState.updatedAt = Date.now();
        await this.saveTasks(tasks);
        return this.clone(taskState);
    }

    public getTasks(): SharedTaskState[] {
        return this.globalState.get<SharedTaskState[]>(SharedTaskStateManager.storageKey, []);
    }

    private async saveTasks(tasks: SharedTaskState[]): Promise<void> {
        const limitedTasks = tasks
            .sort((left, right) => {
                if (left.pinned !== right.pinned) { return left.pinned ? -1 : 1; }
                return right.updatedAt - left.updatedAt;
            })
            .slice(0, SharedTaskStateManager.maxTasks);
        await this.globalState.update(SharedTaskStateManager.storageKey, limitedTasks);
    }

    private buildId(prefix: string): string {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    public readRulesMd(): string | null {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
            const rootPath = workspaceFolders[0].uri.fsPath;
            const rulesPath = path.join(rootPath, '.optimus', 'config', 'rules.md');
            
            let rulesContent = "";
            if (fs.existsSync(rulesPath)) {
                rulesContent += fs.readFileSync(rulesPath, 'utf8') + "\n\n";
            }

            // Also load the orchestrator skills automatically
            const delegateSkillPath = path.join(rootPath, "resources", "plugins", "skills", "delegate_task.md");
            if (fs.existsSync(delegateSkillPath)) {
                rulesContent += "---\n[SYSTEM: INJECTED SKILL - delegate_task]\n" + fs.readFileSync(delegateSkillPath, 'utf8');
            }

            // Inject available engines and models dynamically from settings
            const modelsConfig = vscode.workspace.getConfiguration('optimusCode').get<any>('models');
            if (modelsConfig) {
                rulesContent += `\n\n## Available CLI Engines and Models (Dynamic)\n`;
                if (modelsConfig.claude_code) {
                    rulesContent += `- **github copilot**: Implicitly maps to \`engine: "copilot_cli"\`.\n`;
                }
                rulesContent += `You MUST map user colloquial requests like "github copilot" or "claude code" to the actual engine IDs used by the tool.\n`;
                rulesContent += `Current available models:\n${JSON.stringify(modelsConfig, null, 2)}\n`;
            }

            return rulesContent.trim().length > 0 ? rulesContent : null;
        } catch (err) {
            console.error("SharedTaskStateManager readRulesMd error:", err);
            return null;
        }
    }

    public readMemoryMd(): string | null {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
            const memPath = path.join(workspaceFolders[0].uri.fsPath, '.optimus', 'state', 'memory.md');
            if (!fs.existsSync(memPath)) { return null; }
            return fs.readFileSync(memPath, 'utf8');
        } catch {
            return null;
        }
    }

    public writeMemoryMd(newContent: string): void {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) { return; }
            const optimusDir = path.join(workspaceFolders[0].uri.fsPath, '.optimus');
            if (!fs.existsSync(optimusDir)) { fs.mkdirSync(optimusDir, { recursive: true }); }
            const memPath = path.join(optimusDir, 'state', 'memory.md');
            fs.writeFileSync(memPath, newContent, 'utf8');
        } catch {
            // non-fatal: memory write failure should never block turn completion
        }
    }

    private clone<T>(value: T): T {
        return structuredClone(value);
    }
}
