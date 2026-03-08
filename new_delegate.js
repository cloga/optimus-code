"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
async;
_delegateToCouncil(prompt, string, selectedAgentIds, string[] = [], mode, string = 'auto', executorId ?  : string, images ?  : { dataUrl: string, mimeType: string }[], referencedTurnSequences ?  : number[]);
{
    if (!this._view) {
        return;
    }
    let imageNote = '';
    let storedAttachments = [];
    if (images && images.length > 0) {
        storedAttachments = this._saveImagesToDisk(images);
        imageNote = '\n\n[Attached images]\n' + storedAttachments.map(image => , -).join('\n') + '\n';
    }
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
    const allAdapters = getActiveAdapters();
    const selectedAdapters = allAdapters.filter(a => selectedAgentIds.includes(a.id));
    if (selectedAdapters.length === 0) {
        vscode.window.showWarningMessage('[Optimus Code] No agents selected.');
        return;
    }
    this._activeRunAdapters = selectedAdapters;
    this._sendCurrentTaskState();
    const sessionResponses = [];
    try {
        this._postPhaseStart('planner', // We'll just keep planner as generic phase name for UI
        selectedAdapters.map(a => ({ id: a.id, name: a.name, role: 'planner' })), prompt, false);
        this._initializeSessionResponses(turnState.turnRecord.turnId, selectedAdapters.map(a => ({ name: a.name, agentId: a.id, role: 'planner', prompt })));
        const promises = selectedAdapters.map(async (adapter) => {
            const stream = this._makeStreamingCallback(adapter.name, adapter, {
                turnId: turnState.turnRecord.turnId,
                agentId: adapter.id,
                role: 'planner',
                prompt
            });
            let resultText = '';
            let status = 'success';
            try {
                const agentPrompt = this._taskStateManager.buildPlannerPrompt(turnState.taskState, turnState.turnRecord, enrichedPrompt);
                resultText = await adapter.chat(agentPrompt, stream.callback);
                stream.flush();
            }
            catch (err) {
                stream.flush();
                resultText = ;
                 ** Error;
                 ** ;
                ;
                status = 'error';
            }
            if (this._activeStopReason) {
                resultText += ;
                n;
                n ** [Stopped, by, User] ** ;
                ;
                status = 'error';
            }
            const parsed = this._extractThinking(resultText, adapter);
            const record = {
                agent: adapter.name,
                agentId: adapter.id,
                role: 'planner',
                prompt: prompt,
                thinking: parsed.thinking,
                text: resultText,
                status,
                failureReason: this._activeStopReason,
                raw: false,
            };
            sessionResponses.push(record);
            await this._upsertSessionResponse(turnState.turnRecord.turnId, record);
            this._view.webview.postMessage({
                type: 'agentDone',
                agent: record.agent,
                text: record.text,
                status: record.status,
                raw: record.raw
            });
        });
        await Promise.all(promises);
        const plannerContributions = sessionResponses.map(r => ({
            agentName: r.agent,
            status: r.status,
            text: r.text,
            content: r.text
        }));
        await this._taskStateManager.persistPlannerContributions(this._currentTaskId, turnState.turnRecord.turnId, plannerContributions);
        await this._taskStateManager.finishTurn(this._currentTaskId, turnState.turnRecord.turnId, sessionResponses, undefined);
    }
    catch (globalErr) {
        debugLog('Council', 'Global error', globalErr);
    }
    finally {
        this._runningTaskIds.delete(this._currentTaskId);
        this._activeRunAdapters = [];
        this._currentTaskId = undefined;
        this._activeTurnRef = undefined;
        this._activeStopReason = undefined;
        this._sendCurrentTaskState(); // Flush latest state to UI
    }
}
//# sourceMappingURL=new_delegate.js.map