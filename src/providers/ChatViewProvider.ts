import * as vscode from "vscode";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";
import { SharedTaskStateManager } from "../managers/SharedTaskStateManager";
import { marked } from "marked";
import { debugLog } from "../debugLogger";

/**
 * Thin UI shell for Optimus Code.
 * 
 * The selected CLI agent (Claude / Copilot) handles ALL intelligence:
 * - Context & memory via native session persistence (--continue / --resume)
 * - Tool usage (read, edit, bash, search, etc.) 
 * - Cross-agent delegation via MCP tools (claude_code, copilot_cli)
 * 
 * This provider only does: send prompt → stream output → render.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "optimus-code.chatView";

    // Agents — each wraps a CLI with streaming support
    private readonly agents: Record<string, { adapter: ClaudeCodeAdapter | GitHubCopilotAdapter; label: string; mode: "plan" | "agent" }> = {};

    private isGenerating = false;
    private genStart = 0;
    private streamSeq = 0;
    private currentTaskId?: string;
    private taskQueue: Array<{ text: string, attachments: any[], agentId: string, modelId?: string }> = [];
    private readonly taskStateManager: SharedTaskStateManager;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
    ) {
        this.taskStateManager = new SharedTaskStateManager(context.globalState);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "ask":
                    if (data.text) {
                        if (data.text.startsWith('/steer ')) {
                            this.taskQueue = [];
                            if (this.isGenerating) {
                                Object.values(this.agents).forEach(entry => entry.adapter.stop?.());
                                this.taskQueue.push({
                                    text: data.text.slice(7).trim(),
                                    attachments: data.attachments || [],
                                    agentId: data.agentId || data.agent,
                                    modelId: data.modelId || data.model
                                });
                                webviewView.webview.postMessage({ type: "status", content: "Interrupting for steering..." });
                                return;
                            } else {
                                data.text = data.text.slice(7).trim();
                            }
                        } else if (data.text.startsWith('/delegate ')) {
                            // Automatically wrap it to force a delegation
                            data.text = `[User forced delegation] Please MUST use the \`delegate_task\` tool to complete the following: \n${data.text.slice(10).trim()}`;
                        }
                    }
                    return this.handleAsk(webviewView, data.text, data.agent, data.model);
                case "stop":
                    this.taskQueue = [];
                    Object.values(this.agents).forEach(entry => entry.adapter.stop?.());
                    this.isGenerating = false;
                    webviewView.webview.postMessage({ type: "setGenerating", value: false });
                    return webviewView.webview.postMessage({ type: "status", content: "Stopped." });
                case "newChat":
                    this.isGenerating = false;
                    this.currentTaskId = undefined;
                    webviewView.webview.postMessage({ type: "setGenerating", value: false });
                    webviewView.webview.postMessage({ type: "chatCleared" });
                    return webviewView.webview.postMessage({ type: "status", content: "New session." });
                case "uiDebug":
                    debugLog("ChatView", "Webview debug", JSON.stringify(data.payload || {}));
                    if (data.payload?.kind === "empty-models") {
                        return webviewView.webview.postMessage({
                            type: "status",
                            content: `No models available for ${data.payload.engine || "current engine"}`,
                        });
                    }
                    return;
                case "uiError":
                    debugLog("ChatView", "Webview error", JSON.stringify(data.payload || {}));
                    return webviewView.webview.postMessage({
                        type: "addMessage",
                        role: "system",
                        html: `UI error: ${(data.payload?.message || "unknown error").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`,
                    });
            }
        });
    }

    private getModelListsByEngine(): { claude_code: string[]; copilot_cli: string[] } {
        const config = vscode.workspace.getConfiguration("optimusCode");
        const rawModelsCfg = config.get("models") as any;
        const fallback = {
            claude_code: Array.isArray(rawModelsCfg?.claude_code)
                ? rawModelsCfg.claude_code
                : ["claude-opus-4.6-1m", "gpt-5.4"],
            copilot_cli: Array.isArray(rawModelsCfg?.copilot_cli)
                ? rawModelsCfg.copilot_cli
                : ["gemini-3-pro-preview", "claude-opus-4.6-1m", "gpt-5.4"],
        };

        const rawAgents = config.get<any[]>("agents");
        if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
            return fallback;
        }

        const fromAgents = {
            claude_code: [] as string[],
            copilot_cli: [] as string[],
        };

        for (const agent of rawAgents) {
            if (!agent || agent.enabled === false || typeof agent.model !== "string") {
                continue;
            }
            if (agent.adapter === "claude-code") {
                fromAgents.claude_code.push(agent.model);
            } else if (agent.adapter === "github-copilot") {
                fromAgents.copilot_cli.push(agent.model);
            }
        }

        const dedupe = (items: string[]) => [...new Set(items.filter(item => typeof item === "string" && item.trim().length > 0))];
        const claudeModels = dedupe(fromAgents.claude_code);
        const copilotModels = dedupe(fromAgents.copilot_cli);

        return {
            claude_code: claudeModels.length > 0 ? claudeModels : fallback.claude_code,
            copilot_cli: copilotModels.length > 0 ? copilotModels : fallback.copilot_cli,
        };
    }

    private async handleAsk(wv: vscode.WebviewView, text: string, agentId: string, modelId?: string, skipDisplay?: boolean) {
        // Safety: reset stuck state after 3 min
        if (this.isGenerating && Date.now() - this.genStart > 180_000) {
            this.isGenerating = false;
        }
        
        if (!skipDisplay) {
            let htmlText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            
            if (this.isGenerating) {
                htmlText += " <i>(⏳ Queued)</i>";
                wv.webview.postMessage({ type: "addMessage", role: "user", html: htmlText });
                
                this.taskQueue.push({ text, attachments: [], agentId, modelId });
                wv.webview.postMessage({ type: "status", content: `Queued (${this.taskQueue.length} ahead).` });
                return;
            }
            
            wv.webview.postMessage({ type: "addMessage", role: "user", html: htmlText });
        }

        this.isGenerating = true;
        this.genStart = Date.now();
        wv.webview.postMessage({ type: "setGenerating", value: true });

        try {
            // Lazy load adapters
            const cacheKey = `${agentId}:${modelId || ""}`;
            let entry = this.agents[cacheKey];
            
            if (!entry) {
                if (agentId === "copilot_cli") {
                    entry = {
                        adapter: new GitHubCopilotAdapter("copilot", "GitHub Copilot CLI", modelId || ""),
                        label: "GitHub Copilot",
                        mode: "agent"
                    };
                } else if (agentId === "claude_code") {
                    entry = {
                        adapter: new ClaudeCodeAdapter("claude", "Claude Code", modelId || ""),
                        label: "Claude Code",
                        mode: "agent"
                    };
                } else {
                    wv.webview.postMessage({ type: "addMessage", role: "system", html: `Unknown agent: ${agentId}` });
                    return;
                }
                this.agents[cacheKey] = entry;
            }

            const { taskState, turnRecord } = await this.taskStateManager.startTurn({
                taskId: this.currentTaskId,
                prompt: text,
                selectedAgentIds: [cacheKey],
                executorId: agentId,
            });
            this.currentTaskId = taskState.taskId;

            const orchestratorPrompt = this.taskStateManager.buildDirectExecutorPrompt(
                taskState,
                turnRecord,
                text,
                [
                    'You are the MAIN ORCHESTRATOR for this Optimus Code sidebar session.',
                    'Do not default to doing all substantive implementation work yourself.',
                    'For any non-trivial feature, architectural work, multi-file change, PRD, breakdown, testing pass, or review workflow, use the delegate_task tool and route work to the proper specialized role.',
                    'Use role_prompt values exactly from the roster: pm, architect, dev, qa.',
                    'Keep the main agent focused on coordination, synthesis, routing, and acceptance.',
                    'Only skip delegation when the user request is obviously trivial and can be completed safely in one short direct step.'
                ].join('\n')
            );

            // Create streaming placeholder
            const sid = ++this.streamSeq;
            wv.webview.postMessage({ type: "streamStart", id: sid, role: agentId, input: orchestratorPrompt });
            wv.webview.postMessage({ type: "status", content: `${entry.label} is working...` });

            const onUpdate = (chunk: string) => {
                wv.webview.postMessage({ type: "streamUpdate", id: sid, text: chunk });
            };

            // Let the CLI agent handle everything: context, tools, memory
            // We pass taskState.cliSessionId as the CLI's session-id so it naturally resumes history
            const reply = await entry.adapter.invoke(orchestratorPrompt, entry.mode, taskState.cliSessionId, onUpdate) || "No reply.";

            this.persistMemoryUpdates(reply);

            // Clean trace lines for final display
            const clean = this.cleanForDisplay(this.stripControlTags(reply));
            await this.taskStateManager.completeTurn(taskState.taskId, turnRecord.turnId, {
                plannerContributions: [],
                executorOutcome: {
                    agentId,
                    agentName: entry.label,
                    status: "success",
                    summary: this.buildTurnSummary(reply, clean),
                    rawText: reply,
                    timestamp: Date.now(),
                    debug: entry.adapter.lastDebugInfo
                        ? {
                            command: entry.adapter.lastDebugInfo.command,
                            cwd: entry.adapter.lastDebugInfo.cwd,
                            pid: entry.adapter.lastDebugInfo.pid,
                            duration: entry.adapter.lastDebugInfo.endTime && entry.adapter.lastDebugInfo.startTime
                                ? entry.adapter.lastDebugInfo.endTime - entry.adapter.lastDebugInfo.startTime
                                : undefined,
                            promptTransport: entry.adapter.lastDebugInfo.promptTransport,
                            promptFilePath: entry.adapter.lastDebugInfo.promptFilePath,
                            originalPromptLength: entry.adapter.lastDebugInfo.originalPromptLength,
                            sentPromptLength: entry.adapter.lastDebugInfo.sentPromptLength,
                            promptFileThreshold: entry.adapter.lastDebugInfo.promptFileThreshold,
                        }
                        : undefined,
                },
            });
            wv.webview.postMessage({ type: "streamEnd", id: sid, role: agentId, html: await marked.parse(clean) });

        } catch (e: any) {
            if (this.currentTaskId) {
                await this.taskStateManager.failTurn(this.currentTaskId, this.taskStateManager.getTask(this.currentTaskId)?.turnHistory.slice(-1)[0]?.turnId || "", String(e?.message || e));
            }
            wv.webview.postMessage({ type: "addMessage", role: "system", html: "Error: " + (e.message || e) });
        } finally {
            this.isGenerating = false;
            
            if (this.taskQueue.length > 0) {
                wv.webview.postMessage({ type: "status", content: `Starting next task... (${this.taskQueue.length} left)` });
                const next = this.taskQueue.shift();
                if (next) {
                    setTimeout(() => {
                        this.handleAsk(wv, next.text, next.agentId, next.modelId, true);
                    }, 500);
                }
            } else {
                wv.webview.postMessage({ type: "status", content: "Idle" });
                wv.webview.postMessage({ type: "setGenerating", value: false });
            }
        }
    }

    private buildTurnSummary(raw: string, clean: string): string {
        const tagged = this.extractTaggedContent(raw, 'task-summary')[0];
        if (tagged) {
            return tagged;
        }
        const normalized = clean.replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return 'No executor summary was produced.';
        }
        return normalized.length > 220 ? normalized.slice(0, 217) + '...' : normalized;
    }

    private stripControlTags(raw: string): string {
        return raw
            .replace(/<task-summary>[\s\S]*?<\/task-summary>/gi, '')
            .replace(/<memory-update>[\s\S]*?<\/memory-update>/gi, '')
            .trim();
    }

    private extractTaggedContent(raw: string, tagName: string): string[] {
        const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
        const matches: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(raw)) !== null) {
            const value = match[1]?.trim();
            if (value) {
                matches.push(value);
            }
        }
        return matches;
    }

    private persistMemoryUpdates(raw: string): void {
        const updates = this.extractTaggedContent(raw, 'memory-update');
        if (updates.length === 0) {
            return;
        }

        const existing = this.taskStateManager.readMemoryMd()?.trim() || '';
        const merged = [...new Set([
            ...existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
            ...updates.map(update => update.trim()).filter(Boolean),
        ])].join('\n');

        if (merged && merged !== existing) {
            this.taskStateManager.writeMemoryMd(merged + '\n');
        }
    }

    /** Strip process trace lines, keep only meaningful output */
    private cleanForDisplay(raw: string): string {
        return raw
            .split(/\r?\n/)
            .filter(line => {
                const t = line.trim();
                if (!t) { return true; }
                if (/^[\u2022\u25CF\u23FA\u25B6\u2192\u2713\u2717\u21B3\u2514\u2502\u251C]/.test(t)) { return false; }
                if (/^(result|command|description|file_path|path|stdout|preview)=/i.test(t)) { return false; }
                return true;
            })
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    private getHtml() {
        const { claude_code: claudeModels, copilot_cli: copilotModels } = this.getModelListsByEngine();
        const serializedModelsByEngine = JSON.stringify({
            claude_code: claudeModels,
            copilot_cli: copilotModels,
        });

        return String.raw/*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground);
       display: flex; flex-direction: column; height: 100vh; margin: 0; }
#chat { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
.msg { padding: 10px; border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); word-wrap: break-word; overflow-x: hidden; }
.msg.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 80%; }
.msg.user p { margin: 0; }
.msg.claude-opus, .msg.claude_code { border-left: 4px solid #D2691E; }
.msg.claude-sonnet { border-left: 4px solid #8A2BE2; }
.msg.copilot, .msg.copilot_cli { border-left: 4px solid #1f6feb; }
.msg.system { font-style: italic; color: var(--vscode-descriptionForeground); font-size: .9em; background: transparent; text-align: center; }
.msg pre { background: var(--vscode-editor-background); padding: 8px; border-radius: 4px; overflow-x: auto; }
.msg code { font-family: var(--vscode-editor-font-family); font-size: .9em; color: var(--vscode-textPreformat-foreground); }

/* Stream Box with Tabs */
.stream-box { border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); overflow: hidden; display: flex; flex-direction: column; }
.stream-box.claude-opus, .stream-box.claude_code { border-left: 4px solid #D2691E; }
.stream-box.claude-sonnet { border-left: 4px solid #8A2BE2; }
.stream-box.copilot, .stream-box.copilot_cli { border-left: 4px solid #1f6feb; }

.stream-header { display: flex; align-items: center; padding: 6px 10px; background: rgba(0,0,0,0.1); border-bottom: 1px solid var(--vscode-panel-border); }
.stream-title { font-weight: bold; font-size: 0.9em; flex: 1; }
.stream-meta { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 0.8em; }
.stream-state { text-transform: uppercase; letter-spacing: 0.04em; }
.stream-duration { font-variant-numeric: tabular-nums; }
.stream-tabs { display: flex; gap: 2px; }
.tab-btn { background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px; font-size: 0.85em; border-radius: 3px; }
.tab-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.tab-btn.active { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-weight: 500; }

.stream-content { padding: 10px; font-size: .9em; overflow-y: auto; max-height: 600px; }
.tab-pane { display: none; }
.tab-pane.active { display: block; }
.stream-live { display: flex; flex-direction: column; gap: 10px; }
.stream-section { padding: 10px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid var(--vscode-panel-border); }
.stream-section-title { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.stream-empty { color: var(--vscode-descriptionForeground); }
.collapsible-section { margin-top: 8px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
.collapsible-section summary { cursor: pointer; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); user-select: none; outline: none; }
.collapsible-section summary:hover { color: var(--vscode-foreground); }
.collapsible-section[open] summary { margin-bottom: 8px; }
.phase-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.phase-pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: rgba(255,255,255,0.02); font-size: 0.82em; }
.phase-pill.active { color: var(--vscode-foreground); border-color: var(--vscode-textLink-foreground); background: rgba(31, 111, 235, 0.12); }
.phase-pill.done { color: var(--vscode-foreground); border-color: rgba(63, 185, 80, 0.5); background: rgba(63, 185, 80, 0.12); }
.phase-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.7; }
.final-answer { margin-top: 10px; }
.final-answer[hidden] { display: none; }
.final-answer-card { padding: 12px; border-radius: 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
.reasoning-view { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 0.85em; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.debug-details { margin-top: 10px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
.debug-details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 0.85em; user-select: none; }
.debug-details summary:hover { color: var(--vscode-foreground); }
.detail-block { margin-top: 8px; padding: 10px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid var(--vscode-panel-border); }
.detail-block + .detail-block { margin-top: 8px; }

/* Trace View */
.step-list { display: flex; flex-direction: column; gap: 1px; }
.step { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; font-size: .9em; line-height: 1.4; }
.step-dot { flex: none; margin-top: 5px; width: 8px; height: 8px; border-radius: 50%; }
.step-dot-run  { background: var(--vscode-textLink-foreground); animation: pulse 1s ease-in-out infinite; }
.step-dot-done { background: #3fb950; }
.step-dot-err  { background: #f85149; }
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
.step-text { flex: 1; min-width: 0; }
.step-name { font-weight: 600; color: var(--vscode-foreground); }
.step-name.delegate-step { color: #d29922; }
.step-detail { color: var(--vscode-descriptionForeground); font-size: .85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.step-result-text { color: var(--vscode-descriptionForeground); font-size: .85em; font-style: italic; display: block; }
.delegate-banner { margin-bottom: 8px; padding: 6px 8px; border-radius: 4px; background: rgba(210, 153, 34, 0.15); color: var(--vscode-foreground); font-size: 0.85em; font-weight: 600; }
.delegate-stack { display: flex; flex-direction: column; gap: 8px; }
.delegate-card { padding: 10px; border-radius: 8px; border: 1px solid rgba(210, 153, 34, 0.35); background: rgba(210, 153, 34, 0.08); }
.delegate-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.delegate-title { font-weight: 600; color: var(--vscode-foreground); }
.delegate-badge { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; color: #d29922; }
.delegate-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.delegate-field { padding: 8px; border-radius: 6px; background: rgba(255,255,255,0.04); border: 1px solid var(--vscode-panel-border); }
.delegate-label { display: block; font-size: 0.76em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.delegate-value { display: block; font-size: 0.88em; color: var(--vscode-foreground); word-break: break-word; }
.delegate-result { margin-top: 8px; padding: 8px; border-radius: 6px; background: rgba(255,255,255,0.04); border: 1px solid var(--vscode-panel-border); }

/* Log View */
.log-view { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-textPreformat-foreground); }

/* Input View */
.input-view { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-textPreformat-foreground); overflow-wrap: break-word; }

/* Output View */
.output-view { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: .9em; line-height: 1.5; color: var(--vscode-foreground); }

@keyframes spin { to { transform: rotate(360deg); } }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: var(--vscode-textLink-foreground); border-radius: 50%; animation: spin .6s linear infinite; vertical-align: middle; margin-right: 4px; }

.header { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
select, button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.stop { background: var(--vscode-errorForeground); color: #fff; }
#status { font-size: .85em; color: var(--vscode-textLink-activeForeground); min-height: 20px; font-weight: bold; }
#input-area { flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; padding-bottom: 16px; }
textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; min-height: 60px; resize: vertical; font-family: inherit; }

  #input-area { position: relative; } /* Added for slash menu anchor */
  #slash-menu {
      display: none;
      position: absolute;
      bottom: calc(100% - 10px);
      left: 0;
      right: 0;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-bottom: 8px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 100;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  }
  .slash-item {
      padding: 8px 12px;
      cursor: pointer;
      font-size: 0.9em;
      display: flex;
      justify-content: space-between;
      border-left: 3px solid transparent;
  }
  .slash-item:hover, .slash-item.selected {
      background: var(--vscode-list-hoverBackground);
      border-left-color: var(--vscode-textLink-foreground);
  }
  .slash-label {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
  }
  .slash-desc {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
  }

  .hint { font-size: .8em; color: var(--vscode-descriptionForeground); }
.btns { display: flex; gap: 8px; }
.btns button { flex: 1; }
.idle-only { display: inline-flex; }
.gen-only  { display: none; }
body.generating .idle-only { display: inline-flex; opacity: 0.6; } /* Allow queueing */
body.generating .gen-only  { display: inline-flex; }
</style>
</head>
<body id="root">
    <div class="header">
        <select id="engine" onchange="updateModels()">
            <option value="copilot_cli" selected>GitHub Copilot</option>
            <option value="claude_code">Claude Code</option>
        </select>
        <select id="model">
        </select>
        <button onclick="doNew()" class="sec">+ New</button>
    </div>
    <div id="status">Idle</div>
    <div id="chat"></div>
    <div id="input-area">
        <div id="slash-menu"></div>
        <textarea id="prompt" placeholder="Message..." onkeydown="handleKey(event)"></textarea>
        <div class="hint">Enter to Send &middot; Shift+Enter newline</div>
        <div class="btns">
            <button onclick="doSend()" class="idle-only">Send</button>
            <button onclick="doStop()" class="gen-only stop">Stop</button>
        </div>
    </div>
<script>
var vscode = acquireVsCodeApi();
var chat = document.getElementById("chat");
var statusEls = document.getElementById("status");
var engineSelect = document.getElementById("engine");
var modelSelect = document.getElementById("model");
function postUiDebug(kind, payload) {
    vscode.postMessage({ type: "uiDebug", payload: Object.assign({ kind: kind }, payload || {}) });
}

window.addEventListener("error", function(event) {
    vscode.postMessage({
        type: "uiError",
        payload: {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error && event.error.stack ? String(event.error.stack) : ""
        }
    });
});

window.addEventListener("unhandledrejection", function(event) {
    vscode.postMessage({
        type: "uiError",
        payload: {
            message: event.reason && event.reason.message ? String(event.reason.message) : String(event.reason),
            stack: event.reason && event.reason.stack ? String(event.reason.stack) : ""
        }
    });
});

const defaultEngine = "copilot_cli";
const defaultModelByEngine = {
    "copilot_cli": "gemini-3-pro-preview",
    "claude_code": "claude-opus-4.6-1m"
};

const rawModelsByEngine = ${serializedModelsByEngine};

function normalizeModelOptions(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(function(item) { return typeof item === 'string' && item.trim().length > 0; })
        .map(function(item) { return { value: item, label: item }; });
}

const modelsByEngine = {
    "claude_code": normalizeModelOptions(rawModelsByEngine.claude_code),
    "copilot_cli": normalizeModelOptions(rawModelsByEngine.copilot_cli)
};

function updateModels() {
    const engine = engineSelect.value;
    const models = modelsByEngine[engine] || [];
    const preferredModel = defaultModelByEngine[engine];
    modelSelect.innerHTML = '';
    modelSelect.disabled = models.length === 0;
    for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
    }
    if (preferredModel && models.some(m => m.value === preferredModel)) {
        modelSelect.value = preferredModel;
    } else if (models.length > 0) {
        modelSelect.value = models[0].value;
    }
    postUiDebug(models.length === 0 ? "empty-models" : "models-loaded", {
        engine: engine,
        selectedModel: modelSelect.value || "",
        availableModels: models.map(function(m) { return m.value; }),
        counts: {
            copilot_cli: (modelsByEngine.copilot_cli || []).length,
            claude_code: (modelsByEngine.claude_code || []).length,
        }
    });
}
engineSelect.value = defaultEngine;
updateModels();

let sessionLocked = false;
function lockEngine(locked) {
    sessionLocked = locked;
    engineSelect.disabled = locked;
    if(locked) {
        engineSelect.style.opacity = '0.6';
        engineSelect.title = "Engine type is locked for the current session. Start a new session to switch engines.";
    } else {
        engineSelect.style.opacity = '1';
        engineSelect.title = "";
    }
}
var ta = document.getElementById("prompt");
var root = document.getElementById("root");
var labels = { "claude_code": "Claude Code", "copilot_cli": "GitHub Copilot" };
var streamDivs = {};
var streamTimers = {};
var streamStates = {};
var streamStartedAt = {};

function clearStreamTimer(id) {
    var timer = streamTimers[id];
    if (timer) {
        clearTimeout(timer);
        delete streamTimers[id];
    }
}

function formatDuration(ms) {
    if (!ms || ms < 1000) return '<1s';
    return (ms / 1000).toFixed(1) + 's';
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function inferPhaseState(traceHtml, reasoningRaw, out, isCompleted) {
    var hasTrace = !!traceHtml && traceHtml.indexOf('Waiting for steps...') === -1;
    var hasReasoning = !!reasoningRaw;
    var hasOutput = !!out;

    var activePhase = 'Preparing';
    if (hasOutput) {
        activePhase = isCompleted ? 'Completed' : 'Generating answer';
    } else if (hasTrace) {
        activePhase = 'Using tools';
    } else if (hasReasoning) {
        activePhase = 'Reasoning';
    }

    return {
        activeLabel: activePhase,
        phases: [
            { label: 'Preparing', state: hasTrace || hasReasoning || hasOutput || isCompleted ? 'done' : 'active' },
            { label: 'Using tools', state: hasTrace ? (hasOutput || isCompleted ? 'done' : 'active') : 'idle' },
            { label: 'Generating answer', state: hasOutput ? (isCompleted ? 'done' : 'active') : 'idle' }
        ]
    };
}

function renderPhaseStrip(phaseState) {
    return '<div class="phase-strip">' + phaseState.phases.map(function(phase) {
        var cls = 'phase-pill';
        if (phase.state === 'active') cls += ' active';
        if (phase.state === 'done') cls += ' done';
        return '<div class="' + cls + '"><span class="phase-dot"></span><span>' + escapeHtml(phase.label) + '</span></div>';
    }).join('') + '</div>';
}

function extractDelegateValue(detail, key) {
    if (!detail) return '';
    var escapedKey = key.replace(/[.*+?^()|[\]\\]/g, '\\$&');
    var pattern = new RegExp('(?:^|, )' + escapedKey + '=([^,]+)');
    var match = pattern.exec(detail);
    return match ? match[1].trim() : '';
}

function renderDelegateCards(steps) {
    var delegateSteps = steps.filter(function(step) { return /\bdelegate_task\b/i.test(step.name); });
    if (delegateSteps.length === 0) {
        return '';
    }

    var cards = delegateSteps.map(function(step, index) {
        var role = extractDelegateValue(step.detail, 'role_prompt');
        var engine = extractDelegateValue(step.detail, 'engine');
        var model = extractDelegateValue(step.detail, 'model');
        var instruction = extractDelegateValue(step.detail, 'instruction') || step.detail || 'No delegation instruction captured.';
        var result = step.result ? step.result.replace(/^result=/i, '').trim() : 'Worker still running...';
        var status = step.done === "\u2713" ? 'Completed' : step.done === "\u2717" ? 'Failed' : 'Running';

        return '<div class="delegate-card">'
            + '<div class="delegate-header"><span class="delegate-title">Delegated task ' + String(index + 1) + '</span><span class="delegate-badge">' + escapeHtml(status) + '</span></div>'
            + '<div class="delegate-grid">'
            + '<div class="delegate-field"><span class="delegate-label">Role</span><span class="delegate-value">' + escapeHtml(role || 'Not specified') + '</span></div>'
            + '<div class="delegate-field"><span class="delegate-label">Engine</span><span class="delegate-value">' + escapeHtml(engine || 'Default') + '</span></div>'
            + '<div class="delegate-field"><span class="delegate-label">Model</span><span class="delegate-value">' + escapeHtml(model || 'Default') + '</span></div>'
            + '</div>'
            + '<div class="delegate-result"><span class="delegate-label">Instruction</span><span class="delegate-value">' + escapeHtml(instruction) + '</span></div>'
            + '<div class="delegate-result"><span class="delegate-label">Worker Result</span><span class="delegate-value">' + escapeHtml(result) + '</span></div>'
            + '</div>';
    }).join('');

    return '<div class="delegate-stack">' + cards + '</div>';
}

function scheduleSlowStartHint(id) {
    clearStreamTimer(id);
    streamTimers[id] = setTimeout(function() {
        var t = streamDivs[id];
        if (t) {
             var livePane = t.querySelector('.stream-live');
             if (livePane) {
                livePane.innerHTML = '<div class="stream-section stream-empty">Still starting. The first response from the CLI can take 5-15 seconds.</div>';
             }
        }
    }, 2500);
}

function doSend() {
    var text = ta.value ? ta.value.trim() : "";
    if (!text) return;
    
    // Lock engine
    lockEngine(true);
    
    statusEls.textContent = "Sending...";
    vscode.postMessage({ 
        type: "ask", 
        text: text, 
        agent: engineSelect.value, 
        model: modelSelect.value 
    });
    ta.value = "";
}
function doStop() { vscode.postMessage({ type: "stop" }); }
function doNew() { 
    chat.innerHTML = ""; 
    lockEngine(false);
    vscode.postMessage({ type: "newChat" }); 
}
function handleKey(e) {
      if (document.getElementById("slash-menu").style.display === "block") {
          var items = document.querySelectorAll(".slash-item");
          var selectedIndex = -1;
          items.forEach((item, index) => {
              if (item.classList.contains("selected")) selectedIndex = index;
          });
          
          if (e.key === "ArrowDown") {
              e.preventDefault();
              if (selectedIndex >= 0) items[selectedIndex].classList.remove("selected");
              selectedIndex = (selectedIndex + 1) % items.length;
              items[selectedIndex].classList.add("selected");
              items[selectedIndex].scrollIntoView({block: "nearest"});
              return;
          } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (selectedIndex >= 0) items[selectedIndex].classList.remove("selected");
              selectedIndex = (selectedIndex - 1 + items.length) % items.length;
              items[selectedIndex].classList.add("selected");
              items[selectedIndex].scrollIntoView({block: "nearest"});
              return;
          } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (selectedIndex >= 0) {
                  items[selectedIndex].click();
                  return;
              }
          } else if (e.key === "Escape") {
              e.preventDefault();
              closeSlashMenu();
              return;
          }
      }
      
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  }
  
  var ta = document.getElementById("prompt");
  ta.addEventListener("input", function() {
      var val = ta.value;
      if (val.startsWith("/")) {
          var query = val.slice(1).toLowerCase();
          showSlashMenu(query);
      } else {
          closeSlashMenu();
      }
  });
  
  var builtinCommands = [
      { cmd: "delegate", desc: "Force the orchestrator to delegate this task to a sub-agent" },
      { cmd: "steer", desc: "Interrupt and steer the current agent" },
      { cmd: "new", desc: "Start a new chat session" },
      { cmd: "stop", desc: "Stop the current generation" },
      { cmd: "clear", desc: "Clear chat history (same as /new)" }
  ];
  
  function showSlashMenu(query) {
      var menu = document.getElementById("slash-menu");
      var filtered = builtinCommands.filter(c => c.cmd.startsWith(query));
      
      if (filtered.length === 0) {
          closeSlashMenu();
          return;
      }
      
      menu.innerHTML = "";
      filtered.forEach((c, i) => {
          var div = document.createElement("div");
          div.className = "slash-item" + (i === 0 ? " selected" : "");
          div.innerHTML = "<span class='slash-label'>/" + c.cmd + "</span> <span class='slash-desc'>" + c.desc + "</span>";
          div.onclick = function() {
              if (c.cmd === "new" || c.cmd === "clear") {
                  doNew();
              } else if (c.cmd === "stop") {
                  doStop();
                  ta.value = "";
              } else {
                  ta.value = "/" + c.cmd + " ";
                  ta.focus();
              }
              closeSlashMenu();
          };
          menu.appendChild(div);
      });
      menu.style.display = "block";
  }
  
  function closeSlashMenu() {
      document.getElementById("slash-menu").style.display = "none";
  }

function switchTab(streamId, tabName) {
    var box = document.getElementById("stream-" + streamId);
    if(!box) return;
    var tabs = box.querySelectorAll('.tab-btn');
    var panes = box.querySelectorAll('.tab-pane');
    
    tabs.forEach(t => t.classList.remove('active'));
    panes.forEach(p => p.classList.remove('active'));
    
    var btn = box.querySelector('.tab-btn[data-tab="' + tabName + '"]');
    var pane = box.querySelector('.tab-pane.' + tabName);
    
    if(btn) btn.classList.add('active');
    if(pane) pane.classList.add('active');
}

function renderStreamText(raw, container) {
    var traceMatch = /<optimus-trace>\s*([\s\S]*?)\s*<\/optimus-trace>/i.exec(raw);
    var reasoningMatch = /<optimus-reasoning>\s*([\s\S]*?)\s*<\/optimus-reasoning>/i.exec(raw);
    var outputMatch = /<optimus-output>\s*([\s\S]*?)\s*<\/optimus-output>/i.exec(raw);
    var traceRaw = traceMatch ? traceMatch[1].trim() : raw;
    var reasoningRaw = reasoningMatch ? reasoningMatch[1].trim() : "";
    var outputRaw = outputMatch ? outputMatch[1].trim() : "";
    var NL = String.fromCharCode(10);
    var lines = traceRaw.split(NL);
    var steps = [];
    var outputLines = [];
    var cur = null;
    var sawDelegateTask = false;

    function shortPath(s) { var m = /[/\\\\]([^/\\\\]+)$/.exec(s); return m ? m[1] : s; }
    function summarize(d) {
        return d.replace(/\\s+/g, " ").trim().replace(/(?:file_path|path|filepath|relative_workspace_path)=([^,]+)/gi, function(_, v) { return shortPath(v.trim()); });
    }
    function flush() { if (cur) { steps.push(cur); cur = null; } }

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var tm = /^[\\u2022\\u25CF\\u23FA\\u25B6\\u2192]\\s*(.+)$/.exec(line);
        if (tm) {
            flush();
            cur = { name: tm[1].trim(), detail: "", done: null, result: "" };
            if (/\bdelegate_task\b/i.test(cur.name)) { sawDelegateTask = true; }
            continue;
        }
        var dm = /^([\\u2713\\u2717])\\s*(.*)$/.exec(line);
        if (dm) {
            if (cur && (!dm[2] || cur.name === dm[2].trim())) { cur.done = dm[1]; }
            else {
                flush();
                cur = { name: dm[2].trim() || "tool", detail: "", done: dm[1], result: "" };
                if (/\bdelegate_task\b/i.test(cur.name)) { sawDelegateTask = true; }
            }
            continue;
        }
        var det = /^\\u21B3\\s*(.+)$/.exec(line);
        if (det && cur) { if (cur.done) { cur.result = summarize(det[1]); } else { cur.detail = summarize(det[1]); } continue; }
        flush();
        outputLines.push(line);
    }
    flush();

    // Render Trace
    var traceHtml = "";
    var delegateCardsHtml = renderDelegateCards(steps);
    if (steps.length > 0) {
        if (sawDelegateTask) {
            traceHtml += '<div class="delegate-banner">Delegation detected: master agent called delegate_task.</div>';
            if (delegateCardsHtml) {
                traceHtml += delegateCardsHtml;
            }
        }
        traceHtml += '<div class="step-list">';
        for (var s = 0; s < steps.length; s++) {
            var st = steps[s];
            var dc = st.done === "\\u2713" ? "step-dot-done" : st.done === "\\u2717" ? "step-dot-err" : "step-dot-run";
            var stepNameClass = /\bdelegate_task\b/i.test(st.name) ? 'step-name delegate-step' : 'step-name';
            traceHtml += '<div class="step"><div class="step-dot ' + dc + '"></div><div class="step-text">';
            traceHtml += '<span class="' + stepNameClass + '">' + escapeHtml(st.name) + '</span>';
            if (st.detail) traceHtml += '<span class="step-detail">' + escapeHtml(st.detail) + '</span>';
            if (st.result) traceHtml += '<span class="step-result-text">' + escapeHtml(st.result) + '</span>';
            traceHtml += '</div></div>';
        }
        traceHtml += '</div>';
    } else {
        traceHtml = '<span style="color:var(--vscode-descriptionForeground)">Waiting for steps...</span>';
    }
    
    // Update Trace Pane
    var tracePane = container.querySelector('.tab-pane.trace');
    if(tracePane) tracePane.innerHTML = traceHtml;
    
    // Update Log Pane
    var logPane = container.querySelector('.tab-pane.log');
    if(logPane) {
         logPane.querySelector('div').textContent = raw;
    }

        var reasoningPane = container.querySelector('.tab-pane.reasoning');
        if (reasoningPane) {
            reasoningPane.querySelector('div').textContent = reasoningRaw || "Waiting for reasoning...";
        }
    
    // Update Output Pane (Preview)
        var out = outputRaw || outputLines.join(NL).trim();
        var liveHtml = '';
        var phaseState = inferPhaseState(traceHtml, reasoningRaw, out, false);

        liveHtml += '<div class="stream-section"><div class="stream-section-title">Progress</div>' + renderPhaseStrip(phaseState) + '</div>';

        if (traceHtml && traceHtml.indexOf('Waiting for steps...') === -1) {
            liveHtml += '<div class="stream-section"><div class="stream-section-title">Working</div>' + traceHtml + '</div>';
        }

        if (reasoningRaw) {
            liveHtml += '<div class="stream-section"><div class="stream-section-title">Reasoning</div><div class="reasoning-view">' + escapeHtml(reasoningRaw) + '</div></div>';
        }

        if (out) {
            liveHtml += '<div class="stream-section"><div class="stream-section-title">Draft output</div><div class="output-view">' + escapeHtml(out) + '</div></div>';
        }

        if (!liveHtml) {
            liveHtml = '<div class="stream-section stream-empty">Waiting for the first meaningful update...</div>';
        }

        var livePane = container.querySelector('.stream-live');
        if (livePane) {
            livePane.innerHTML = liveHtml;
        }

        var detailsPane = container.querySelector('.debug-details');
        if (detailsPane) {
            var traceDetail = detailsPane.querySelector('.detail-trace');
            var reasoningDetail = detailsPane.querySelector('.detail-reasoning');
            var logDetail = detailsPane.querySelector('.detail-log');
            if (traceDetail) traceDetail.innerHTML = traceHtml;
            if (reasoningDetail) reasoningDetail.textContent = reasoningRaw || 'No reasoning captured yet.';
            if (logDetail) logDetail.textContent = raw;
        }

        streamStates[container.dataset.streamId] = {
            raw: raw,
            traceHtml: traceHtml,
            reasoningRaw: reasoningRaw,
            outputRaw: out,
            phaseLabel: phaseState.activeLabel
        };
    
    return traceHtml; // Return trace for summary if needed
}

window.addEventListener("message", function(event) {
    var msg = event.data;
    if (msg.type === "addMessage") {
        var div = document.createElement("div");
        div.className = "msg " + msg.role;
        if (labels[msg.role]) { var h = document.createElement("strong"); h.textContent = labels[msg.role]; div.appendChild(h); }
        var c = document.createElement("div"); c.innerHTML = msg.html; div.appendChild(c);
        chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
    } else if (msg.type === "streamStart") {
        var div = document.createElement("div");
        div.className = "stream-box " + msg.role;
        div.id = "stream-" + msg.id;
        streamStartedAt[msg.id] = Date.now();
        
        // Header with Tabs
        var header = document.createElement("div");
        header.className = "stream-header";
        
        var title = document.createElement("div");
        title.className = "stream-title";
        title.innerHTML = '<span class="spinner"></span>' + (labels[msg.role] || msg.role);
        header.appendChild(title);

        var meta = document.createElement("div");
        meta.className = "stream-meta";
        meta.innerHTML = '<span class="stream-state">Working</span><span class="stream-duration">just now</span>';
        header.appendChild(meta);
        div.appendChild(header);
        
        var ct = document.createElement("div"); 
        ct.className = "stream-content";
        ct.dataset.streamId = String(msg.id);
        ct.innerHTML = ''
            + '<div class="final-answer" hidden></div>'
            + '<details class="collapsible-section section-input">'
            + '    <summary>Input</summary>'
            + '    <div class="input-view">' + escapeHtml(msg.input || "") + '</div>'
            + '</details>'
            + '<details class="collapsible-section section-progress" open>'
            + '    <summary>Progress</summary>'
            + '    <div class="stream-live"><div class="stream-section stream-empty">Starting CLI session...</div></div>'
            + '</details>'
            + '<details class="debug-details">'
            + '    <summary>Details</summary>'
            + '    <div class="detail-block"><div class="stream-section-title">Trace</div><div class="detail-trace"></div></div>'
            + '    <div class="detail-block"><div class="stream-section-title">Reasoning</div><div class="reasoning-view detail-reasoning">No reasoning captured yet.</div></div>'
            + '    <div class="detail-block"><div class="stream-section-title">Raw stream</div><div class="log-view detail-log"></div></div>'
            + '</details>';
        div.appendChild(ct);
        
        chat.appendChild(div); 
        streamDivs[msg.id] = ct;
        scheduleSlowStartHint(msg.id);
        chat.scrollTop = chat.scrollHeight;
        
    } else if (msg.type === "streamUpdate") {
        clearStreamTimer(msg.id);
        var t = streamDivs[msg.id]; 
        if (t) { 
            renderStreamText(msg.text, t); 
            var box = document.getElementById("stream-" + msg.id);
            if (box) {
                var meta = box.querySelector('.stream-meta');
                if (meta) {
                    var current = streamStates[msg.id];
                    var label = current && current.phaseLabel ? current.phaseLabel : 'Working';
                    meta.innerHTML = '<span class="stream-state">' + escapeHtml(label) + '</span><span class="stream-duration">' + formatDuration(Date.now() - streamStartedAt[msg.id]) + '</span>';
                }
            }
            // Auto-scroll logic if needed
        }
    } else if (msg.type === "streamEnd") {
        clearStreamTimer(msg.id);
        var box = document.getElementById("stream-" + msg.id);
        if (box) {
            // Stop spinner
            var title = box.querySelector(".stream-title");
            if(title) title.innerHTML = (labels[msg.role] || msg.role) + " (Done)";
            var meta = box.querySelector('.stream-meta');
            if (meta) {
                meta.innerHTML = '<span class="stream-state">Completed</span><span class="stream-duration">' + formatDuration(Date.now() - streamStartedAt[msg.id]) + '</span>';
            }

            var content = box.querySelector('.stream-content');
            var finalState = content && streamStates[msg.id]
                ? inferPhaseState(streamStates[msg.id].traceHtml || '', streamStates[msg.id].reasoningRaw || '', streamStates[msg.id].outputRaw || '', true)
                : null;
            if (content && finalState) {
                var livePane = content.querySelector('.stream-live');
                if (livePane) {
                    var currentLive = livePane.innerHTML;
                    currentLive = currentLive.replace(/<div class="stream-section"><div class="stream-section-title">Progress<\/div>[\s\S]*?<\/div>/, '<div class="stream-section"><div class="stream-section-title">Progress</div>' + renderPhaseStrip(finalState) + '</div>');
                    livePane.innerHTML = currentLive;
                }
            }
            
            if(msg.html) {
                var finalPane = box.querySelector('.final-answer');
                if (finalPane) {
                    finalPane.hidden = false;
                    finalPane.innerHTML = '<div class="final-answer-card"><div class="stream-section-title">Final answer</div>' + msg.html + '</div>';
                }
                var prog = box.querySelector('.section-progress');
                if(prog) prog.removeAttribute('open');
            }
            
            delete streamDivs[msg.id];
            delete streamStartedAt[msg.id];
            delete streamStates[msg.id];
        }
    } else if (msg.type === "status") { statusEls.textContent = msg.content; }
    else if (msg.type === "setGenerating") { root.classList.toggle("generating", msg.value); }
    else if (msg.type === "chatCleared") {
        Object.keys(streamTimers).forEach(function(id) { clearStreamTimer(id); });
        streamDivs = {};
        streamStates = {};
        streamStartedAt = {};
        chat.innerHTML = "";
    }
});
</script>
</body>
</html>`;
    }
}
