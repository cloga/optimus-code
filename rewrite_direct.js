const fs = require("fs");
const file = "src/providers/ChatViewProvider.ts";
let code = fs.readFileSync(file, "utf8");

const startIdx = code.indexOf(`    private async _delegateToCouncil(`);

let endIdx = -1;
let openCount = 0;
let started = false;

for (let i = startIdx; i < code.length; i++) {
    if (code[i] === "{") {
        openCount++;
        started = true;
    } else if (code[i] === "}") {
        openCount--;
        if (started && openCount === 0) {
            endIdx = i;
            break;
        }
    }
}

if (startIdx !== -1 && endIdx !== -1) {
    const newMethod = `    private async _delegateToCouncil(
        prompt: string,
        selectedAgentIds: string[] = [],
        mode?: string, // No longer used, kept for compat
        executorId?: string, // No longer used
        images?: { dataUrl: string; mimeType: string }[],
        referencedTurnSequences?: number[]
    ) {
        if (!this._view) { return; }

        let imageNote = "";
        let storedAttachments: SessionImageAttachment[] = [];
        if (images && images.length > 0) {
            storedAttachments = this._saveImagesToDisk(images);
            imageNote = "\\n\\n[Attached images]\\n" + storedAttachments.map(img => "- " + img.filePath).join("\\n") + "\\n";
        }

        const editorContext = this._getActiveEditorContext();
        const enrichedPrompt = [editorContext, prompt + imageNote].filter(Boolean).join("\\n\\n");

        const turnState = await this._taskStateManager.startTurn({
            taskId: this._currentTaskId,
            prompt,
            selectedAgentIds,
            executorId: "None",
            referencedTurnSequences,
        });

        this._currentTaskId = turnState.taskState.taskId;

        if (this._runningTaskIds.has(this._currentTaskId)) {
            await this._taskStateManager.failTurn(
                this._currentTaskId,
                turnState.turnRecord.turnId,
                "Blocked: another turn is already running for this task."
            );
            this._view.webview.postMessage({ type: "agentDone", agent: "System", text: "A turn is already running for this task. Please wait for it to finish.", status: "error", raw: true });
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
            this._view.webview.postMessage({
                type: "agentDone",
                agent: "System",
                text: "No agents selected or available.",
                status: "error",
                raw: true
            });
            this._runningTaskIds.delete(this._currentTaskId);
            await this._taskStateManager.failTurn(this._currentTaskId, turnState.turnRecord.turnId, "No agents selected");
            this._activeTurnRef = undefined;
            return;
        }

        this._sendCurrentTaskState();

        const agentPromises = selectedAdapters.map(async (adapter) => {
            return adapter.invoke(enrichedPrompt, "agent", this._makeStreamingCallback(adapter.id, this._activeTurnRef?.turnId), turnState.taskState);
        });

        try {
            await Promise.all(agentPromises);
            await this._taskStateManager.completeTurn(this._currentTaskId, turnState.turnRecord.turnId, "Turn completed successfully", "completed");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this._taskStateManager.failTurn(this._currentTaskId, turnState.turnRecord.turnId, errorMessage);

            this._view.webview.postMessage({
                type: "agentDone",
                agent: "System",
                text: "Turn execution failed: " + errorMessage,
                status: "error",
                raw: true
            });
        } finally {
            this._runningTaskIds.delete(this._currentTaskId);
            this._activeTurnRef = undefined;
            this._activeStopReason = undefined;
            this._sendSessionsToUI();
            this._sendCurrentTaskState();
        }
    }`;

    code = code.substring(0, startIdx) + newMethod + code.substring(endIdx + 1);
    fs.writeFileSync(file, code);
    console.log("Success");
} else {
    console.log("Indices not found", startIdx, endIdx);
}
