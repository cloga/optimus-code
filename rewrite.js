const fs = require('fs');

function rewrite() {
    let content = fs.readFileSync('src/providers/ChatViewProvider.ts', 'utf8');

    const startIdx = content.indexOf('    private async _delegateToCouncil(');
    const endIdx = content.indexOf('    private _stopActiveCouncil() {');
    
    const inferModeStart = content.indexOf('    private _inferMode(');
    
    const newDelegate = `    private async _delegateToCouncil(prompt: string, selectedAgentIds: string[] = [], mode: string = 'auto', executorId?: string, images?: { dataUrl: string; mimeType: string }[], referencedTurnSequences?: number[]) {
        if (!this._view) { return; }

        let imageNote = '';
        let storedAttachments: SessionImageAttachment[] = [];
        if (images && images.length > 0) {
            storedAttachments = this._saveImagesToDisk(images);
            imageNote = '\\n\\n[Attached images]\\n' + storedAttachments.map(image => '- ' + image.filePath).join('\\n') + '\\n';
        }

        const editorContext = this._getActiveEditorContext();
        const enrichedPrompt = [editorContext, prompt + imageNote].filter(Boolean).join('\\n\\n');

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

        const sessionResponses: SessionResponseRecord[] = [];
        
        try {
            this._postPhaseStart(
                'executor', 
                selectedAdapters.map(a => ({ id: a.id, name: a.name, role: 'executor' })),
                prompt,
                false
            );

            this._initializeSessionResponses(
                turnState.turnRecord.turnId,
                selectedAdapters.map(a => ({ name: a.name, agentId: a.id, role: 'executor' as const, prompt }))
            );

            const promises = selectedAdapters.map(async adapter => {
                const stream = this._makeStreamingCallback(adapter.name, adapter, {
                    turnId: turnState.turnRecord.turnId,
                    agentId: adapter.id,
                    role: 'executor',
                    prompt
                });

                let resultText = '';
                let status: 'success' | 'error' = 'success';

                try {
                    const agentPrompt = this._taskStateManager.buildDirectExecutorPrompt(
                        turnState.taskState,
                        turnState.turnRecord,
                        prompt,
                        enrichedPrompt
                    );
                    resultText = await adapter.invoke(agentPrompt, 'agent', stream.callback);
                    stream.flush();
                } catch (err: any) {
                    stream.flush();
                    resultText = '**Error:** ' + (err.message || String(err));
                    status = 'error';
                }

                if (this._activeStopReason) {
                    resultText += '\\n\\n**[Stopped by User: ' + this._activeStopReason + ']**';
                    status = 'error';
                }

                let thinking = '';
                let output = resultText;
                if (adapter.extractThinking) {
                    const parsed = adapter.extractThinking(resultText);
                    thinking = parsed.thinking;
                    output = parsed.output;
                } else if (typeof (this as any)._extractThinking === 'function') {
                    const parsed = (this as any)._extractThinking(resultText, adapter);
                    thinking = parsed.thinking;
                    output = parsed.output;
                }

                const record: SessionResponseRecord = {
                    agent: adapter.name,
                    agentId: adapter.id,
                    role: 'executor',
                    prompt: prompt,
                    thinking: thinking,
                    text: resultText,
                    status,
                    failureReason: this._activeStopReason,
                    raw: false,
                };
                sessionResponses.push(record);
                await this._upsertSessionResponse(turnState.turnRecord.turnId, record);

                this._view!.webview.postMessage({
                    type: 'agentDone',
                    agent: record.agent,
                    text: record.text,
                    status: record.status,
                    raw: record.raw
                });
            });

            await Promise.all(promises);

            const outcome = {
                summary: 'Completed.',
                status: sessionResponses.some(r => r.status === 'error') ? 'error' as const : 'success' as const
            };

            await this._taskStateManager.finishTurn(
                this._currentTaskId,
                turnState.turnRecord.turnId,
                sessionResponses,
                outcome
            );

        } catch (globalErr: any) {
            debugLog('Council', 'Global error', globalErr);
        } finally {
            this._postPhaseStart(
                'synthesizer', // End council UI
                [],
                prompt,
                false
            );

            this._runningTaskIds.delete(this._currentTaskId);
            this._activeRunAdapters = [];
            this._currentTaskId = undefined;
            this._activeTurnRef = undefined;
            this._activeStopReason = undefined;
            this._sendCurrentTaskState();
        }
    }

`;

    const deadCodeStart1 = content.lastIndexOf('    /**', inferModeStart);
    content = content.slice(0, deadCodeStart1) + newDelegate + content.slice(endIdx);

    // 1. Remove initialExecutorOptionsHtml
    content = content.replace(/const initialExecutorOptionsHtml[\s\S]*?'';\n/g, '');

    // 2. Remove executor-selector and mode-selector html
    content = content.replace(/\s*<select id="executor-selector"[\s\S]*?<\/select>/, '');
    content = content.replace(/\s*<div id="mode-selector"[\s\S]*?<\/div>/, '');

    fs.writeFileSync('src/providers/ChatViewProvider.ts', content);
}
rewrite();
