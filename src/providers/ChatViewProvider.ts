import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getActiveAdapters } from '../adapters';
import { AgentAdapter } from '../adapters/AgentAdapter';
import { PersistentAgentAdapter } from '../adapters/PersistentAgentAdapter';
import { SharedTaskStateManager } from '../managers/SharedTaskStateManager';
import { marked } from 'marked';
import { debugLog } from '../debugLogger';
import { ContributionRecord, ExecutorOutcomeRecord, SessionImageAttachment, SessionResponseRecord, StoredSession } from '../types/SharedTaskContext';
import { ANSI_RE } from '../utils/textParsing';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'optimus-code.chatView';
    private _view?: vscode.WebviewView;
    private _activeRunAdapters: ReturnType<typeof getActiveAdapters> = [];
    private _currentTaskId?: string;
    private _activeTurnRef?: { taskId: string; turnId: string };
    private _activeStopReason?: string;
    private readonly _runningTaskIds = new Set<string>();
    private readonly _taskStateManager: SharedTaskStateManager;

    private _isDebugModeEnabled() {
        return vscode.workspace.getConfiguration('optimusCode').get<boolean>('debugMode', false);
    }

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._taskStateManager = new SharedTaskStateManager(this._context.globalState);
    }

    private _getActiveEditorContext(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return undefined;
        }

        const doc = editor.document;
        const filePath = vscode.workspace.asRelativePath(doc.uri, false);
        const lang = doc.languageId;
        const selection = editor.selection;

        let codeSnippet: string;
        let contextLabel: string;

        if (!selection.isEmpty) {
            codeSnippet = doc.getText(selection);
            const startLine = selection.start.line + 1;
            const endLine = selection.end.line + 1;
            contextLabel = `${filePath}:${startLine}-${endLine} (selected)`;
        } else {
            // Visible range fallback — at most 80 lines to avoid bloating the prompt
            const visibleRange = editor.visibleRanges[0];
            if (!visibleRange) {
                return undefined;
            }
            const maxLines = 80;
            const startLine = visibleRange.start.line;
            const endLine = Math.min(visibleRange.end.line, startLine + maxLines - 1);
            codeSnippet = doc.getText(new vscode.Range(startLine, 0, endLine + 1, 0)).trimEnd();
            contextLabel = `${filePath}:${startLine + 1}-${endLine + 1} (visible)`;
        }

        if (!codeSnippet.trim()) {
            return undefined;
        }

        return `<active-editor-context file="${contextLabel}" lang="${lang}">\n${codeSnippet}\n</active-editor-context>`;
    }

    private _buildContextBadge(): { label: string; hasContext: boolean } {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return { label: '', hasContext: false };
        }

        const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        const selection = editor.selection;
        if (!selection.isEmpty) {
            return {
                label: `${filePath}:${selection.start.line + 1}-${selection.end.line + 1}`,
                hasContext: true,
            };
        }

        return { label: filePath, hasContext: true };
    }

    private _sendContextBadge() {
        const badge = this._buildContextBadge();
        this._view?.webview.postMessage({ type: 'updateContextBadge', ...badge });
    }

    private _registerWorkspacePathHint() {
        const workspacePathHint = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || (vscode.window.activeTextEditor?.document?.uri.scheme === 'file'
                ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath
                    || vscode.window.activeTextEditor.document.uri.fsPath
                : undefined)
            || (this._context.extensionMode === vscode.ExtensionMode.Development
                ? this._extensionUri.fsPath
                : undefined);

        if (!workspacePathHint) {
            debugLog('Workspace', 'No workspace path hint available during webview resolution');
            return;
        }

        PersistentAgentAdapter.setWorkspacePathHint(workspacePathHint);
        debugLog('Workspace', 'Registered workspace path hint during webview resolution', JSON.stringify({ workspacePathHint }));
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._currentTaskId = undefined;
        this._registerWorkspacePathHint();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri,
                this._context.globalStorageUri,
            ]
        };

        webviewView.webview.onDidReceiveMessage(async data => {
            debugLog('Webview', 'Received message from webview', JSON.stringify({
                type: data.type,
                hasValue: typeof data.value === 'string' ? data.value.length > 0 : false,
                agentCount: Array.isArray(data.agents) ? data.agents.length : undefined,
                executor: data.executor,
                taskId: data.taskId,
                sessionId: data.sessionId,
            }));

            if (this._isDebugModeEnabled()) {
                this._view?.webview.postMessage({
                    type: 'hostDebug',
                    phase: 'received',
                    messageType: data.type,
                    detail: JSON.stringify({
                        hasValue: typeof data.value === 'string' ? data.value.length > 0 : false,
                        agentCount: Array.isArray(data.agents) ? data.agents.length : undefined,
                        executor: data.executor,
                        taskId: data.taskId,
                        sessionId: data.sessionId,
                    })
                });
            }

            switch (data.type) {
                case 'askCouncil':
                    {
                        await this._delegateToCouncil(data.value, data.agents, data.mode, data.executor, data.images);
                        break;
                    }
                case 'newChat':
                    {
                        this._currentTaskId = undefined;
                        break;
                    }
                case 'requestSessions':
                    {
                        this._sendSessionsToUI();
                        break;
                    }
                case 'loadSession':
                    {
                        await this._loadSessionToUI(data.sessionId);
                        break;
                    }
                case 'resumeTask':
                    {
                        await this._resumeTask(data.taskId, data.sessionId);
                        break;
                    }
                case 'renameTask':
                    {
                        await this._renameTask(data.taskId, data.newTitle);
                        break;
                    }
                case 'deleteTask':
                    {
                        await this._deleteTask(data.taskId, data.sessionId);
                        break;
                    }
                case 'pinTask':
                    {
                        await this._pinTask(data.taskId);
                        break;
                    }
                case 'compactContext':
                    {
                        if (this._currentTaskId) {
                            const taskState = this._taskStateManager.getTask(this._currentTaskId);
                            const tokensBefore = taskState ? this._taskStateManager.estimateContextTokens(taskState) : 0;
                            debugLog('Compact', 'Manual compact requested', JSON.stringify({ taskId: this._currentTaskId, tokensBefore }));
                            const compacted = await this._taskStateManager.compactContext(this._currentTaskId);
                            if (compacted) {
                                const tokensAfter = this._taskStateManager.estimateContextTokens(compacted);
                                this._sendCurrentTaskState();
                                this._view?.webview.postMessage({
                                    type: 'compactResult',
                                    trigger: 'manual',
                                    tokensBefore,
                                    tokensAfter,
                                    tokensFreed: tokensBefore - tokensAfter,
                                });
                            }
                        }
                        break;
                    }
                case 'requestAgents':
                    {
                        this._sendAgentsToUI();
                        break;
                    }
                case 'webviewReady':
                    {
                        this._sendAgentsToUI();
                        this._sendUiState();
                        this._sendCurrentTaskState();
                        this._sendContextBadge();
                        break;
                    }
                case 'openSettings':
                    {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'optimusCode.debugMode');
                        break;
                    }
                case 'stopCouncil':
                    {
                        this._stopActiveCouncil();
                        break;
                    }
                case 'applyCodeBlock':
                    {
                        await this._applyCodeBlock(data.filePath, data.code);
                        break;
                    }
            }
        });

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Listen for configuration changes to update the agent checkboxes
        this._context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('optimusCode') && this._view) {
                    this._sendAgentsToUI();
                    this._sendUiState();
                    this._sendCurrentTaskState();
                }
            })
        );

        // Send context badge when the active editor or selection changes
        this._context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                if (this._view) { this._sendContextBadge(); }
            }),
            vscode.window.onDidChangeTextEditorSelection(() => {
                if (this._view) { this._sendContextBadge(); }
            })
        );
    }

    private _sendAgentsToUI() {
        const adapters = getActiveAdapters();
        debugLog('Webview', '_sendAgentsToUI, adapters: ' + adapters.map(a => a.id).join(', '));
        debugLog('Webview', 'Sending agent selector update', JSON.stringify(adapters.map(a => ({
            id: a.id,
            name: a.name,
            modes: a.modes
        }))));
        this._view?.webview.postMessage({
            type: 'updateAgentSelector',
            agents: adapters.map(a => ({ id: a.id, name: a.name, modes: a.modes }))
        });
    }

    private _sendUiState() {
        debugLog('Webview', 'Sending UI state update', JSON.stringify({ debugMode: this._isDebugModeEnabled() }));
        this._view?.webview.postMessage({
            type: 'updateUiState',
            debugMode: this._isDebugModeEnabled()
        });
    }

    private _sendCurrentTaskState() {
        if (!this._view) {
            return;
        }

        const taskState = this._currentTaskId ? this._taskStateManager.getTask(this._currentTaskId) : undefined;
        const latestTurn = taskState?.turnHistory[taskState.turnHistory.length - 1];
        this._view.webview.postMessage({
            type: 'updateTaskState',
            task: taskState
                ? {
                    taskId: taskState.taskId,
                    title: taskState.title,
                    status: taskState.status,
                    turnCount: taskState.turnHistory.length,
                    latestSummary: taskState.latestSummary,
                    latestPrompt: latestTurn?.prompt,
                    latestTurnStatus: latestTurn?.status,
                    latestTurnSequence: latestTurn?.sequence,
                    latestPlannerNames: latestTurn?.plannerContributions.map(contribution => contribution.agentName) || [],
                    latestExecutorSummary: latestTurn?.executorOutcome?.summary,
                    openQuestions: taskState.openQuestions.slice(-3),
                    blockedReasons: taskState.blockedReasons.slice(-3),
                    contextTokens: this._taskStateManager.estimateContextTokens(taskState),
                    needsCompaction: this._taskStateManager.needsCompaction(taskState),
                }
                : null,
        });
    }

    private _makeStreamingCallback(
        agentName: string,
        adapter?: AgentAdapter,
        sessionMeta?: { turnId: string; agentId?: string; role?: 'planner' | 'executor'; prompt?: string }
    ): { callback: (text: string) => void; flush: () => void } {
        let pendingText = '';
        let timer: ReturnType<typeof setTimeout> | null = null;

        const send = async () => {
            timer = null;
            const text = pendingText;
            if (!text) { return; }
            const parsed = this._extractThinking(text, adapter);
            const thinkingHtml = parsed.thinking ? await marked.parse(parsed.thinking) : '';
            const outputHtml = parsed.output ? await marked.parse(parsed.output) : '';
            this._view?.webview.postMessage({
                type: 'agentUpdate',
                agent: agentName,
                thinkingHtml,
                thinkingText: parsed.thinking,
                outputHtml,
                rawText: text,
            });

            if (sessionMeta?.turnId) {
                this._upsertSessionResponse(sessionMeta.turnId, {
                    agent: agentName,
                    agentId: sessionMeta.agentId,
                    role: sessionMeta.role,
                    prompt: sessionMeta.prompt,
                    thinking: parsed.thinking,
                    text: parsed.output || text,
                    status: 'running',
                    raw: false,
                    debug: adapter?.lastDebugInfo,
                });
            }
        };

        const callback = (incrementalText: string) => {
            pendingText = incrementalText;
            if (timer === null) {
                timer = setTimeout(send, 100);
            }
        };

        const flush = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
                send();
            }
        };

        return { callback, flush };
    }

    private _postPhaseStart(
        phaseKind: 'planner' | 'executor',
        agents: Array<{ id: string; name: string; role: 'planner' | 'executor' }>,
        prompt: string,
        autoCollapseOnSuccess?: boolean
    ) {
        this._view?.webview.postMessage({
            type: 'startCouncil',
            phaseKind,
            agents,
            prompt,
            autoCollapseOnSuccess,
        });
    }

    private _saveImagesToDisk(images: { dataUrl: string; mimeType: string }[]): SessionImageAttachment[] {
        const storageDir = this._context.globalStorageUri.fsPath;
        fs.mkdirSync(storageDir, { recursive: true });
        const ts = Date.now();
        return images.map((img, i) => {
            const ext = img.mimeType.split('/')[1] || 'png';
            const rand = Math.random().toString(36).slice(2, 7);
            const filePath = path.join(storageDir, `paste-${ts}-${i}-${rand}.${ext}`);
            const base64 = img.dataUrl.replace(/^data:[^;]+;base64,/, '');
            fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
            return { filePath, mimeType: img.mimeType };
        });
    }

    private _toWebviewAttachment(attachment: SessionImageAttachment): SessionImageAttachment | undefined {
        if (!this._view || !attachment.filePath || !fs.existsSync(attachment.filePath)) {
            return undefined;
        }

        return {
            ...attachment,
            src: this._view.webview.asWebviewUri(vscode.Uri.file(attachment.filePath)).toString(),
        };
    }

    private _upsertSessionResponse(turnId: string, nextResponse: SessionResponseRecord) {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const sessionIndex = sessions.findIndex(session => session.turnId === turnId);
        if (sessionIndex === -1) {
            return;
        }

        const session = sessions[sessionIndex];
        const responseIndex = session.responses.findIndex(response =>
            response.agent === nextResponse.agent
            && response.role === nextResponse.role
            && response.agentId === nextResponse.agentId
        );

        const responses = session.responses.slice();
        if (responseIndex === -1) {
            responses.push(nextResponse);
        } else {
            responses[responseIndex] = {
                ...responses[responseIndex],
                ...nextResponse,
            };
        }

        sessions[sessionIndex] = { ...session, responses };
        this._context.globalState.update('optimusSessions', sessions);
    }

    private _initializeSessionResponses(
        turnId: string,
        agents: Array<{ name: string; agentId?: string; role?: 'planner' | 'executor'; prompt?: string }>
    ) {
        agents.forEach(agent => {
            this._upsertSessionResponse(turnId, {
                agent: agent.name,
                agentId: agent.agentId,
                role: agent.role,
                prompt: agent.prompt,
                thinking: '',
                text: '',
                status: 'running',
                raw: false,
            });
        });
    }

    private async _delegateToCouncil(prompt: string, selectedAgentIds: string[] = [], mode: string = 'auto', executorId?: string, images?: { dataUrl: string; mimeType: string }[]) {
        if (!this._view) { return; }

        // Save pasted images to disk and inject file paths into the prompt
        let imageNote = '';
        let storedAttachments: SessionImageAttachment[] = [];
        if (images && images.length > 0) {
            storedAttachments = this._saveImagesToDisk(images);
            imageNote = '\n\n[Attached images]\n' + storedAttachments.map(image => `- ${image.filePath}`).join('\n') + '\n';
        }

        // Prepend active editor context so planners have live code awareness
        const editorContext = this._getActiveEditorContext();
        const enrichedPrompt = [editorContext, prompt + imageNote].filter(Boolean).join('\n\n');

        const turnState = await this._taskStateManager.startTurn({
            taskId: this._currentTaskId,
            prompt,
            selectedAgentIds,
            executorId,
        });
        this._currentTaskId = turnState.taskState.taskId;

        if (this._runningTaskIds.has(this._currentTaskId)) {
            await this._taskStateManager.failTurn(this._currentTaskId, turnState.turnRecord.turnId, 'Blocked: another turn is already running for this task.');
            this._view.webview.postMessage({ type: 'agentDone', agent: 'System', text: 'A turn is already running for this task. Please wait for it to finish.', status: 'error', raw: true });
            return;
        }
        this._runningTaskIds.add(this._currentTaskId);
        this._activeTurnRef = {
            taskId: turnState.taskState.taskId,
            turnId: turnState.turnRecord.turnId,
        };
        this._activeStopReason = undefined;

        this._createSessionRecord(prompt, turnState.taskState.taskId, turnState.turnRecord.turnId, storedAttachments);

        const allAdapters = getActiveAdapters();
        debugLog('Council', 'Delegation started', JSON.stringify({
            taskId: turnState.taskState.taskId,
            turnId: turnState.turnRecord.turnId,
            turnSequence: turnState.turnRecord.sequence,
            promptLength: enrichedPrompt.length,
            hasEditorContext: !!editorContext,
            selectedAgentIds,
            mode,
            executorId,
            allAdapters: allAdapters.map(a => ({ id: a.id, name: a.name, modes: a.modes }))
        }));
        this._sendCurrentTaskState();

        // === AUTO MODE: Two-phase Council → Executor pipeline ===
        // Phase 1: Run selected plan agents concurrently in 'plan' mode
        let planAdapters = allAdapters.filter(a =>
            selectedAgentIds.includes(a.id) && a.modes.includes('plan')
        );

        const droppedPlannerSelections = selectedAgentIds
            .filter(id => !planAdapters.some(adapter => adapter.id === id))
            .map(id => {
                const adapter = allAdapters.find(candidate => candidate.id === id);
                if (!adapter) {
                    return { id, name: id, reason: 'not available in the active agent configuration' };
                }
                if (!adapter.modes.includes('plan')) {
                    return { id, name: adapter.name, reason: 'does not support plan mode' };
                }
                return { id, name: adapter.name, reason: 'is not currently available' };
            });

        // Phase 2 executor: find the designated executor agent
        let executor = executorId ? allAdapters.find(a => a.id === executorId && a.modes.includes('agent')) : null;
        if (!executor) {
            executor = allAdapters.find(a => a.modes.includes('agent'));
        }

        debugLog('Council', 'Resolved council participants', JSON.stringify({
            planners: planAdapters.map(a => ({ id: a.id, name: a.name })),
            executor: executor ? { id: executor.id, name: executor.name } : null,
            droppedPlannerSelections
        }));

        if (droppedPlannerSelections.length > 0) {
            const droppedSummary = droppedPlannerSelections
                .map(item => `${item.name} (${item.reason})`)
                .join(', ');
            const droppedMessage = `Ignored selected non-planner agents: ${droppedSummary}.`;
            vscode.window.showInformationMessage('[Optimus Code] ' + droppedMessage);
            this._view.webview.postMessage({
                type: 'agentDone',
                agent: 'System',
                text: droppedMessage,
                status: 'error',
                raw: true,
            });
        }

        if (planAdapters.length === 0) {
            vscode.window.showWarningMessage('[Optimus Code] No plan agents selected.');
            debugLog('Council', 'Aborted because no plan agents were selected');
            return;
        }

        this._activeRunAdapters = [...planAdapters, ...(executor ? [executor] : [])];

        const sessionResponses: SessionResponseRecord[] = [];
        const plannerContributions: ContributionRecord[] = [];

        // Build the planner prompt with lightweight task history context
        const plannerPrompt = this._taskStateManager.buildPlannerPrompt(
            turnState.taskState,
            turnState.turnRecord,
            enrichedPrompt
        );

        // --- Phase 1: Council Planning ---
        this._postPhaseStart(
            'planner',
            planAdapters.map(a => ({ id: a.id, name: a.name, role: 'planner' })),
            plannerPrompt,
            true
        );
        this._initializeSessionResponses(
            turnState.turnRecord.turnId,
            planAdapters.map(adapter => ({
                name: adapter.name,
                agentId: adapter.id,
                role: 'planner' as const,
                prompt: plannerPrompt,
            }))
        );

        try {
            const planResults: {agentId: string, agent: string, text: string, status: 'success' | 'error'}[] = [];

            const promises = planAdapters.map(adapter => {
                const { callback, flush } = this._makeStreamingCallback(adapter.name, adapter, {
                    turnId: turnState.turnRecord.turnId,
                    agentId: adapter.id,
                    role: 'planner',
                    prompt: plannerPrompt,
                });
                return adapter.invoke(plannerPrompt, 'plan', callback)
                .then(async res => {
                    flush();
                    debugLog(adapter.id, 'Raw result length + preview', JSON.stringify({ len: res.length, preview: res.slice(0, 500) }));
                    const { thinking, output, usageLog } = this._extractThinking(res, adapter);
                    planResults.push({ agentId: adapter.id, agent: adapter.name, text: output, status: 'success' });
                    const plannerSuccessRecord = { agent: adapter.name, agentId: adapter.id, role: 'planner' as const, prompt: plannerPrompt, thinking: thinking, text: output, usageLog: usageLog, status: 'success' as const, raw: false, debug: adapter.lastDebugInfo };
                    sessionResponses.push(plannerSuccessRecord);
                    this._upsertSessionResponse(turnState.turnRecord.turnId, plannerSuccessRecord);
                    plannerContributions.push(this._buildContributionRecord(adapter, 'planner', res, 'success'));
                    const htmlContent = await marked.parse(output);
                    const thinkingHtml = thinking ? await marked.parse(thinking) : undefined;
                    this._view?.webview.postMessage({ type: 'agentDone', agent: adapter.name, agentId: adapter.id, role: 'planner', prompt: plannerPrompt, thinkingHtml: thinkingHtml, thinking: thinking, text: htmlContent, rawText: output, usageLog: usageLog, debug: adapter.lastDebugInfo, status: 'success', raw: false });
                    this._sendDebugInfo(adapter, '', {
                        taskId: turnState.taskState.taskId,
                        turnId: turnState.turnRecord.turnId,
                        role: 'planner',
                    });
                })
                .catch(err => {
                    flush();
                    planResults.push({ agentId: adapter.id, agent: adapter.name, text: err.message, status: 'error' });
                    const plannerErrorRecord = { agent: adapter.name, agentId: adapter.id, role: 'planner' as const, prompt: plannerPrompt, text: err.message, status: 'error' as const, raw: true, debug: adapter.lastDebugInfo };
                    sessionResponses.push(plannerErrorRecord);
                    this._upsertSessionResponse(turnState.turnRecord.turnId, plannerErrorRecord);
                    plannerContributions.push(this._buildContributionRecord(adapter, 'planner', err.message, 'error'));
                    this._view?.webview.postMessage({ type: 'agentDone', agent: adapter.name, agentId: adapter.id, role: 'planner', prompt: plannerPrompt, text: err.message, debug: adapter.lastDebugInfo, status: 'error', raw: true });
                    this._sendDebugInfo(adapter, '', {
                        taskId: turnState.taskState.taskId,
                        turnId: turnState.turnRecord.turnId,
                        role: 'planner',
                    });
                });
            });

            await Promise.all(promises);
            this._view.webview.postMessage({ type: 'councilComplete' });
            debugLog('Council', 'Planning phase completed', JSON.stringify(planResults));

            // --- Phase 2: Executor synthesizes and acts ---
            let executorOutcome: ExecutorOutcomeRecord | undefined;
            let synthesisPrompt: string | undefined;
            if (executor) {
                const successfulPlans = planResults.filter(r => r.status === 'success');
                if (successfulPlans.length > 0) {
                    const synthesis = successfulPlans.map(r =>
                        `=== ${r.agent} ===\n${r.text}`
                    ).join('\n\n');

                    const executorPrompt = this._taskStateManager.buildExecutorPrompt(
                        turnState.taskState,
                        turnState.turnRecord,
                        prompt,
                        synthesis
                    );
                    synthesisPrompt = executorPrompt;

                    // Show executor in UI
                    this._postPhaseStart(
                        'executor',
                        [{ id: executor.id, name: executor.name, role: 'executor' }],
                        executorPrompt
                    );
                    this._initializeSessionResponses(turnState.turnRecord.turnId, [{
                        name: executor.name,
                        agentId: executor.id,
                        role: 'executor',
                        prompt: executorPrompt,
                    }]);

                    const execName = executor.name;
                    const { callback: execCallback, flush: execFlush } = this._makeStreamingCallback(execName, executor, {
                        turnId: turnState.turnRecord.turnId,
                        agentId: executor.id,
                        role: 'executor',
                        prompt: executorPrompt,
                    });
                    debugLog('Council', 'Executor phase starting', JSON.stringify({ executor: executor.name, promptLength: executorPrompt.length }));

                    try {
                        const execResultRaw = await executor.invoke(executorPrompt, 'agent', execCallback);
                        execFlush();
                        
                        // Extract <task-summary> from executor output before further parsing
                        const { summary: extractedSummary, cleaned: execCleaned } = this._extractTaskSummary(execResultRaw);

                        const { thinking, output, usageLog } = this._extractThinking(execCleaned, executor);

                        const executorSuccessRecord = { agent: executor.name, agentId: executor.id, role: 'executor' as const, prompt: executorPrompt, thinking: thinking, text: output, usageLog: usageLog, status: 'success' as const, raw: false, debug: executor.lastDebugInfo };
                        sessionResponses.push(executorSuccessRecord);
                        this._upsertSessionResponse(turnState.turnRecord.turnId, executorSuccessRecord);
                        executorOutcome = this._buildExecutorOutcomeRecord(executor, execCleaned, 'success');

                        if (extractedSummary) {
                            this._taskStateManager.updateTaskSummary(turnState.taskState.taskId, extractedSummary).catch(err => {
                                debugLog('Council', 'Failed to save extracted task summary', String(err));
                            });
                        }
                        const htmlContent = await marked.parse(output);
                        const thinkingHtml = thinking ? await marked.parse(thinking) : undefined;
                        this._view?.webview.postMessage({ type: 'agentDone', agent: execName, agentId: executor.id, role: 'executor', prompt: executorPrompt, thinkingHtml: thinkingHtml, thinking: thinking, text: htmlContent, rawText: output, usageLog: usageLog, debug: executor.lastDebugInfo, status: 'success', raw: false });
                        this._sendDebugInfo(executor, '', {
                            taskId: turnState.taskState.taskId,
                            turnId: turnState.turnRecord.turnId,
                            role: 'executor',
                        });
                    } catch (err: any) {
                        execFlush();
                        const executorErrorRecord = { agent: executor.name, agentId: executor.id, role: 'executor' as const, prompt: executorPrompt, text: err.message, status: 'error' as const, raw: true, debug: executor.lastDebugInfo };
                        sessionResponses.push(executorErrorRecord);
                        this._upsertSessionResponse(turnState.turnRecord.turnId, executorErrorRecord);
                        executorOutcome = this._buildExecutorOutcomeRecord(executor, err.message, 'error');
                        this._view?.webview.postMessage({ type: 'agentDone', agent: execName, agentId: executor.id, role: 'executor', prompt: executorPrompt, text: err.message, debug: executor.lastDebugInfo, status: 'error', raw: true });
                        this._sendDebugInfo(executor, '', {
                            taskId: turnState.taskState.taskId,
                            turnId: turnState.turnRecord.turnId,
                            role: 'executor',
                        });
                    }

                    this._view.webview.postMessage({ type: 'councilComplete' });
                    debugLog('Council', 'Executor phase completed');
                }
            }

            const updatedTaskState = await this._taskStateManager.completeTurn(turnState.taskState.taskId, turnState.turnRecord.turnId, {
                plannerContributions,
                executorOutcome,
                synthesisPrompt,
            });
            debugLog('Council', 'Task state updated after turn', JSON.stringify({
                taskId: turnState.taskState.taskId,
                turnId: turnState.turnRecord.turnId,
                latestSummary: updatedTaskState?.latestSummary,
                turnCount: updatedTaskState?.turnHistory.length,
            }));

            this._updateSessionRecord(turnState.turnRecord.turnId, sessionResponses);
            this._sendCurrentTaskState();

            // Auto-compact if context exceeds threshold
            if (updatedTaskState && this._taskStateManager.needsCompaction(updatedTaskState)) {
                const tokensBefore = this._taskStateManager.estimateContextTokens(updatedTaskState);
                debugLog('Council', 'Context exceeds threshold, auto-compacting', JSON.stringify({
                    taskId: updatedTaskState.taskId,
                    tokensBefore,
                }));
                const compacted = await this._taskStateManager.compactContext(updatedTaskState.taskId);
                if (compacted) {
                    const tokensAfter = this._taskStateManager.estimateContextTokens(compacted);
                    this._sendCurrentTaskState();
                    this._view?.webview.postMessage({
                        type: 'compactResult',
                        trigger: 'auto',
                        tokensBefore,
                        tokensAfter,
                        tokensFreed: tokensBefore - tokensAfter,
                    });
                }
            }
        } catch (error: any) {
            const failureReason = this._activeTurnRef?.turnId === turnState.turnRecord.turnId && this._activeStopReason
                ? this._activeStopReason
                : error.message;
            await this._taskStateManager.failTurn(turnState.taskState.taskId, turnState.turnRecord.turnId, failureReason);
            debugLog('Council', 'Delegation failed', error?.stack || String(error));
            this._view.webview.postMessage({ type: 'agentDone', agent: 'System', text: failureReason, status: 'error', raw: true });
            this._view.webview.postMessage({ type: 'councilComplete' });
            this._sendCurrentTaskState();
        } finally {
            this._runningTaskIds.delete(turnState.taskState.taskId);
            this._activeTurnRef = undefined;
            this._activeStopReason = undefined;
            this._activeRunAdapters = [];
        }
    }

    private _extractTaskSummary(rawText: string): { summary: string; cleaned: string } {
        const regex = /<task-summary>([\s\S]*?)<\/task-summary>/i;
        const match = regex.exec(rawText);
        if (!match) {
            return { summary: '', cleaned: rawText };
        }
        const summary = match[1].trim();
        const cleaned = rawText.replace(match[0], '').trim();
        debugLog('ExtractTaskSummary', 'Extracted summary', JSON.stringify({ length: summary.length, preview: summary.slice(0, 100) }));
        return { summary, cleaned };
    }

    private _extractThinking(rawText: string, adapter?: AgentAdapter): { thinking: string; output: string; usageLog?: string } {
        if (!rawText) return { thinking: '', output: '' };
        debugLog('ExtractThinking', 'Input first 200 chars', JSON.stringify(rawText.slice(0, 200)));

        // Delegate to adapter-specific parser when available
        if (adapter?.extractThinking) {
            const result = adapter.extractThinking(rawText);
            if (!result.usageLog && adapter.lastUsageLog) {
                result.usageLog = adapter.lastUsageLog;
            }
            debugLog('ExtractThinking', 'Delegated to adapter', JSON.stringify({ adapter: adapter.id, thinkingLen: result.thinking.length, outputLen: result.output.length }));
            return result;
        }

        const regex = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
        let thinkingBlocks: string[] = [];
        let output = rawText;
        let match;
        while ((match = regex.exec(rawText)) !== null) {
            thinkingBlocks.push(match[2].trim());
            output = output.replace(match[0], '');
        }

        // Extract tool chain execution lines common in Copilot and Claude CLI outputs.
        // Full-scan mode: tool chain lines can appear anywhere, not just as a leading prefix.
        const PROCESS_LINE_RE = /^[•●⏺▶→└│├✓✗↳]|^>\s*\[/;
        const lines = output.split(/\r?\n|\r/);
        const processLines: string[] = [];
        const outputLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const cleanLine = line.replace(ANSI_RE, '');
            const trimmed = cleanLine.trim();
            if (PROCESS_LINE_RE.test(trimmed)) {
                processLines.push(line);
            } else {
                outputLines.push(line);
            }
        }

        // Clean up trailing empty lines from processLines
        while (processLines.length > 0 && processLines[processLines.length - 1].trim() === '') {
            const emptyLine = processLines.pop() as string;
            outputLines.unshift(emptyLine);
        }

        const additionalProcessInfo = processLines.join('\n').trim();
        if (additionalProcessInfo) {
            thinkingBlocks.push('```text\n' + additionalProcessInfo + '\n```');
        }

        const result = {
            thinking: thinkingBlocks.length > 0 ? thinkingBlocks.join('\n\n---\n\n') : '',
            output: outputLines.join('\n').trim()
        };
        debugLog('ExtractThinking', 'Result', JSON.stringify({ thinkingLen: result.thinking.length, outputLen: result.output.length, processLineCount: processLines.length }));
        return result;
    }

    private _buildDebugObject(adapter: AgentAdapter) {
        const d = adapter.lastDebugInfo;
        if (!d) { return undefined; }
        return {
            command: d.command,
            cwd: d.cwd,
            pid: d.pid,
            duration: d.endTime && d.startTime ? d.endTime - d.startTime : undefined,
            promptTransport: d.promptTransport,
            promptFilePath: d.promptFilePath,
            originalPromptLength: d.originalPromptLength,
            sentPromptLength: d.sentPromptLength,
            promptFileThreshold: d.promptFileThreshold,
        };
    }

    private _buildContributionRecord(
        adapter: AgentAdapter,
        role: 'planner' | 'executor',
        text: string,
        status: 'success' | 'error'
    ): ContributionRecord {
        const normalizedText = text.trim();
        return {
            agentId: adapter.id,
            agentName: adapter.name,
            role,
            status,
            summary: this._summarizeText(normalizedText),
            rawText: normalizedText,
            filesTouched: [],
            commandsObserved: adapter.lastDebugInfo?.command ? [adapter.lastDebugInfo.command] : [],
            openQuestions: this._extractOpenQuestions(normalizedText),
            nextStepSuggestion: status === 'success' ? this._extractNextStepSuggestion(normalizedText) : undefined,
            timestamp: Date.now(),
            debug: this._buildDebugObject(adapter),
        };
    }

    private _buildExecutorOutcomeRecord(
        adapter: AgentAdapter,
        text: string,
        status: 'success' | 'error'
    ): ExecutorOutcomeRecord {
        const normalizedText = text.trim();
        return {
            agentId: adapter.id,
            agentName: adapter.name,
            status,
            summary: this._summarizeText(normalizedText),
            rawText: normalizedText,
            timestamp: Date.now(),
            debug: this._buildDebugObject(adapter),
        };
    }

    private _summarizeText(text: string): string {
        const singleLine = text.replace(/\s+/g, ' ').trim();
        if (singleLine.length <= 220) {
            return singleLine;
        }

        return singleLine.slice(0, 217) + '...';
    }

    private _extractOpenQuestions(text: string): string[] {
        const matches = text.match(/[^.!?\n]*\?/g) || [];
        return matches.map(match => match.trim()).filter(Boolean).slice(0, 3);
    }

    private _extractNextStepSuggestion(text: string): string | undefined {
        const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim();
        return firstSentence || undefined;
    }

    private _sendDebugInfo(
        adapter: AgentAdapter,
        nameSuffix: string = '',
        taskContext?: { taskId?: string; turnId?: string; role?: string }
    ) {
        if (adapter.lastDebugInfo) {
            const debugObj = this._buildDebugObject(adapter)!;
            debugLog('Adapter', 'Sending adapter debug info to webview', JSON.stringify({
                agent: adapter.name + nameSuffix,
                taskId: taskContext?.taskId,
                turnId: taskContext?.turnId,
                role: taskContext?.role,
                ...debugObj,
            }));
            this._view?.webview.postMessage({
                type: 'agentDebug',
                agent: adapter.name + nameSuffix,
                role: taskContext?.role,
                ...debugObj,
            });
        }
    }

    private _stopActiveCouncil() {
        if (this._activeTurnRef) {
            this._activeStopReason = 'Stopped by user: council execution was manually stopped.';
        }
        for (const adapter of this._activeRunAdapters) {
            adapter.stop?.();
        }

        this._activeRunAdapters = [];
        this._view?.webview.postMessage({ type: 'councilComplete' });
    }

    private async _applyCodeBlock(filePath: string, code: string) {
        if (!filePath || !code) { return; }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('[Optimus Code] No workspace folder open — cannot apply code.');
            return;
        }

        // Validate path is relative and stays within the workspace (prevent directory traversal)
        const normalized = path.posix.normalize(filePath);
        if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
            vscode.window.showErrorMessage(`[Optimus Code] Unsafe file path rejected: ${filePath}`);
            return;
        }

        const fileUri = vscode.Uri.joinPath(workspaceRoot, normalized);
        const edit = new vscode.WorkspaceEdit();

        try {
            // Try to open existing document to replace its full content
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const fullRange = new vscode.Range(
                doc.lineAt(0).range.start,
                doc.lineAt(doc.lineCount - 1).range.end
            );
            edit.replace(fileUri, fullRange, code);
        } catch {
            // File does not exist — create it
            edit.createFile(fileUri, { ignoreIfExists: false });
            edit.insert(fileUri, new vscode.Position(0, 0), code);
        }

        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            vscode.window.showTextDocument(fileUri, { preview: false });
            this._view?.webview.postMessage({ type: 'codeBlockApplied', filePath });
        } else {
            vscode.window.showErrorMessage(`[Optimus Code] Failed to apply code to ${filePath}`);
        }
    }

    private _createSessionRecord(prompt: string, taskId: string, turnId: string, attachments: SessionImageAttachment[] = []) {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        sessions.unshift({
            id: turnId,
            timestamp: Date.now(),
            prompt,
            taskId,
            turnId,
            attachments,
            responses: [],
        });
        const limited = sessions.slice(0, 50);
        this._context.globalState.update('optimusSessions', limited);
        this._sendSessionsToUI();
    }

    private _updateSessionRecord(turnId: string, responses: SessionResponseRecord[]) {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const idx = sessions.findIndex(s => s.turnId === turnId);
        if (idx !== -1) {
            sessions[idx] = { ...sessions[idx], responses: responses.map(response => ({ ...response })) };
        }
        this._context.globalState.update('optimusSessions', sessions);
        this._sendSessionsToUI();
    }

    private _sendSessionsToUI() {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const snapshots = this._taskStateManager.listTaskSnapshots();
        const snapshotMap = new Map(snapshots.map(snapshot => [snapshot.taskId, snapshot]));
        
        // Deduplicate sessions so that we only show ONE entry per Task in the history list.
        const seenTaskIds = new Set<string>();
        const uniqueSessions = [];

        for (const s of sessions) {
            if (s.taskId) {
                if (seenTaskIds.has(s.taskId)) {
                    continue; // Skip older turns of the same task
                }
                seenTaskIds.add(s.taskId);
            }
            uniqueSessions.push(s);
        }

        const lightweightSessions = uniqueSessions.map(s => {
            const snapshot = s.taskId ? snapshotMap.get(s.taskId) : undefined;
            return {
                id: s.id,
                prompt: s.prompt,
                timestamp: s.timestamp,
                taskId: s.taskId,
                turnId: s.turnId,
                taskTitle: snapshot?.title,
                taskStatus: snapshot?.status,
                turnCount: snapshot?.turnCount,
                latestSummary: snapshot?.latestSummary,
                pinned: snapshot?.pinned,
                attachmentCount: Array.isArray(s.attachments) ? s.attachments.length : 0,
            };
        });
        this._view?.webview.postMessage({ type: 'updateSessionsList', sessions: lightweightSessions });
    }

    private async _loadSessionToUI(id: string) {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const targetSession = sessions.find(s => s.id === id);
        
        if (!targetSession) return;

        // If part of a task, retrieve the most recent turns (cap at 20 to avoid bloating the webview)
        const MAX_TURNS_IN_VIEW = 20;
        const isTaskGroup = !!targetSession.taskId;
        const taskState = targetSession.taskId ? this._taskStateManager.getTask(targetSession.taskId) : undefined;
        const groupSessions = isTaskGroup
            ? sessions
                .filter(s => s.taskId === targetSession.taskId)
                .sort((a, b) => a.timestamp - b.timestamp)
                .slice(-MAX_TURNS_IN_VIEW)
            : [targetSession];

        debugLog('History', 'Viewing session(s) snapshot', JSON.stringify({
            count: groupSessions.length,
            taskId: targetSession.taskId
        }));

        const parsedGroupSessions = [];
        for (const session of groupSessions) {
            const parsedResponses = await Promise.all(session.responses.map(async (r: SessionResponseRecord) => {
                const responseText = r.text || '';
                const responseThinking = r.thinking || '';
                const text = (r.status === 'success' && !r.raw) ? await marked.parse(responseText) : responseText;
                const thinkingText = responseThinking ? await marked.parse(responseThinking) : undefined;
                return { ...r, parsedText: text, thinkingHtml: thinkingText, usageLog: r.usageLog };
            }));
            const matchedTurn = taskState?.turnHistory.find(turn => turn.turnId === session.turnId);
            parsedGroupSessions.push({
                ...session,
                failureReason: matchedTurn?.failureReason || session.failureReason,
                attachments: (session.attachments || [])
                    .map(attachment => this._toWebviewAttachment(attachment))
                    .filter((attachment): attachment is SessionImageAttachment => Boolean(attachment)),
                responses: parsedResponses,
            });
        }

        this._view?.webview.postMessage({ type: 'restoreTaskSessions', sessions: parsedGroupSessions });
    }

    private async _resumeTask(taskId?: string, sessionId?: string) {
        if (!taskId) {
            return;
        }

        this._currentTaskId = taskId;
        this._sendCurrentTaskState();

        debugLog('History', 'Resuming task from history', JSON.stringify({ taskId, sessionId }));

        if (sessionId) {
            await this._loadSessionToUI(sessionId);
            return;
        }

        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const latestSession = sessions.find(session => session.taskId === taskId);
        if (latestSession) {
            await this._loadSessionToUI(latestSession.id);
        }
    }

    private async _renameTask(taskId: string, newTitle: string) {
        await this._taskStateManager.renameTask(taskId, newTitle);
        this._sendSessionsToUI();
    }

    private async _deleteTask(taskId: string, sessionId?: string) {
        await this._taskStateManager.deleteTask(taskId);
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const updated = sessions.filter(s => {
            if (sessionId && s.id === sessionId) { return false; }
            if (taskId && s.taskId === taskId) { return false; }
            return true;
        });
        await this._context.globalState.update('optimusSessions', updated);
        if (this._currentTaskId === taskId) {
            this._currentTaskId = undefined;
        }
        this._sendSessionsToUI();
    }

    private async _pinTask(taskId: string) {
        await this._taskStateManager.pinTask(taskId);
        this._sendSessionsToUI();
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.js'));
        const webviewScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'chatView.js'));
        const adapters = getActiveAdapters();
        const maxAgents = 3;
        const plannerAdapters = adapters.filter(adapter => adapter.modes.includes('plan'));
        const initialAgentSelectorHtml = plannerAdapters.map((adapter, index) => {
            const checkedAttr = index < maxAgents ? ' checked' : '';
            return '<label class="agent-pill">'
                + '<input type="checkbox" class="agent-checkbox" value="' + adapter.id + '"' + checkedAttr + '>'
                + '<span>' + adapter.name + '</span>'
                + '</label>';
        }).join('');
        const initialExecutorOptionsHtml = adapters
            .filter(adapter => adapter.modes.includes('agent'))
            .map(adapter => '<option value="' + adapter.id + '">' + adapter.name + '</option>')
            .join('');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script type="module" src="${toolkitUri}"></script>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 10px;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    box-sizing: border-box;
                    overflow: hidden;
                }
                .chat-history {
                    flex-grow: 1;
                    overflow-y: scroll;
                    overflow-x: hidden;
                    min-height: 0;
                    margin-bottom: 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                    width: 100%;
                    box-sizing: border-box;
                    align-content: flex-start;
                }
                .chat-history > * {
                    flex-shrink: 0;
                }
                .chat-history::-webkit-scrollbar {
                    width: 8px;
                }
                .chat-history::-webkit-scrollbar-track {
                    background: transparent;
                }
                .chat-history::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 4px;
                }
                .chat-history::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }
                .message {
                    padding: 10px;
                    border-radius: 6px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    font-size: 13px;
                    line-height: 1.5;
                }
                .message.user {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    align-self: flex-end;
                    max-width: 85%;
                }
                .message.user > div + .restored-image-strip,
                .message.user > .restored-image-strip {
                    margin-top: 8px;
                }
                .message.agent {
                    border-left: 3px solid var(--vscode-textLink-foreground);
                    background: var(--vscode-editor-background);
                    width: 100%;
                    box-sizing: border-box;
                    overflow: hidden;
                }
                .agent-name {
                    font-weight: 600;
                    margin-bottom: 8px;
                    color: var(--vscode-textLink-foreground);
                }
                .input-area {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    padding-top: 10px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                #prompt-input {
                    width: 100%;
                    box-sizing: border-box;
                    resize: vertical;
                    min-height: 84px;
                    max-height: 240px;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    line-height: 1.5;
                }
                #prompt-input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: 0;
                }
                #image-preview-bar {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                #image-preview-bar:empty {
                    display: none;
                }
                .image-preview-item {
                    position: relative;
                    display: inline-flex;
                }
                .image-preview-item img {
                    max-height: 80px;
                    max-width: 120px;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-panel-border);
                    object-fit: cover;
                }
                .image-preview-remove {
                    position: absolute;
                    top: -6px;
                    right: -6px;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    background: var(--vscode-errorForeground);
                    color: white;
                    font-size: 10px;
                    line-height: 16px;
                    text-align: center;
                    cursor: pointer;
                    border: none;
                    padding: 0;
                }
                .chat-image {
                    max-width: 240px;
                    max-height: 180px;
                    border-radius: 6px;
                    margin-top: 4px;
                    display: block;
                }
                .restored-image-strip {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }
                .history-loading-card {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 14px 16px;
                    border-radius: 8px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .history-loading-card-chat {
                    margin-top: 8px;
                }
                .history-loading-spinner {
                    width: 14px;
                    height: 14px;
                    border-radius: 999px;
                    border: 2px solid color-mix(in srgb, var(--vscode-textLink-foreground) 28%, transparent 72%);
                    border-top-color: var(--vscode-textLink-foreground);
                    animation: spin 0.9s linear infinite;
                    flex-shrink: 0;
                }
                pre {
                    white-space: pre-wrap;
                    font-family: var(--vscode-editor-font-family);
                    margin: 0;
                    padding: 10px;
                    background: var(--vscode-textCodeBlock-background);
                    border-radius: 4px;
                }
                
                /* New UX styles for tasks */
                .error-text {
                    color: var(--vscode-errorForeground);
                    border: 1px solid var(--vscode-errorForeground);
                    padding: 8px;
                    border-radius: 4px;
                }
                .markdown-body {
                    user-select: text;
                    word-wrap: break-word;
                    font-size: 13px;
                }
                .markdown-body pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 8px;
                    border-radius: 4px;
                    overflow-x: auto;
                }
                .markdown-body code {
                    font-family: var(--vscode-editor-font-family);
                    color: var(--vscode-textPreformat-foreground);
                }
                .apply-btn {
                    display: block;
                    margin-bottom: 4px;
                    padding: 3px 10px;
                    font-size: 11px;
                    cursor: pointer;
                    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
                    border-radius: 4px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .apply-btn:hover:not(:disabled) {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                .apply-btn-done {
                    opacity: 0.6;
                    cursor: default;
                }
                /* Blinking animation for thinking */
                @keyframes blink {
                    0% { opacity: .2; }
                    20% { opacity: 1; }
                    100% { opacity: .2; }
                }
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .thinking .task-icon {
                    animation: blink 1.4s infinite both;
                }
                .chat-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 10px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .sessions-panel {
                    flex-grow: 1;
                    flex-direction: column;
                    gap: 8px;
                    overflow-y: auto;
                    min-height: 0;
                    margin-bottom: 10px;
                    padding: 10px;
                }
                .session-item {
                    cursor: pointer;
                    padding: 12px;
                    border-radius: 4px;
                    font-size: 13px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    margin-bottom: 8px;
                }
                .session-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .session-pinned {
                    border-color: var(--vscode-focusBorder);
                }
                .session-title-row {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    overflow: hidden;
                }
                .session-title-text {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    flex: 1;
                }
                .session-pin-indicator {
                    flex-shrink: 0;
                    font-size: 11px;
                }
                .task-status-badge {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-width: 64px;
                    padding: 2px 8px;
                    border-radius: 999px;
                    font-size: 11px;
                    font-weight: 600;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-button-secondaryBackground);
                }
                .task-status-badge.active {
                    color: var(--vscode-terminal-ansiGreen);
                }
                .task-status-badge.blocked {
                    color: var(--vscode-errorForeground);
                }
                .task-status-badge.completed {
                    color: var(--vscode-terminal-ansiBlue);
                }
                .session-meta {
                    margin-top: 6px;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    white-space: normal;
                }
                
                /* New UX styles for tool calls */
                .council-details {
                    margin: 5px 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                .council-summary {
                    padding: 8px 12px;
                    cursor: pointer;
                    font-weight: bold;
                    user-select: none;
                    outline: none;
                }
                .council-summary:hover {
                    background: var(--vscode-list-hoverBackground);
                }

                /* Sticky headers: pin summaries when content overflows viewport */
                details[open] > .council-summary {
                    position: sticky;
                    top: 0;
                    z-index: 30;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .agent-row[open] > .task-item {
                    position: sticky;
                    top: 36px;
                    z-index: 20;
                    background: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .agent-child-stack > details[open] > summary {
                    position: sticky;
                    top: 72px;
                    z-index: 10;
                    background: var(--vscode-editor-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding: 4px 8px;
                }

                /* Floating collapse bar for off-screen expanded sections */
                #floating-collapse-bar {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    z-index: 200;
                    display: flex;
                    gap: 4px;
                    padding: 4px 8px;
                    background: var(--vscode-editorWidget-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                    flex-wrap: wrap;
                }
                .floating-collapse-btn {
                    padding: 2px 10px;
                    border-radius: 999px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-panel-border);
                    font-size: 11px;
                    cursor: pointer;
                    max-width: 220px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .floating-collapse-btn:hover {
                    background: var(--vscode-button-hoverBackground);
                    color: var(--vscode-button-foreground);
                }

                .council-container {
                    display: flex;
                    flex-direction: column;
                    gap: 0px;
                    border-top: 1px solid var(--vscode-panel-border);
                    border-left: 2px solid var(--vscode-list-hoverBackground);
                    margin-left: 6px;
                }
                .agent-row {
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .agent-row:last-child {
                    border-bottom: none;
                }
                .agent-row .task-item {
                    padding: 8px 12px;
                    background: var(--vscode-sideBar-background);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 12px;
                }
                .restored-agent-status {
                    margin-left: auto;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 2px 8px;
                    border-radius: 999px;
                    border: 1px solid var(--vscode-panel-border);
                    font-size: 10px;
                    font-weight: 700;
                    letter-spacing: 0.03em;
                    text-transform: uppercase;
                    white-space: nowrap;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .restored-agent-status-running {
                    background: color-mix(in srgb, var(--vscode-editor-background) 66%, var(--vscode-editorWarning-foreground) 34%);
                    color: var(--vscode-editorWarning-foreground);
                }
                .restored-agent-status-error {
                    background: color-mix(in srgb, var(--vscode-editor-background) 66%, var(--vscode-errorForeground) 34%);
                    color: var(--vscode-errorForeground);
                }
                .restored-agent-status-success {
                    background: color-mix(in srgb, var(--vscode-editor-background) 66%, var(--vscode-terminal-ansiGreen) 34%);
                    color: var(--vscode-terminal-ansiGreen);
                }
                .agent-row .task-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .agent-row .agent-content {
                    padding: 12px;
                    background: var(--vscode-editor-background);
                    border-top: 1px dashed var(--vscode-panel-border);
                    font-size: 13px;
                    line-height: 1.5;
                    overflow-x: auto;
                    max-width: 100%;
                    box-sizing: border-box;
                }
                .agent-child-stack {
                    margin-left: 18px;
                    padding-left: 12px;
                    border-left: 2px solid var(--vscode-panel-border);
                }
                .agent-child-stack > details,
                .agent-child-stack > div {
                    margin-top: 2px;
                }
                .restored-agent-note {
                    margin-bottom: 8px;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground) 55%, var(--vscode-panel-border) 45%);
                    background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-editorWarning-foreground) 18%);
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                    line-height: 1.45;
                }
                .process-timeline {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .process-step {
                    display: grid;
                    grid-template-columns: 24px 1fr;
                    gap: 10px;
                    align-items: start;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: 1px solid var(--vscode-panel-border);
                    background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-list-hoverBackground) 14%);
                }
                .process-step-log {
                    background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-inputValidation-warningBackground) 18%);
                }
                .process-step-index {
                    width: 24px;
                    height: 24px;
                    border-radius: 999px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 14px;
                    line-height: 1;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-panel-border);
                }
                .process-step-body {
                    min-width: 0;
                }
                .process-step-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                }
                .process-step-title {
                    font-size: 12px;
                    font-weight: 700;
                    color: var(--vscode-foreground);
                    word-break: break-word;
                }
                .process-step-status {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 2px 8px;
                    border-radius: 999px;
                    border: 1px solid var(--vscode-panel-border);
                    font-size: 10px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    white-space: nowrap;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .process-step-status-success {
                    color: var(--vscode-terminal-ansiGreen);
                }
                .process-step-status-error {
                    color: var(--vscode-errorForeground);
                }
                .process-step-status-running {
                    color: var(--vscode-editorWarning-foreground);
                }
                .process-step-badges {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-top: 6px;
                }
                .process-step-badge {
                    display: inline-flex;
                    align-items: center;
                    max-width: 100%;
                    padding: 3px 8px;
                    border-radius: 999px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    font-size: 11px;
                    line-height: 1.35;
                    font-family: var(--vscode-editor-font-family);
                    word-break: break-word;
                }
                .process-step-badge-path {
                    background: color-mix(in srgb, var(--vscode-editor-background) 68%, var(--vscode-textLink-foreground) 32%);
                    color: var(--vscode-foreground);
                }
                .process-step-badge-count {
                    background: color-mix(in srgb, var(--vscode-editor-background) 68%, var(--vscode-terminal-ansiGreen) 32%);
                    color: var(--vscode-foreground);
                }
                .process-step-badge-preview {
                    background: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-editorWarning-foreground) 28%);
                    color: var(--vscode-foreground);
                }
                .process-step-badge-neutral {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .process-step-meta {
                    margin-top: 4px;
                    font-size: 11px;
                    line-height: 1.45;
                    color: var(--vscode-descriptionForeground);
                    word-break: break-word;
                    font-family: var(--vscode-editor-font-family);
                }
                .process-step-meta-muted {
                    opacity: 0.8;
                    font-style: italic;
                }
                .process-step-result {
                    margin-top: 10px;
                    padding-top: 8px;
                    border-top: 1px dashed var(--vscode-panel-border);
                }
                .process-step-result-label {
                    font-size: 11px;
                    font-weight: 700;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 6px;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                }
                .process-step-result-badges {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .process-step-result-badge {
                    display: inline-flex;
                    align-items: center;
                    max-width: 100%;
                    padding: 3px 8px;
                    border-radius: 999px;
                    border: 1px solid var(--vscode-panel-border);
                    background: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-terminal-ansiGreen) 28%);
                    color: var(--vscode-foreground);
                    font-size: 11px;
                    line-height: 1.35;
                    font-family: var(--vscode-editor-font-family);
                    word-break: break-word;
                }
                .process-step-result-badge-count {
                    background: color-mix(in srgb, var(--vscode-editor-background) 62%, var(--vscode-terminal-ansiGreen) 38%);
                }
                .process-step-result-badge-path {
                    background: color-mix(in srgb, var(--vscode-editor-background) 64%, var(--vscode-textLink-foreground) 36%);
                }
                .process-step-result-badge-result-preview {
                    background: color-mix(in srgb, var(--vscode-editor-background) 62%, var(--vscode-editorWarning-foreground) 38%);
                }
                .process-step-result-badge-result-neutral {
                    background: color-mix(in srgb, var(--vscode-editor-background) 70%, var(--vscode-button-secondaryBackground) 30%);
                }
                .debug-card {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .debug-stat-badges {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .debug-stat-badge {
                    display: inline-flex;
                    align-items: center;
                    padding: 2px 8px;
                    border-radius: 999px;
                    border: 1px solid var(--vscode-panel-border);
                    font-size: 10px;
                    line-height: 1.3;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .debug-stat-badge-role {
                    color: var(--vscode-descriptionForeground);
                }
                .debug-stat-badge-transport {
                    color: var(--vscode-textLink-foreground);
                }
                .debug-stat-badge-duration {
                    color: var(--vscode-terminal-ansiGreen);
                }
                .debug-grid {
                    display: grid;
                    grid-template-columns: minmax(88px, 120px) 1fr;
                    gap: 6px 10px;
                }
                .debug-key {
                    color: var(--vscode-descriptionForeground);
                }
                .debug-value {
                    color: var(--vscode-foreground);
                    word-break: break-word;
                }
                .process-notes {
                    margin-top: 8px;
                    white-space: pre-wrap;
                    word-break: break-word;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-background);
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .process-reasoning {
                    margin-top: 8px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    background: var(--vscode-editor-background);
                }
                .process-reasoning > summary {
                    padding: 6px 10px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--vscode-descriptionForeground);
                    outline: none;
                }
                .process-reasoning > summary:hover {
                    background: var(--vscode-list-hoverBackground);
                    border-radius: 6px;
                }
                .process-reasoning-body {
                    padding: 8px 10px;
                    font-size: 11px;
                    line-height: 1.5;
                    white-space: pre-wrap;
                    word-break: break-word;
                    color: var(--vscode-descriptionForeground);
                    font-family: var(--vscode-editor-font-family);
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .process-markdown-fallback {
                    opacity: 0.9;
                    border-left: 3px solid var(--vscode-editorBracketHighlight-foreground1, #ccc);
                    padding-left: 8px;
                }
                .usage-log-card {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    padding: 10px;
                    border-radius: 6px;
                    background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-list-hoverBackground) 12%);
                    border: 1px solid var(--vscode-panel-border);
                }
                .usage-log-badges {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .usage-log-badge {
                    display: inline-flex;
                    align-items: center;
                    padding: 3px 8px;
                    border-radius: 999px;
                    font-size: 11px;
                    line-height: 1.2;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-panel-border);
                }
                .usage-log-grid {
                    display: grid;
                    grid-template-columns: minmax(120px, 160px) 1fr;
                    gap: 6px 10px;
                    font-size: 12px;
                }
                .usage-log-key {
                    color: var(--vscode-descriptionForeground);
                }
                .usage-log-value {
                    color: var(--vscode-foreground);
                    word-break: break-word;
                }
                .session-actions {
                    display: flex;
                    gap: 8px;
                    margin-top: 8px;
                }
                .session-action-button {
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border-radius: 4px;
                    padding: 4px 8px;
                    font-size: 11px;
                    cursor: pointer;
                }
                .session-action-button:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                .session-action-icon {
                    padding: 4px 6px;
                }
                .session-action-danger:hover {
                    background: var(--vscode-inputValidation-errorBackground);
                    border-color: var(--vscode-inputValidation-errorBorder);
                }
                .view {
                    display: none;
                    flex-direction: column;
                    flex: 1;
                    height: 100%;
                    min-height: 0;
                    width: 100%;
                }
                .view.active {
                    display: flex;
                }
                .agent-pill {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 6px 10px;
                    border-radius: 999px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    font-size: 12px;
                }
                .agent-pill input {
                    margin: 0;
                }
                .debug-panel {
                    display: none;
                    margin-top: 6px;
                }
                .debug-panel.visible {
                    display: block;
                }
                .debug-details {
                    display: block;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    background: var(--vscode-textCodeBlock-background);
                    padding: 6px 8px;
                }
                .debug-details summary {
                    cursor: pointer;
                    outline: none;
                    font-size: 11px;
                    font-weight: 700;
                    color: var(--vscode-descriptionForeground);
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    user-select: none;
                }
                .debug-details[open] summary {
                    margin-bottom: 8px;
                }
                .diagnostic-panel {
                    margin-top: 8px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    background: var(--vscode-editor-background);
                    padding: 8px;
                    display: none;
                    flex-direction: column;
                    gap: 6px;
                }
                .diagnostic-panel.visible {
                    display: flex;
                }
                .diagnostic-title {
                    font-size: 11px;
                    font-weight: 600;
                    color: var(--vscode-descriptionForeground);
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .diagnostic-status {
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 999px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                .diagnostic-status.pending {
                    color: var(--vscode-editorWarning-foreground);
                }
                .diagnostic-status.running {
                    color: var(--vscode-testing-iconPassed);
                }
                .diagnostic-status.failed {
                    color: var(--vscode-errorForeground);
                }
                .diagnostic-log {
                    max-height: 120px;
                    overflow-y: auto;
                    white-space: pre-wrap;
                    word-break: break-word;
                    font-size: 11px;
                    line-height: 1.4;
                    font-family: var(--vscode-editor-font-family);
                    color: var(--vscode-descriptionForeground);
                }
                .diagnostic-line {
                    padding: 2px 0;
                    border-bottom: 1px dashed var(--vscode-panel-border);
                }
                .context-badge {
                    display: none;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 8px;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    font-family: var(--vscode-editor-font-family);
                    max-width: 100%;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    margin-bottom: 4px;
                }
                .context-badge.visible {
                    display: flex;
                }
                .context-badge-icon {
                    flex-shrink: 0;
                    opacity: 0.7;
                }
                .context-badge-label {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
            </style>
        </head>
        <body data-debug-mode="${this._isDebugModeEnabled() ? 'true' : 'false'}">
            <!-- MAIN CHAT VIEW -->
            <div id="chat-view" class="view active">
                <div class="chat-header">
                    <div style="font-weight: bold; font-size: 14px;">Optimus Council</div>
                    <div style="display: flex; gap: 6px;">
                        <vscode-button appearance="secondary" aria-label="New Chat" id="new-chat-btn" title="Start a new conversation (clears current task context)">
                            New Chat
                        </vscode-button>
                        <vscode-button appearance="secondary" aria-label="Sessions History" id="toggle-sessions-btn" title="View Sessions History">
                            History
                        </vscode-button>
                    </div>
                </div>

                <div class="chat-history" id="chat-history">
                    <div class="message agent">
                        <div class="agent-name">Optimus Council</div>
                        <p>Welcome! Describe your architecture problem, and I will summon the agents concurrently.</p>
                    </div>
                </div>

                <div id="task-state-strip" class="task-state-strip" style="display:none; align-items: center; justify-content: space-between; padding: 6px 12px; flex-direction: row; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-inactiveSelectionBackground);">
                    <div class="task-state-topline" style="gap: 6px; display: flex; align-items: center;">
                        <span style="font-size: 13px;">🎯</span>
                        <strong id="task-title" style="font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 250px;">Current Task</strong>
                        <span id="task-status-badge" class="task-status-badge" style="transform: scale(0.85); margin-left: 4px;">IDLE</span>
                    </div>
                    <div id="task-turn-count" style="font-size: 11px; color: var(--vscode-descriptionForeground);"></div>
                </div>

                <div class="input-area">
                    <div id="context-badge" class="context-badge" title="Active editor context — will be injected into planner prompts">
                        <span class="context-badge-icon">[ctx]</span>
                        <span id="context-badge-label" class="context-badge-label"></span>
                    </div>
                    <textarea id="prompt-input" placeholder="E.g., How to implement RBAC in Next.js?" rows="4"></textarea>
                    <div id="image-preview-bar"></div>
                    <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: flex-start; margin-top: 8px;">
                        <div id="agent-selector" style="display: flex; flex-wrap: wrap; gap: 8px; flex-grow: 1;">
                            ${initialAgentSelectorHtml}
                        </div>
                        <vscode-button appearance="icon" aria-label="Configure Agents" id="config-btn" title="Configure Agents & Roles" style="margin-left: 4px;">
                            <span>CFG</span>
                        </vscode-button>

                        <select id="executor-selector" style="padding: 4px 6px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); font-size: 12px;" title="Executor Agent">
                            ${initialExecutorOptionsHtml}
                        </select>

                        <vscode-button appearance="secondary" id="compact-btn" title="Compact Context">Compact</vscode-button>
                        <span id="context-token-counter" style="font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; display: none;"></span>
                        <vscode-button appearance="secondary" id="stop-btn" title="Stop Council Activity" style="display:none; background: var(--vscode-errorForeground); color: white;">Stop</vscode-button>
                        <vscode-button id="ask-btn">Send</vscode-button>
                    </div>
                    <div id="diagnostic-panel" class="diagnostic-panel">
                        <div class="diagnostic-title">
                            <span>Webview Diagnostics</span>
                            <span id="diagnostic-status" class="diagnostic-status pending">PENDING</span>
                        </div>
                        <div id="diagnostic-log" class="diagnostic-log">Waiting for script boot...</div>
                    </div>
                </div>
            </div>

            <!-- SESSIONS HISTORY VIEW -->
            <div id="sessions-view" class="view">
                <div class="chat-header">
                    <vscode-button appearance="secondary" id="back-to-chat-btn" title="Back to Chat">
                        Back
                    </vscode-button>
                    <div style="font-weight: bold; font-size: 14px;">Sessions History</div>
                    <div style="width: 70px;"></div> <!-- Spacer to center the title -->
                </div>
                <div class="sessions-panel" id="sessions-panel"></div>
            </div>

            <script src="${webviewScriptUri}"></script>
        </body>
        </html>`;
    }
}
