import * as vscode from 'vscode';
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
        const isNewTask = !taskState;

        if (!taskState) {
            taskState = {
                taskId: this.buildId('task'),
                createdAt: now,
                updatedAt: now,
                title: this.buildTaskTitle(input.prompt),
                status: 'active',
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
            ? taskState.openQuestions.slice(-3).map(q => `- ${q}`).join('\n')
            : null;

        const blockedReasons = taskState.blockedReasons.length
            ? taskState.blockedReasons.slice(-3).map(r => `- ${r}`).join('\n')
            : null;

        const parts: string[] = [
            'You are a planner agent for Optimus Code.',
            'Your role is read-only analysis and planning.',
            'Do not modify files, do not attempt to call edit/write/apply_patch/create/delete tools, and do not describe failed edit attempts or permission workarounds.',
            'If implementation is needed, propose the concrete next steps for the executor instead of trying to perform them yourself.',
            '',
            '<task-context>',
            `Task: ${taskState.title}`,
            `Turn: ${turnRecord.sequence}`,
            '',
            'What has been accomplished so far:',
            taskSummary,
            '',
            recentTurns ? 'Recent turns:\n' + recentTurns : 'No prior executor outcomes.',
        ];

        if (openQuestions) {
            parts.push('', 'Known open questions:', openQuestions);
        }
        if (blockedReasons) {
            parts.push('', 'Known blockers:', blockedReasons);
        }

        parts.push('</task-context>', '', enrichedPrompt);

        return parts.join('\n');
    }

    public buildExecutorPrompt(taskState: SharedTaskState, turnRecord: TurnRecord, currentPrompt: string, synthesis: string): string {
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
        return [
            'You are the executor agent for Optimus Code.',
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
            '',
            'Planner contributions for this turn:',
            synthesis,
            '',
            'Based on the shared task state and planner contributions above, execute the best next step. Avoid repeating work that has already been completed unless the new request clearly requires it.',
            '',
            'After completing your work, append a concise progress summary wrapped in <task-summary> tags. This summary should capture what was accomplished in this turn and the overall task status in 2-3 sentences. Example:',
            '<task-summary>Refactored the auth module to use JWT tokens. All tests pass. Remaining: update API docs.</task-summary>',
        ].join('\n');
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
        taskState.blockedReasons = taskState.turnHistory
            .filter(turn => turn.status === 'failed' && turn.failureReason)
            .map(turn => turn.failureReason as string)
            .slice(-5);
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
            title: task.title,
            status: task.status,
            pinned: task.pinned,
            updatedAt: task.updatedAt,
            turnCount: task.turnHistory.length,
            latestSummary: task.latestSummary,
            latestPrompt: task.turnHistory[task.turnHistory.length - 1]?.prompt,
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

    private collectOpenQuestions(turnHistory: TurnRecord[]): string[] {
        return turnHistory
            .flatMap(turn => turn.plannerContributions.flatMap(contribution => contribution.openQuestions))
            .filter(Boolean)
            .slice(-10);
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
        let tokens = 0;
        for (let i = 0; i < text.length; i++) {
            tokens += text.charCodeAt(i) > 0x2E80 ? 0.5 : 0.25;
        }
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

    private getTasks(): SharedTaskState[] {
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

    private clone<T>(value: T): T {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}
