import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getActiveAdapters } from '../adapters';
import { AgentAdapter } from '../adapters/AgentAdapter';
import { PersistentAgentAdapter } from '../adapters/PersistentAgentAdapter';
import { SharedTaskStateManager } from '../managers/SharedTaskStateManager';
import { MemoryManager } from '../managers/MemoryManager';
import { marked } from 'marked';
import { debugLog, isDebugModeEnabled } from '../debugLogger';
import { AgentMode, ContributionRecord, ExecutorOutcomeRecord, SessionImageAttachment, SessionResponseRecord, StoredSession } from '../types/SharedTaskContext';
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
    private readonly _memoryManager: MemoryManager;
    private _lastSentTurnCount = 0;
    private _showAllWorkspaces = false;
    private _cachedContextTokens?: { taskId: string; turnCount: number; tokens: number; needsCompaction: boolean };

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._taskStateManager = new SharedTaskStateManager(this._context.globalState);
        this._memoryManager = new MemoryManager();
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

            switch (data.type) {
                case 'askCouncil':
                    {
                        await this._delegateToCouncil(data.value, data.agents, data.mode, data.executor, data.images, data.referencedTurnSequences);
                        break;
                    }
                case 'newChat':
                    {
                        this._currentTaskId = undefined;
                        this._activeTurnRef = undefined;
                        this._activeStopReason = undefined;
                        this._activeRunAdapters = [];
                        this._view?.webview.postMessage({ type: 'turnComplete' });
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
                case 'toggleShowAllWorkspaces':
                    {
                        this._showAllWorkspaces = !this._showAllWorkspaces;
                        this._sendSessionsToUI();
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
                        void this._context.globalState.update('optimusQueue', undefined);
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
        debugLog('Webview', 'Sending UI state update', JSON.stringify({ debugMode: isDebugModeEnabled() }));
        this._view?.webview.postMessage({
            type: 'updateUiState',
            debugMode: isDebugModeEnabled()
        });
    }

    private _sendCurrentTaskState() {
        if (!this._view) {
            return;
        }

        const taskState = this._currentTaskId ? this._taskStateManager.getTask(this._currentTaskId) : undefined;
        const latestTurn = taskState?.turnHistory[taskState.turnHistory.length - 1];
        const turnCount = taskState?.turnHistory.length ?? 0;
        const turnCountChanged = turnCount !== this._lastSentTurnCount;

        // Cache context token estimation — only recompute when turn count changes
        let contextTokens = 0;
        let needsCompaction = false;
        if (taskState) {
            const cache = this._cachedContextTokens;
            if (cache && cache.taskId === taskState.taskId && cache.turnCount === turnCount) {
                contextTokens = cache.tokens;
                needsCompaction = cache.needsCompaction;
            } else {
                contextTokens = this._taskStateManager.estimateContextTokens(taskState);
                needsCompaction = this._taskStateManager.needsCompaction(taskState);
                this._cachedContextTokens = { taskId: taskState.taskId, turnCount, tokens: contextTokens, needsCompaction };
            }
        }

        // Only include full turnHistory when the count changes to reduce IPC payload
        const turnHistory = (taskState && turnCountChanged)
            ? taskState.turnHistory.map(turn => ({
                sequence: turn.sequence,
                prompt: turn.prompt.length > 80 ? turn.prompt.slice(0, 77) + '...' : turn.prompt,
                status: turn.status,
                referencedTurnSequences: turn.referencedTurnSequences,
            }))
            : undefined;

        this._lastSentTurnCount = turnCount;

        this._view.webview.postMessage({
            type: 'updateTaskState',
            task: taskState
                ? {
                    taskId: taskState.taskId,
                    title: taskState.title,
                    status: taskState.status,
                    turnCount,
                    latestSummary: taskState.latestSummary,
                    latestPrompt: latestTurn?.prompt,
                    latestTurnStatus: latestTurn?.status,
                    latestTurnSequence: latestTurn?.sequence,
                    latestPlannerNames: latestTurn?.plannerContributions.map(contribution => contribution.agentName) || [],
                    latestExecutorSummary: latestTurn?.executorOutcome?.summary,
                    openQuestions: taskState.openQuestions.slice(-3),
                    blockedReasons: taskState.blockedReasons.slice(-3),
                    contextTokens,
                    needsCompaction,
                    turnHistory,
                }
                : null,
        });
    }

    private _makeStreamingCallback(
        agentName: string,
        adapter?: AgentAdapter,
        sessionMeta?: { turnId: string; agentId?: string; role?: 'planner' | 'executor' | 'synthesizer'; prompt?: string }
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

            // NOTE: Session persistence deferred to agentDone to avoid O(n)
            // disk writes every 100ms during streaming. The final
            // _upsertSessionResponse call happens after the agent completes.
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
        phaseKind: 'planner' | 'executor' | 'synthesizer',
        agents: Array<{ id: string; name: string; role: 'planner' | 'executor' | 'synthesizer' }>,
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

    private async _upsertSessionResponse(turnId: string, nextResponse: SessionResponseRecord) {
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
        await this._context.globalState.update('optimusSessions', sessions);
    }

    private _initializeSessionResponses(
        turnId: string,
        agents: Array<{ name: string; agentId?: string; role?: 'planner' | 'executor' | 'synthesizer'; prompt?: string }>
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

    /**
     * Infer execution mode from prompt characteristics when user selected 'auto'.
     * Returns 'plan' for pure questions, 'direct' for simple edits, 'auto' otherwise.
     */
    private _inferMode(prompt: string, userMode: string, taskState?: { turnHistory: { executorOutcome?: { summary: string } }[] }): string {
        if (userMode !== 'auto') { return userMode; }

        const trimmed = prompt.trim();

        // Implementation-oriented questions need executor, not plan-only
        const implementationQuestionPattern = /^(如何|怎么|how\s+(to|do|can|should)|what('s| is)\s+the\s+(best|right)\s+way)/i;

        // Pure question patterns → plan only (no execution needed)
        const questionPatterns = [
            /^[^。.!！？?\n]{0,120}[？?]$/,
            /^(为什么|怎么|什么|如何|是否|有没有|能不能|是不是|哪个|哪些|解释|分析|看看|review|explain|why|how|what|which|is\s+there|can\s+you\s+tell|do\s+you\s+think)/i,
            /^(目前|现在|当前).{0,60}(建议|看法|意见|想法|问题)[？?]?$/,
            // Additional question patterns
            /^(有什么|你.{0,10}(觉得|认为|建议)|比较|对比|区别|difference|compare)/i,
            /^(告诉我|帮我(看|分析|理解)|describe|summarize|list\s+(the|all))/i,
        ];
        if (questionPatterns.some(pattern => pattern.test(trimmed)) && !implementationQuestionPattern.test(trimmed)) {
            debugLog('InferMode', 'Inferred plan mode (question pattern)', JSON.stringify({ prompt: trimmed.slice(0, 80) }));
            return 'plan';
        }

        // Context-aware: if previous turn was plan-only and user confirms → direct execution
        if (taskState?.turnHistory && taskState.turnHistory.length > 0) {
            const confirmPatterns = [
                /^(好的?|确认|就(按|照|这样)|可以|行|没问题|ok|okay|yes|go|lgtm|do\s+it|proceed|execute|开始|执行|搞|干|来吧|做吧)/i,
                /^(按照?|就按|依照|照着).{0,20}(做|执行|来|改|实现)/i,
                /^(实现一下|帮我(做|实现|写|改)|按.{0,10}(上面|这个|方案))/i,
            ];
            if (trimmed.length < 100 && confirmPatterns.some(p => p.test(trimmed))) {
                debugLog('InferMode', 'Inferred direct mode (confirmation follow-up)', JSON.stringify({ prompt: trimmed.slice(0, 80) }));
                return 'direct';
            }
        }

        // Micro-edits: unambiguous, very short commands → direct even without prior context
        const microEditPatterns = [
            /^(fix typo|rename\s|remove\s|delete\s|add\s+line|update\s+comment|格式化|修复\s*typo|重命名\s)/i,
        ];
        const isMicro = trimmed.length < 80;
        if (isMicro && microEditPatterns.some(p => p.test(trimmed))) {
            debugLog('InferMode', 'Inferred direct mode (micro edit)', JSON.stringify({ prompt: trimmed.slice(0, 80) }));
            return 'direct';
        }

        // Simple, explicit edit commands → direct execution (no planning needed)
        const directPatterns = [
            /^(把|将|改|删除|移除|添加|加上|去掉|rename|fix typo|remove|delete|add|change|replace|update)/i,
            /^(修复|修改|替换|加一个|加一行|改一下|改成)/i,
            // Explicit execution commands
            /^(run|build|compile|install|test|npm\s|git\s|执行|运行|编译|构建|安装|发布|部署)/i,
            /^(帮我写|帮我做|帮我实现|实现一下|写一个|做一下|创建一个)/i,
        ];
        const isShort = trimmed.length < 200;
        if (isShort && directPatterns.some(pattern => pattern.test(trimmed))) {
            debugLog('InferMode', 'Inferred direct mode (short edit command)', JSON.stringify({ prompt: trimmed.slice(0, 80) }));
            return 'direct';
        }

        return 'auto';
    }

    /**
     * After Phase 1 completes, analyze planner outputs to determine whether
     * code execution is actually needed. Uses a consensus threshold of
     * min(2, numPlanners) — single-planner setups work as before, but with
     * 2+ planners at least 2 must agree before triggering 'action' or 'skip'.
     * Falls back to 'answer' when consensus is not reached.
     */
    private _computeIntentFromPlanners(planResults: { agentId: string; agent: string; text: string; status: 'success' | 'error' }[]): 'action' | 'answer' | 'skip' | 'unknown' {
        const successful = planResults.filter(r => r.status === 'success');
        if (successful.length === 0) { return 'unknown'; }

        let yesCount = 0;
        let noCount = 0;
        let skipCount = 0;
        for (const r of successful) {
            // Check for skip-to-executor signal
            if (/<skip-to-executor>\s*yes\s*<\/skip-to-executor>/i.test(r.text)) {
                skipCount++;
            }

            const match = /<action-required>\s*(yes|no)\s*<\/action-required>/i.exec(r.text);
            if (match) {
                if (match[1].toLowerCase() === 'yes') { yesCount++; }
                else { noCount++; }
            } else {
                // Fallback heuristic: if planner output contains code fences
                // or file paths it likely implies implementation is needed
                if (/```|\bsrc\/|\bfile\b|\.ts\b|修改|implement|创建|添加文件/i.test(r.text)) {
                    yesCount++;
                } else {
                    noCount++;
                }
            }
        }

        // Consensus threshold: with 2+ planners, require at least 2 agreeing votes
        const requiredConsensus = Math.min(2, successful.length);

        // Skip takes priority: enough planners voted skip + action → fast-track to executor
        if (skipCount >= requiredConsensus && yesCount >= requiredConsensus) { return 'skip'; }
        // Consensus for action
        if (yesCount >= requiredConsensus) { return 'action'; }
        // All voted no (or consensus not reached for action)
        if (noCount > 0 && yesCount === 0) { return 'answer'; }
        return 'unknown';
    }

    private async _delegateToCouncil(prompt: string, selectedAgentIds: string[] = [], mode: string = 'auto', executorId?: string, images?: { dataUrl: string; mimeType: string }[], referencedTurnSequences?: number[]) {
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
            referencedTurnSequences,
        });
        this._currentTaskId = turnState.taskState.taskId;

        if (this._runningTaskIds.has(this._currentTaskId)) {
            await this._taskStateManager.failTurn(this._currentTaskId, turnState.turnRecord.turnId, 'Blocked: another turn is already running for this task.');
            this._view.webview.postMessage({ type: 'agentDone', agent: 'System', text: 'A turn is already running for this task. Please wait for it to finish.', status: 'error', raw: true });
            return;
        }
        this._runningTaskIds.add(this._currentTaskId);
        this._sendSessionsToUI();
        this._activeTurnRef = {
            taskId: turnState.taskState.taskId,
            turnId: turnState.turnRecord.turnId,
        };
        this._activeStopReason = undefined;

        await this._createSessionRecord(prompt, turnState.taskState.taskId, turnState.turnRecord.turnId, storedAttachments);

        // Auto-route: infer optimal mode from prompt heuristics when user selected 'auto'
        const originalMode = mode;
        mode = this._inferMode(prompt, mode, turnState.taskState);
        if (mode !== originalMode) {
            this._view.webview.postMessage({ type: 'modeInferred', originalMode, inferredMode: mode });
        }

        const allAdapters = getActiveAdapters();
        debugLog('Council', 'Delegation started', JSON.stringify({
            taskId: turnState.taskState.taskId,
            turnId: turnState.turnRecord.turnId,
            turnSequence: turnState.turnRecord.sequence,
            promptLength: enrichedPrompt.length,
            hasEditorContext: !!editorContext,
            selectedAgentIds,
            mode,
            originalMode,
            executorId,
            allAdapters: allAdapters.map(a => ({ id: a.id, name: a.name, modes: a.modes }))
        }));
        this._sendCurrentTaskState();

        // === MODE-AWARE ROUTING ===
        // 'auto' — full two-phase: planners → executor (default)
        // 'plan' — planners only, skip executor
        // 'direct' — skip planners, executor acts on user prompt directly

        // Phase 1 setup: filter plan-capable agents.
        // In 'direct' mode, run a single planner as a lightweight validation check
        // so the planner can override _inferMode misclassifications (e.g. complex task
        // misidentified as direct). The planner can vote <action-required> to upgrade.
        const allPlanAdapters = allAdapters.filter(a =>
            selectedAgentIds.includes(a.id) && a.modes.includes('plan')
        );
        let planAdapters = mode === 'direct' ? allPlanAdapters.slice(0, 1) : allPlanAdapters;

        // Only report dropped planners when in non-direct modes with multiple planners.
        // In direct mode, we intentionally limit to 1 planner — no need to notify about the rest.
        if (mode !== 'direct') {
            const droppedPlannerSelections = selectedAgentIds
                .filter(id => !planAdapters.some(adapter => adapter.id === id))
                .map(id => {
                    const adapter = allAdapters.find(candidate => candidate.id === id);
                    if (!adapter) {
                        return { id, name: id, reason: 'not available in the active agent configuration' };
                    }
                    if (!adapter.modes.includes('plan')) {
                        return { id, name: adapter.name, reason: 'executor-only, skipped as planner' };
                    }
                    return { id, name: adapter.name, reason: 'not participating in this planning phase' };
                });

            if (droppedPlannerSelections.length > 0) {
                const droppedSummary = droppedPlannerSelections
                    .map(item => `${item.name} (${item.reason})`)
                    .join(', ');
                const droppedMessage = `Skipped from planning: ${droppedSummary}`;
                debugLog('Council', droppedMessage);
                this._view.webview.postMessage({
                    type: 'agentDone',
                    agent: 'System',
                    text: droppedMessage,
                    status: 'info',
                    raw: true,
                });
            }
        }

        // Phase 2 executor: find the designated executor agent
        let executor = executorId ? allAdapters.find(a => a.id === executorId && a.modes.includes('agent')) : null;
        if (!executor) {
            executor = allAdapters.find(a => a.modes.includes('agent'));
        }

        debugLog('Council', 'Resolved council participants', JSON.stringify({
            planners: planAdapters.map(a => ({ id: a.id, name: a.name })),
            executor: executor ? { id: executor.id, name: executor.name } : null,
        }));

        if (planAdapters.length === 0 && mode !== 'direct') {
            if (executor) {
                // No planners available — fall back to direct mode instead of aborting
                debugLog('Council', 'No planners configured, falling back to direct mode');
                mode = 'direct';
            } else {
                vscode.window.showWarningMessage('[Optimus Code] No plan agents selected.');
                debugLog('Council', 'Aborted because no plan agents were selected');
                return;
            }
        }
        if (mode === 'direct' && !executor) {
            vscode.window.showWarningMessage('[Optimus Code] No executor agent available for direct execution.');
            debugLog('Council', 'Aborted because no executor is available for direct mode');
            return;
        }

        // In plan mode, include executor (or fallback synthesizer) when multiple planners are selected
        const planMayNeedSynthesis = mode === 'plan' && planAdapters.length > 1;
        // In direct mode, include the validation planner (if any) plus the executor
        this._activeRunAdapters = mode === 'direct'
            ? [...planAdapters, ...(executor ? [executor] : [])]
            : [...planAdapters, ...(mode === 'plan' ? (planMayNeedSynthesis && executor ? [executor] : []) : executor ? [executor] : [])];

        const sessionResponses: SessionResponseRecord[] = [];
        const plannerContributions: ContributionRecord[] = [];

        try {
            const planResults: {agentId: string, agent: string, text: string, status: 'success' | 'error'}[] = [];
            // Track planner promises so background planners (from skip-to-executor early exit)
            // can be drained before persisting turn state.
            let pendingPlannerPromises: Promise<void>[] = [];

            // --- Phase 1: Council Planning (runs whenever planAdapters is non-empty) ---
            // In 'direct' mode, a single validation planner runs to catch _inferMode misclassifications.
            if (planAdapters.length > 0) {
                const plannerPrompt = this._taskStateManager.buildPlannerPrompt(
                    turnState.taskState,
                    turnState.turnRecord,
                    enrichedPrompt
                );

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
                        // Strip <action-required> and <skip-to-executor> tags from display output (kept in planResults for intent detection)
                        const displayOutput = output
                            .replace(/<action-required>\s*(yes|no)\s*<\/action-required>/gi, '')
                            .replace(/<skip-to-executor>\s*yes\s*<\/skip-to-executor>/gi, '')
                            .trim();
                        const plannerSuccessRecord = { agent: adapter.name, agentId: adapter.id, role: 'planner' as const, prompt: plannerPrompt, thinking: thinking, text: displayOutput, usageLog: usageLog, status: 'success' as const, raw: false, debug: adapter.lastDebugInfo };
                        sessionResponses.push(plannerSuccessRecord);
                        this._upsertSessionResponse(turnState.turnRecord.turnId, plannerSuccessRecord);
                        plannerContributions.push(this._buildContributionRecord(adapter, 'planner', res, 'success'));
                        const htmlContent = await marked.parse(displayOutput);
                        const thinkingHtml = thinking ? await marked.parse(thinking) : undefined;
                        this._view?.webview.postMessage({ type: 'agentDone', agent: adapter.name, agentId: adapter.id, role: 'planner', prompt: plannerPrompt, thinkingHtml: thinkingHtml, thinking: thinking, text: htmlContent, rawText: displayOutput, usageLog: usageLog, debug: adapter.lastDebugInfo, status: 'success', raw: false });
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
                pendingPlannerPromises = promises;

                // First-vote-wins: if any planner signals <skip-to-executor>, resolve early
                // without waiting for the remaining planners. All planners still run to completion
                // in the background (their results are recorded for session history).
                let skipDetected = false;
                if (planAdapters.length > 1) {
                    await new Promise<void>(resolve => {
                        let settled = 0;
                        const total = promises.length;
                        for (const p of promises) {
                            p.then(() => {
                                settled++;
                                if (!skipDetected) {
                                    // Check if any result so far has skip signal
                                    const hasSkip = planResults.some(r =>
                                        r.status === 'success' && /<skip-to-executor>\s*yes\s*<\/skip-to-executor>/i.test(r.text)
                                    );
                                    if (hasSkip) {
                                        skipDetected = true;
                                        debugLog('Council', 'Skip-to-executor detected, proceeding early', JSON.stringify({
                                            settled,
                                            total,
                                            skipAgent: planResults.find(r => /<skip-to-executor>\s*yes\s*<\/skip-to-executor>/i.test(r.text))?.agent,
                                        }));
                                        resolve();
                                    } else if (settled === total) {
                                        resolve();
                                    }
                                } else if (settled === total) {
                                    // Already resolved early, just let remaining finish
                                }
                            }).catch(() => {
                                settled++;
                                if (settled === total && !skipDetected) {
                                    resolve();
                                }
                            });
                        }
                    });
                } else {
                    await Promise.all(promises);
                }
                this._view.webview.postMessage({ type: 'councilComplete' });
                debugLog('Council', 'Planning phase completed', JSON.stringify({ planResults: planResults.length, skipDetected }));
            }

            // --- Phase 2: Executor synthesizes and acts (skipped in 'plan' mode) ---
            // In 'plan' mode with multiple planner results, run a synthesis-only step
            let executorOutcome: ExecutorOutcomeRecord | undefined;
            let synthesisPrompt: string | undefined;

            // Intent gate: let planners vote on whether execution is needed.
            // Runs in 'auto', 'plan', and 'direct' modes so planner votes can override
            // _inferMode misclassifications (e.g. plan→executor, direct→needs planning).
            const plannerIntent = planResults.length > 0 ? this._computeIntentFromPlanners(planResults) : undefined;
            const intentDowngraded = mode === 'auto' && plannerIntent === 'answer';
            const intentSkipped = mode === 'auto' && plannerIntent === 'skip';
            // Upgrade: if _inferMode said 'plan' but planners voted action/skip, upgrade to auto
            const intentUpgraded = mode === 'plan' && (plannerIntent === 'action' || plannerIntent === 'skip');
            // Direct override: if _inferMode said 'direct' but planner voted action (complex task),
            // upgrade to auto so executor receives planner synthesis instead of raw user prompt
            const directOverridden = mode === 'direct' && plannerIntent === 'action';
            if (intentDowngraded) {
                debugLog('IntentGate', 'Auto mode downgraded to plan (planners voted answer-only)', JSON.stringify({ plannerIntent }));
                this._view.webview.postMessage({ type: 'intentDowngrade', originalMode: 'auto', effectiveMode: 'plan', plannerIntent });
            }
            if (intentSkipped) {
                debugLog('IntentGate', 'Skip-to-executor: planner voted simple task, fast-tracking to executor', JSON.stringify({ plannerIntent }));
                this._view.webview.postMessage({ type: 'intentSkip', originalMode: 'auto', effectiveMode: 'auto', plannerIntent: 'skip' });
            }
            if (intentUpgraded) {
                debugLog('IntentGate', 'Plan mode upgraded to auto (planners voted action-required)', JSON.stringify({ plannerIntent, originalInferredMode: mode }));
                this._view.webview.postMessage({ type: 'intentUpgrade', originalMode: 'plan', effectiveMode: 'auto', plannerIntent });
            }
            if (directOverridden) {
                debugLog('IntentGate', 'Direct mode upgraded to auto (planner voted action-required for complex task)', JSON.stringify({ plannerIntent, originalInferredMode: mode }));
                this._view.webview.postMessage({ type: 'intentUpgrade', originalMode: 'direct', effectiveMode: 'auto', plannerIntent });
            }

            const effectiveMode = intentDowngraded ? 'plan' : (intentUpgraded || directOverridden) ? 'auto' : mode;
            // For plan synthesis: use executor if available, otherwise fall back to first plan adapter as synthesizer
            const synthesizerAdapter = executor ?? (effectiveMode === 'plan' ? planAdapters[0] : null);
            const isPlanSynthesis = effectiveMode === 'plan' && synthesizerAdapter && planResults.filter(r => r.status === 'success').length > 1;
            if ((executor || isPlanSynthesis) && (effectiveMode !== 'plan' || isPlanSynthesis)) {
                const synthesizer = isPlanSynthesis ? synthesizerAdapter! : executor!;
                // In 'direct' mode, skip planner synthesis check — executor acts on user prompt directly
                // In 'auto' mode, require at least one successful planner output
                const successfulPlans = planResults.filter(r => r.status === 'success');
                if (effectiveMode === 'direct' || successfulPlans.length > 0) {
                    let executorPrompt: string;
                    const phaseRole = isPlanSynthesis ? 'synthesizer' as const : 'executor' as const;
                    if (effectiveMode === 'direct') {
                        executorPrompt = this._taskStateManager.buildDirectExecutorPrompt(
                            turnState.taskState,
                            turnState.turnRecord,
                            prompt,
                            enrichedPrompt
                        );
                    } else if (directOverridden && successfulPlans.length > 0) {
                        // Direct→Auto escalation: validation planner flagged complex task.
                        // Use hybrid prompt with both user request and planner insight
                        // (only 1 planner ran in direct mode, so standard synthesis is thin).
                        const plannerInsight = successfulPlans.map(r =>
                            `=== ${r.agent} ===\n${r.text.replace(/<action-required>\s*(yes|no)\s*<\/action-required>/gi, '').replace(/<skip-to-executor>\s*yes\s*<\/skip-to-executor>/gi, '').trim()}`
                        ).join('\n\n');
                        executorPrompt = this._taskStateManager.buildDirectEscalatedPrompt(
                            turnState.taskState,
                            turnState.turnRecord,
                            prompt,
                            enrichedPrompt,
                            plannerInsight
                        );
                    } else if (isPlanSynthesis) {
                        const synthesis = successfulPlans.map(r =>
                            `=== ${r.agent} ===\n${r.text.replace(/<action-required>\s*(yes|no)\s*<\/action-required>/gi, '').replace(/<skip-to-executor>\s*yes\s*<\/skip-to-executor>/gi, '').trim()}`
                        ).join('\n\n');
                        executorPrompt = this._taskStateManager.buildPlanSynthesisPrompt(
                            turnState.taskState,
                            turnState.turnRecord,
                            prompt,
                            synthesis
                        );
                    } else {
                        const synthesis = successfulPlans.map(r =>
                            `=== ${r.agent} ===\n${r.text.replace(/<action-required>\s*(yes|no)\s*<\/action-required>/gi, '').replace(/<skip-to-executor>\s*yes\s*<\/skip-to-executor>/gi, '').trim()}`
                        ).join('\n\n');
                        executorPrompt = this._taskStateManager.buildExecutorPrompt(
                            turnState.taskState,
                            turnState.turnRecord,
                            prompt,
                            synthesis,
                            plannerIntent
                        );
                    }
                    synthesisPrompt = executorPrompt;

                    // Show executor/synthesizer in UI
                    this._postPhaseStart(
                        phaseRole,
                        [{ id: synthesizer.id, name: synthesizer.name, role: phaseRole }],
                        executorPrompt
                    );
                    this._initializeSessionResponses(turnState.turnRecord.turnId, [{
                        name: synthesizer.name,
                        agentId: synthesizer.id,
                        role: phaseRole,
                        prompt: executorPrompt,
                    }]);

                    const execName = isPlanSynthesis ? `📋 ${synthesizer.name} (Plan Summary)` : synthesizer.name;
                    const { callback: execCallback, flush: execFlush } = this._makeStreamingCallback(execName, synthesizer, {
                        turnId: turnState.turnRecord.turnId,
                        agentId: synthesizer.id,
                        role: phaseRole,
                        prompt: executorPrompt,
                    });
                    debugLog('Council', `${phaseRole} phase starting`, JSON.stringify({ executor: synthesizer.name, promptLength: executorPrompt.length, isPlanSynthesis }));

                    // For plan synthesis, use 'plan' invoke mode so the synthesizer has no tool access
                    const invokeMode: AgentMode = isPlanSynthesis ? 'plan' : 'agent';

                    try {
                        const execResultRaw = await synthesizer.invoke(executorPrompt, invokeMode, execCallback);
                        execFlush();

                        // Extract <task-summary> from executor output before further parsing
                        const { summary: extractedSummary, cleaned: execCleaned } = this._extractTaskSummary(execResultRaw);

                        // Extract <memory-update> blocks and persist to .optimus/memory.md
                        const { updates: memoryUpdates, cleaned: execCleanedFinal } = this._extractMemoryUpdate(execCleaned);
                        for (const update of memoryUpdates) {
                            this._memoryManager.appendMemory(update);
                            debugLog('Council', 'Memory update persisted', JSON.stringify({ length: update.length }));
                        }

                        const { thinking, output, usageLog } = this._extractThinking(execCleanedFinal, synthesizer);

                        const executorSuccessRecord = { agent: synthesizer.name, agentId: synthesizer.id, role: phaseRole, prompt: executorPrompt, thinking: thinking, text: output, usageLog: usageLog, status: 'success' as const, raw: false, debug: synthesizer.lastDebugInfo };
                        sessionResponses.push(executorSuccessRecord);
                        this._upsertSessionResponse(turnState.turnRecord.turnId, executorSuccessRecord);
                        executorOutcome = this._buildExecutorOutcomeRecord(synthesizer, execCleanedFinal, 'success', output);

                        if (extractedSummary) {
                            this._taskStateManager.updateTaskSummary(turnState.taskState.taskId, extractedSummary).catch(err => {
                                debugLog('Council', 'Failed to save extracted task summary', String(err));
                            });
                        }
                        const htmlContent = await marked.parse(output);
                        const thinkingHtml = thinking ? await marked.parse(thinking) : undefined;
                        this._view?.webview.postMessage({ type: 'agentDone', agent: execName, agentId: synthesizer.id, role: phaseRole, prompt: executorPrompt, thinkingHtml: thinkingHtml, thinking: thinking, text: htmlContent, rawText: output, usageLog: usageLog, debug: synthesizer.lastDebugInfo, status: 'success', raw: false });
                        this._sendDebugInfo(synthesizer, '', {
                            taskId: turnState.taskState.taskId,
                            turnId: turnState.turnRecord.turnId,
                            role: phaseRole,
                        });
                    } catch (err: any) {
                        execFlush();
                        const executorErrorRecord = { agent: synthesizer.name, agentId: synthesizer.id, role: phaseRole, prompt: executorPrompt, text: err.message, status: 'error' as const, raw: true, debug: synthesizer.lastDebugInfo };
                        sessionResponses.push(executorErrorRecord);
                        this._upsertSessionResponse(turnState.turnRecord.turnId, executorErrorRecord);
                        executorOutcome = this._buildExecutorOutcomeRecord(synthesizer, err.message, 'error');
                        this._view?.webview.postMessage({ type: 'agentDone', agent: execName, agentId: synthesizer.id, role: phaseRole, prompt: executorPrompt, text: err.message, debug: synthesizer.lastDebugInfo, status: 'error', raw: true });
                        this._sendDebugInfo(synthesizer, '', {
                            taskId: turnState.taskState.taskId,
                            turnId: turnState.turnRecord.turnId,
                            role: phaseRole,
                        });
                    }

                    this._view.webview.postMessage({ type: 'councilComplete' });
                    debugLog('Council', 'Executor phase completed');
                }
            }

            // Drain any background planner promises that were still running
            // after a skip-to-executor early exit, so their contributions are
            // properly recorded in session state and turn history.
            if (pendingPlannerPromises.length > 0) {
                await Promise.allSettled(pendingPlannerPromises);
                debugLog('Council', 'Background planner promises drained', JSON.stringify({ count: pendingPlannerPromises.length }));
            }

            // Persist session responses BEFORE completing the turn in task state.
            // This prevents a race where task state is saved but session responses
            // are lost if VS Code shuts down between the two writes.
            await this._updateSessionRecord(turnState.turnRecord.turnId, sessionResponses);

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
            this._sendSessionsToUI();
            this._activeTurnRef = undefined;
            this._activeStopReason = undefined;
            this._activeRunAdapters = [];
            this._view?.webview.postMessage({ type: 'turnComplete' });
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

    private _extractMemoryUpdate(rawText: string): { updates: string[]; cleaned: string } {
        const regex = /<memory-update>([\s\S]*?)<\/memory-update>/gi;
        const updates: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(rawText)) !== null) {
            updates.push(match[1].trim());
        }
        const cleaned = rawText.replace(/<memory-update>[\s\S]*?<\/memory-update>/gi, '').trim();
        return { updates, cleaned };
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
        status: 'success' | 'error',
        cleanOutputForSummary?: string
    ): ExecutorOutcomeRecord {
        const normalizedText = text.trim();
        const summarySource = cleanOutputForSummary !== undefined
            ? cleanOutputForSummary.trim()
            : normalizedText;
        return {
            agentId: adapter.id,
            agentName: adapter.name,
            status,
            summary: this._summarizeText(summarySource),
            rawText: normalizedText,
            timestamp: Date.now(),
            debug: this._buildDebugObject(adapter),
        };
    }

    private _summarizeText(text: string): string {
        // Defense-in-depth: strip tool trace lines before summarizing
        const filtered = text.split('\n')
            .filter(line => !/^\s*[•●⏺▶→└│├✓✗↳]/.test(line))
            .join('\n');
        const singleLine = filtered.replace(/\s+/g, ' ').trim();
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

    private async _createSessionRecord(prompt: string, taskId: string, turnId: string, attachments: SessionImageAttachment[] = []) {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        sessions.unshift({
            id: turnId,
            timestamp: Date.now(),
            prompt,
            taskId,
            turnId,
            attachments,
            responses: [],
            workspacePath: PersistentAgentAdapter.getWorkspacePath(),
        });
        const limited = sessions.slice(0, 50);
        await this._context.globalState.update('optimusSessions', limited);
        this._sendSessionsToUI();
    }

    private async _updateSessionRecord(turnId: string, responses: SessionResponseRecord[]) {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const idx = sessions.findIndex(s => s.turnId === turnId);
        if (idx !== -1) {
            sessions[idx] = { ...sessions[idx], responses: responses.map(response => ({ ...response })) };
        }
        await this._context.globalState.update('optimusSessions', sessions);
        this._sendSessionsToUI();
    }

    private _sendSessionsToUI() {
        const sessions: StoredSession[] = this._context.globalState.get('optimusSessions', []);
        const snapshots = this._taskStateManager.listTaskSnapshots();
        const snapshotMap = new Map(snapshots.map(snapshot => [snapshot.taskId, snapshot]));
        const currentWorkspacePath = PersistentAgentAdapter.getWorkspacePath();

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

            // Workspace filter: skip tasks from other workspaces unless showAllWorkspaces is on.
            // Old data without workspacePath is always shown (backward compatible).
            if (!this._showAllWorkspaces && s.taskId) {
                const snapshot = snapshotMap.get(s.taskId);
                const sessionWorkspacePath = snapshot?.workspacePath ?? s.workspacePath;
                if (sessionWorkspacePath && sessionWorkspacePath !== currentWorkspacePath) {
                    continue;
                }
            }

            uniqueSessions.push(s);
        }

        const lightweightSessions = uniqueSessions.map(s => {
            const snapshot = s.taskId ? snapshotMap.get(s.taskId) : undefined;
            const attachments = (s.attachments || [])
                .map(a => this._toWebviewAttachment(a))
                .filter((a): a is SessionImageAttachment => Boolean(a));
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
                isRunning: s.taskId ? this._runningTaskIds.has(s.taskId) : false,
                workspacePath: snapshot?.workspacePath ?? s.workspacePath,
                attachmentCount: attachments.length,
                attachments,
            };
        });
        this._view?.webview.postMessage({
            type: 'updateSessionsList',
            sessions: lightweightSessions,
            currentWorkspacePath,
            showAllWorkspaces: this._showAllWorkspaces,
        });
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
            const matchedTurn = taskState?.turnHistory.find(turn => turn.turnId === session.turnId);

            // Fallback: if session responses were lost (e.g. crash before persistence)
            // but the turn has planner/executor data in task state, rebuild minimal entries.
            let effectiveResponses = session.responses;
            if (effectiveResponses.length === 0 && matchedTurn && matchedTurn.status !== 'in_progress') {
                const fallback: SessionResponseRecord[] = [];
                for (const contribution of matchedTurn.plannerContributions) {
                    fallback.push({
                        agent: contribution.agentName,
                        agentId: contribution.agentId,
                        role: 'planner',
                        text: contribution.summary || contribution.rawText,
                        status: contribution.status,
                        raw: false,
                    });
                }
                if (matchedTurn.executorOutcome) {
                    fallback.push({
                        agent: matchedTurn.executorOutcome.agentName,
                        agentId: matchedTurn.executorOutcome.agentId,
                        role: 'executor',
                        text: matchedTurn.executorOutcome.summary || matchedTurn.executorOutcome.rawText,
                        status: matchedTurn.executorOutcome.status,
                        raw: false,
                    });
                }
                if (fallback.length > 0) {
                    effectiveResponses = fallback;
                    debugLog('History', 'Rebuilt responses from task state for turn', JSON.stringify({ turnId: session.turnId, count: fallback.length }));
                }
            }

            const parsedResponses = await Promise.all(effectiveResponses.map(async (r: SessionResponseRecord) => {
                const responseText = r.text || '';
                const responseThinking = r.thinking || '';
                const text = (r.status === 'success' && !r.raw) ? await marked.parse(responseText) : responseText;
                const thinkingText = responseThinking ? await marked.parse(responseThinking) : undefined;
                return { ...r, parsedText: text, thinkingHtml: thinkingText, usageLog: r.usageLog };
            }));
            parsedGroupSessions.push({
                ...session,
                turnSequence: matchedTurn?.sequence,
                referencedTurnSequences: matchedTurn?.referencedTurnSequences,
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
                    position: relative;
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
                #reference-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    padding: 4px 0;
                }
                #reference-chips:empty {
                    display: none;
                }
                .ref-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 8px;
                    font-size: 11px;
                    border-radius: 999px;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    cursor: default;
                    white-space: nowrap;
                }
                .ref-chip-remove {
                    cursor: pointer;
                    font-size: 12px;
                    opacity: 0.7;
                    margin-left: 2px;
                }
                .ref-chip-remove:hover {
                    opacity: 1;
                }
                .message.user.referenced {
                    border-left: 3px solid var(--vscode-focusBorder);
                    background: var(--vscode-editor-selectionHighlightBackground);
                }
                .ref-turn-btn {
                    display: inline-block;
                    position: absolute;
                    top: 4px;
                    right: 4px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    font-size: 11px;
                    padding: 1px 6px;
                    cursor: pointer;
                    line-height: 1.4;
                    opacity: 0.45;
                    transition: opacity 0.15s ease;
                }
                .message.user:hover .ref-turn-btn {
                    opacity: 1;
                }
                .ref-turn-btn:hover {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    opacity: 1;
                }
                .message-ref-cards {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    margin-top: 6px;
                }
                .message-ref-card {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    padding: 4px 8px;
                    border-left: 3px solid var(--vscode-focusBorder);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 0 4px 4px 0;
                    cursor: pointer;
                    opacity: 0.85;
                    transition: opacity 0.15s ease, background 0.15s ease;
                    max-width: 340px;
                    overflow: hidden;
                }
                .message-ref-card:hover {
                    opacity: 1;
                    background: var(--vscode-list-hoverBackground);
                }
                .message-ref-card-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 11px;
                    overflow: hidden;
                }
                .message-ref-card-seq {
                    font-weight: 600;
                    color: var(--vscode-textLink-foreground);
                    flex-shrink: 0;
                }
                .message-ref-card-prompt {
                    color: var(--vscode-foreground);
                    opacity: 0.85;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .message-ref-card-summary {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                    opacity: 0.75;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    font-style: italic;
                }
                @keyframes ref-flash {
                    0%   { box-shadow: 0 0 0 2px var(--vscode-focusBorder); }
                    50%  { box-shadow: 0 0 0 4px var(--vscode-focusBorder); background: var(--vscode-editor-findMatchHighlightBackground); }
                    100% { box-shadow: none; }
                }
                .ref-highlight-flash {
                    animation: ref-flash 0.5s ease 3;
                    border-radius: 4px;
                }
                .mode-selector {
                    display: inline-flex;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    overflow: hidden;
                }
                .mode-btn {
                    padding: 3px 8px;
                    font-size: 11px;
                    border: none;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    cursor: pointer;
                    border-right: 1px solid var(--vscode-panel-border);
                    line-height: 1.4;
                }
                .mode-btn:last-child {
                    border-right: none;
                }
                .mode-btn.active {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .mode-btn:hover:not(.active) {
                    background: var(--vscode-button-secondaryHoverBackground);
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
                    flex-shrink: 0;
                }
                .chat-header-actions {
                    display: flex;
                    gap: 6px;
                    flex-shrink: 0;
                }
                .chat-header-actions button {
                    padding: 3px 10px;
                    font-size: 12px;
                    cursor: pointer;
                    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
                    border-radius: 4px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    font-family: var(--vscode-font-family);
                    white-space: nowrap;
                }
                .chat-header-actions button:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
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
                .session-workspace-label {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 2px;
                    opacity: 0.8;
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
                .session-running-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    flex-shrink: 0;
                    font-size: 11px;
                    font-weight: 600;
                    color: var(--vscode-textLink-foreground);
                    background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent 86%);
                    border-radius: 4px;
                    padding: 1px 6px;
                }
                .session-running-badge .running-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 999px;
                    border: 1.5px solid color-mix(in srgb, var(--vscode-textLink-foreground) 28%, transparent 72%);
                    border-top-color: var(--vscode-textLink-foreground);
                    animation: spin 0.9s linear infinite;
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
                .session-image-strip {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 4px;
                    margin-top: 6px;
                }
                .session-image-thumb {
                    width: 48px;
                    height: 48px;
                    object-fit: cover;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-panel-border);
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
                    background: var(--vscode-editor-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding: 4px 8px;
                }

                /* Floating collapse bar for off-screen expanded sections */
                #floating-collapse-bar {
                    flex-shrink: 0;
                    z-index: 10;
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
                .process-step-status-interrupted {
                    color: var(--vscode-disabledForeground);
                    font-style: italic;
                }
                .process-interrupted-group {
                    margin: 8px 0 4px 0;
                    border: 1px dashed var(--vscode-panel-border);
                    border-radius: 6px;
                    padding: 0;
                    opacity: 0.75;
                }
                .process-interrupted-group[open] {
                    opacity: 1;
                }
                .process-interrupted-summary {
                    cursor: pointer;
                    padding: 6px 10px;
                    font-size: 12px;
                    color: var(--vscode-disabledForeground);
                    font-style: italic;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .process-interrupted-summary:hover {
                    color: var(--vscode-foreground);
                }
                .process-interrupted-icon {
                    font-style: normal;
                }
                .process-interrupted-tools {
                    margin-left: auto;
                    font-size: 11px;
                    opacity: 0.7;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    max-width: 200px;
                }
                .process-interrupted-details {
                    padding: 0 8px 8px 8px;
                    border-top: 1px dashed var(--vscode-panel-border);
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
                .queue-item {
                    display: flex;
                    align-items: center;
                    padding: 3px 10px;
                    font-size: 12px;
                    gap: 6px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .queue-item:last-child { border-bottom: none; }
                .queue-item-index {
                    color: var(--vscode-descriptionForeground);
                    min-width: 18px;
                    font-size: 11px;
                }
                .queue-item-text {
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .queue-item-remove {
                    cursor: pointer;
                    padding: 0 4px;
                    color: var(--vscode-descriptionForeground);
                    font-size: 14px;
                }
                .queue-item-remove:hover {
                    color: var(--vscode-errorForeground);
                }
                .queue-header-action {
                    cursor: pointer;
                    padding: 1px 6px;
                    border-radius: 3px;
                    font-size: 11px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    white-space: nowrap;
                }
                .queue-header-action:hover {
                    opacity: 0.8;
                }
                .queue-header-danger {
                    color: var(--vscode-errorForeground);
                }
                .queue-item-mode {
                    flex-shrink: 0;
                    font-size: 10px;
                    padding: 0 4px;
                    border-radius: 3px;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    white-space: nowrap;
                }
            </style>
        </head>
        <body data-debug-mode="${isDebugModeEnabled() ? 'true' : 'false'}">
            <!-- MAIN CHAT VIEW -->
            <div id="chat-view" class="view active">
                <div class="chat-header">
                    <div style="font-weight: bold; font-size: 14px;">Optimus Council</div>
                    <div class="chat-header-actions">
                        <button aria-label="New Chat" id="new-chat-btn" title="Start a new conversation (clears current task context)">New Chat</button>
                        <button aria-label="Sessions History" id="toggle-sessions-btn" title="View Sessions History">History</button>
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
                    <div id="reference-chips" style="display:none;"></div>
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

                        <div id="mode-selector" class="mode-selector" title="Execution Mode">
                            <button class="mode-btn" data-mode="plan" title="Plan Only — analysis without execution">Plan</button>
                            <button class="mode-btn active" data-mode="auto" title="Auto — planners then executor (default)">Auto</button>
                            <button class="mode-btn" data-mode="direct" title="Execute Only — skip planners, direct execution">Exec</button>
                        </div>

                        <vscode-button appearance="secondary" id="compact-btn" title="Compact Context">Compact</vscode-button>
                        <span id="context-token-counter" style="font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; display: none;"></span>
                        <vscode-button appearance="secondary" id="stop-btn" title="Stop Council Activity" style="display:none; background: var(--vscode-errorForeground); color: white;">Stop</vscode-button>
                        <vscode-button appearance="secondary" id="queue-btn" title="Add current prompt to queue (Enter)" style="display:none;">Queue <span id="queue-badge" style="margin-left: 4px; font-weight: bold;"></span></vscode-button>
                        <vscode-button appearance="icon" id="queue-view-btn" title="View / hide queued prompts" style="display:none;">\u2630 <span id="queue-view-count" style="font-weight: bold;"></span></vscode-button>
                        <vscode-button id="ask-btn">Send</vscode-button>
                    </div>
                    <div id="queue-panel" style="display:none; margin-top: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editor-background); max-height: 160px; overflow-y: auto;">
                        <div style="padding: 6px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center;">
                            <span>Queued Prompts</span>
                            <span style="display:flex;align-items:center;gap:8px;">
                                <span id="queue-panel-actions" style="display:flex;gap:6px;"></span>
                                <span id="queue-panel-close" style="cursor: pointer; padding: 0 4px;" title="Close">\u2715</span>
                            </span>
                        </div>
                        <div id="queue-list" style="padding: 4px 0;"></div>
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
                    <vscode-button appearance="secondary" id="toggle-workspace-btn" title="Toggle workspace filter">
                        This workspace
                    </vscode-button>
                </div>
                <div class="sessions-panel" id="sessions-panel"></div>
            </div>

            <script src="${webviewScriptUri}"></script>
        </body>
        </html>`;
    }
}
