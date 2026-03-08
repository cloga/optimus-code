export type AgentRunStatus = 'running' | 'success' | 'error';
export type AgentRole = 'planner' | 'executor';
export type TaskTurnStatus = 'in_progress' | 'completed' | 'failed';
export type TaskStatus = 'active' | 'blocked' | 'completed';

export interface AgentDebugSnapshot {
    command?: string;
    cwd?: string;
    pid?: number;
    duration?: number;
    promptTransport?: 'inline' | 'file';
    promptFilePath?: string;
    originalPromptLength?: number;
    sentPromptLength?: number;
    promptFileThreshold?: number;
}

export interface SessionImageAttachment {
    filePath: string;
    mimeType: string;
    src?: string;
}

export interface SessionResponseRecord {
    agent: string;
    agentId?: string;
    role?: AgentRole;
    prompt?: string;
    thinking?: string;
    text: string;
    usageLog?: string;
    status: AgentRunStatus;
    raw: boolean;
    debug?: AgentDebugSnapshot;
}

export interface ContributionRecord {
    agentId: string;
    agentName: string;
    role: AgentRole;
    status: AgentRunStatus;
    summary: string;
    rawText: string;
    filesTouched: string[];
    commandsObserved: string[];
    openQuestions: string[];
    nextStepSuggestion?: string;
    timestamp: number;
    debug?: AgentDebugSnapshot;
}

export interface ExecutorOutcomeRecord {
    agentId: string;
    agentName: string;
    status: AgentRunStatus;
    summary: string;
    rawText: string;
    timestamp: number;
    debug?: AgentDebugSnapshot;
}

export interface TurnRecord {
    turnId: string;
    sequence: number;
    prompt: string;
    startedAt: number;
    completedAt?: number;
    selectedAgentIds: string[];
    executorId?: string;
    status: TaskTurnStatus;
    plannerContributions: ContributionRecord[];
    executorOutcome?: ExecutorOutcomeRecord;
    synthesisPrompt?: string;
    failureReason?: string;
}

export interface SharedTaskState {
    taskId: string;
    createdAt: number;
    updatedAt: number;
    title: string;
    status: TaskStatus;
    pinned?: boolean;
    userIntentHistory: string[];
    plannerContributions: ContributionRecord[];
    executorOutcomes: ExecutorOutcomeRecord[];
    turnHistory: TurnRecord[];
    latestSummary: string;
    openQuestions: string[];
    blockedReasons: string[];
    lastOutcome?: string;
}

export interface TaskSnapshot {
    taskId: string;
    title: string;
    status: TaskStatus;
    pinned?: boolean;
    updatedAt: number;
    turnCount: number;
    latestSummary: string;
    latestPrompt?: string;
}

export interface StartTurnInput {
    taskId?: string;
    prompt: string;
    selectedAgentIds: string[];
    executorId?: string;
}

export interface StartTurnResult {
    taskState: SharedTaskState;
    turnRecord: TurnRecord;
    isNewTask: boolean;
}

export interface CompleteTurnInput {
    plannerContributions: ContributionRecord[];
    executorOutcome?: ExecutorOutcomeRecord;
    synthesisPrompt?: string;
}

export interface StoredSession {
    id: string;
    timestamp: number;
    prompt: string;
    taskId: string;
    turnId: string;
    attachments?: SessionImageAttachment[];
    failureReason?: string;
    responses: SessionResponseRecord[];
}
