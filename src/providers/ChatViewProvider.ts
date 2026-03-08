import * as vscode from "vscode";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";
import { SharedTaskStateManager } from "../managers/SharedTaskStateManager";
import { marked } from "marked";

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
                    return this.handleAsk(webviewView, data.text, data.agent, data.model);
                case "stop":
                    // TODO: kill child process
                    this.isGenerating = false;
                    webviewView.webview.postMessage({ type: "setGenerating", value: false });
                    return webviewView.webview.postMessage({ type: "status", content: "Stopped." });
                case "newChat":
                    this.isGenerating = false;
                    this.currentTaskId = undefined;
                    webviewView.webview.postMessage({ type: "setGenerating", value: false });
                    webviewView.webview.postMessage({ type: "chatCleared" });
                    return webviewView.webview.postMessage({ type: "status", content: "New session." });
            }
        });
    }

    private async handleAsk(wv: vscode.WebviewView, text: string, agentId: string, modelId?: string) {
        // Safety: reset stuck state after 3 min
        if (this.isGenerating && Date.now() - this.genStart > 180_000) {
            this.isGenerating = false;
        }
        if (this.isGenerating) {
            return wv.webview.postMessage({ type: "status", content: "Busy — please wait." });
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

            // Show user message immediately
            wv.webview.postMessage({ type: "addMessage", role: "user", html: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") });

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
            wv.webview.postMessage({ type: "streamStart", id: sid, role: agentId });
            wv.webview.postMessage({ type: "status", content: `${entry.label} is working...` });

            const onUpdate = (chunk: string) => {
                wv.webview.postMessage({ type: "streamUpdate", id: sid, text: chunk });
            };

            // Let the CLI agent handle everything: context, tools, memory
            const reply = await entry.adapter.invoke(orchestratorPrompt, entry.mode, onUpdate) || "No reply.";

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
            wv.webview.postMessage({ type: "status", content: "Idle" });
            wv.webview.postMessage({ type: "setGenerating", value: false });
            this.isGenerating = false;
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
        const config = vscode.workspace.getConfiguration("optimusCode");
        const rawModelsCfg = config.get("models") as any;
        let claudeModels = rawModelsCfg?.claude_code || [
            "claude-opus-4.6-1m", "gpt-5.4"
        ];
        let copilotModels = rawModelsCfg?.copilot_cli || [
            "gemini-3-pro-preview", "claude-opus-4.6-1m", "gpt-5.4"
        ];

        return /*html*/ `<!DOCTYPE html>
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
.stream-tabs { display: flex; gap: 2px; }
.tab-btn { background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px; font-size: 0.85em; border-radius: 3px; }
.tab-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.tab-btn.active { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-weight: 500; }

.stream-content { padding: 10px; font-size: .9em; overflow-y: auto; max-height: 600px; }
.tab-pane { display: none; }
.tab-pane.active { display: block; }

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
.step-detail { color: var(--vscode-descriptionForeground); font-size: .85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.step-result-text { color: var(--vscode-descriptionForeground); font-size: .85em; font-style: italic; display: block; }

/* Log View */
.log-view { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-textPreformat-foreground); }

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
.hint { font-size: .8em; color: var(--vscode-descriptionForeground); }
.btns { display: flex; gap: 8px; }
.btns button { flex: 1; }
.idle-only { display: inline-flex; }
.gen-only  { display: none; }
body.generating .idle-only { display: none; }
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
const defaultEngine = "copilot_cli";
const defaultModelByEngine = {
    "copilot_cli": "gemini-3-pro-preview",
    "claude_code": "claude-opus-4.6-1m"
};

const modelsByEngine = {
    "claude_code": ${JSON.stringify(claudeModels)}.map(m => ({value: m, label: m})),
    "copilot_cli": ${JSON.stringify(copilotModels)}.map(m => ({value: m, label: m}))
};

function updateModels() {
    const engine = engineSelect.value;
    const models = modelsByEngine[engine] || [];
    const preferredModel = defaultModelByEngine[engine];
    modelSelect.innerHTML = '';
    for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
    }
    if (preferredModel && models.some(m => m.value === preferredModel)) {
        modelSelect.value = preferredModel;
    }
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

function clearStreamTimer(id) {
    var timer = streamTimers[id];
    if (timer) {
        clearTimeout(timer);
        delete streamTimers[id];
    }
}

function scheduleSlowStartHint(id) {
    clearStreamTimer(id);
    streamTimers[id] = setTimeout(function() {
        var t = streamDivs[id];
        if (t) {
             // Only show if trace is empty
             var tracePane = t.querySelector('.tab-pane.trace');
             if (tracePane && !tracePane.innerHTML.trim()) {
                tracePane.innerHTML = '<span style="color:var(--vscode-descriptionForeground)">Still starting. The first response from the CLI can take 5-15 seconds.</span>';
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
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
}
function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

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
    var NL = String.fromCharCode(10);
    var lines = raw.split(NL);
    var steps = [];
    var outputLines = [];
    var cur = null;

    function shortPath(s) { var m = /[/\\\\]([^/\\\\]+)$/.exec(s); return m ? m[1] : s; }
    function summarize(d) {
        return d.replace(/\\s+/g, " ").trim().replace(/(?:file_path|path|filepath|relative_workspace_path)=([^,]+)/gi, function(_, v) { return shortPath(v.trim()); });
    }
    function flush() { if (cur) { steps.push(cur); cur = null; } }

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var tm = /^[\\u2022\\u25CF\\u23FA\\u25B6\\u2192]\\s*(.+)$/.exec(line);
        if (tm) { flush(); cur = { name: tm[1].trim(), detail: "", done: null, result: "" }; continue; }
        var dm = /^([\\u2713\\u2717])\\s*(.*)$/.exec(line);
        if (dm) {
            if (cur && (!dm[2] || cur.name === dm[2].trim())) { cur.done = dm[1]; }
            else { flush(); cur = { name: dm[2].trim() || "tool", detail: "", done: dm[1], result: "" }; }
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
    if (steps.length > 0) {
        traceHtml += '<div class="step-list">';
        for (var s = 0; s < steps.length; s++) {
            var st = steps[s];
            var dc = st.done === "\\u2713" ? "step-dot-done" : st.done === "\\u2717" ? "step-dot-err" : "step-dot-run";
            traceHtml += '<div class="step"><div class="step-dot ' + dc + '"></div><div class="step-text">';
            traceHtml += '<span class="step-name">' + escapeHtml(st.name) + '</span>';
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
    
    // Update Output Pane (Preview)
    var out = outputLines.join(NL).trim();
    var outputPane = container.querySelector('.tab-pane.output');
    if(outputPane) {
         if (out) outputPane.querySelector('div').textContent = out;
         else outputPane.querySelector('div').textContent = "Waiting for output...";
    }
    
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
        
        // Header with Tabs
        var header = document.createElement("div");
        header.className = "stream-header";
        
        var title = document.createElement("div");
        title.className = "stream-title";
        title.innerHTML = '<span class="spinner"></span>' + (labels[msg.role] || msg.role);
        header.appendChild(title);
        
        var tabs = document.createElement("div");
        tabs.className = "stream-tabs";
        tabs.innerHTML = \`
            <button class="tab-btn active" data-tab="trace" onclick="switchTab(\${msg.id}, 'trace')">Trace</button>
            <button class="tab-btn" data-tab="log" onclick="switchTab(\${msg.id}, 'log')">Log</button>
            <button class="tab-btn" data-tab="output" onclick="switchTab(\${msg.id}, 'output')">Output</button>
        \`;
        header.appendChild(tabs);
        div.appendChild(header);
        
        var ct = document.createElement("div"); 
        ct.className = "stream-content";
        ct.innerHTML = \`
            <div class="tab-pane trace active"><span style="color:var(--vscode-descriptionForeground)">Starting...</span></div>
            <div class="tab-pane log"><div class="log-view"></div></div>
            <div class="tab-pane output"><div class="output-view"></div></div>
        \`;
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
            // Auto-scroll logic if needed
        }
    } else if (msg.type === "streamEnd") {
        clearStreamTimer(msg.id);
        var box = document.getElementById("stream-" + msg.id);
        if (box) {
            // Stop spinner
            var title = box.querySelector(".stream-title");
            if(title) title.innerHTML = (labels[msg.role] || msg.role) + " (Done)";
            
            // Finalize output tab with rendered HTML if available
            if(msg.html) {
                var outPane = box.querySelector(".tab-pane.output div");
                if(outPane) outPane.innerHTML = msg.html;
                
                // Switch to output tab on finish? Maybe keep user preference.
                // switchTab(msg.id, 'output'); 
            }
            
            delete streamDivs[msg.id]; 
        }
    } else if (msg.type === "status") { statusEls.textContent = msg.content; }
    else if (msg.type === "setGenerating") { root.classList.toggle("generating", msg.value); }
    else if (msg.type === "chatCleared") {
        Object.keys(streamTimers).forEach(function(id) { clearStreamTimer(id); });
        chat.innerHTML = "";
    }
});
</script>
</body>
</html>`;
    }
}
