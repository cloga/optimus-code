const fs = require("fs");

// 1. Rewrite package.json
let p = JSON.parse(fs.readFileSync("package.json", "utf8"));
delete p.contributes.languageModelTools;
p.contributes.viewsContainers = {
  "activitybar": [{ "id": "optimus-code-sidebar", "title": "Optimus Code", "icon": "resources/icon.svg" }]
};
p.contributes.views = {
  "optimus-code-sidebar": [{ "type": "webview", "id": "optimus-code.chatView", "name": "Council Chat", "icon": "resources/icon.svg" }]
};
fs.writeFileSync("package.json", JSON.stringify(p, null, 2));

// 2. Create ChatViewProvider.ts
if (!fs.existsSync("src/providers")) fs.mkdirSync("src/providers", {recursive:true});
const providerCode = `import * as vscode from "vscode";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "optimus-code.chatView";
    private gemini = new GitHubCopilotAdapter("copilot-gemini", "Copilot PM", "vendor.google.gemini-3.0");
    private claude = new ClaudeCodeAdapter("claude-opus", "Claude Worker", "--model claude-3-opus-20240229");

    constructor(private readonly _extensionUri: vscode.Uri, private readonly context: vscode.ExtensionContext) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async data => {
            if (data.type === "ask") {
                let agent = data.agent;
                let text = data.text;

                webviewView.webview.postMessage({ type: "addMessage", role: "user", content: text });

                let maxTurns = 3;
                while(maxTurns > 0) {
                    maxTurns--;
                    webviewView.webview.postMessage({ type: "status", content: agent === "gemini" ? " Gemini 正在思考..." : " Claude 正在处理..." });
                    
                    let reply = "";
                    try {
                        if (agent === "gemini") {
                            const prompt = text + "\\n\\n[System Rules: You are the PM. If you need coding or file modifications, delegate to the Developer by formatting exactly like this at the end of your message: \\n@claude: <instructions>]";
                            reply = await this.gemini.invoke(prompt, "pm", ()=>{}) || "No reply.";
                        } else {
                            const prompt = text + "\\n\\n[System Rules: You are the Dev. If you finish, report back to PM by formatting exactly like this at the end: \\n@gemini: <status>]";
                            reply = await this.claude.invoke(prompt, "agent", ()=>{}) || "Done.";
                        }
                    } catch(e) {
                        reply = "Error: " + String(e);
                    }

                    webviewView.webview.postMessage({ 
                        type: "addMessage", 
                        role: agent, 
                        content: reply 
                    });

                    // Check for delegation tags
                    const claudeMatch = reply.match(/@claude:\\s*([\\s\\S]*)/i);
                    const geminiMatch = reply.match(/@gemini:\\s*([\\s\\S]*)/i);

                    if (agent === "gemini" && claudeMatch) {
                        agent = "claude";
                        text = "PM 指定任务: " + claudeMatch[1];
                        webviewView.webview.postMessage({ type: "addMessage", role: "system", content: " Gemini 将任务委派给了 Claude！" });
                    } else if (agent === "claude" && geminiMatch) {
                        agent = "gemini";
                        text = "Dev 汇报情况: " + geminiMatch[1];
                        webviewView.webview.postMessage({ type: "addMessage", role: "system", content: " Claude 结果已汇报给 Gemini！" });
                    } else {
                        break; 
                    }
                }
                webviewView.webview.postMessage({ type: "status", content: "" }); 
            }
        });
    }

    private getHtml() {
        return \`<!DOCTYPE html>
        <html lang="en">
        <head>
            <style>
                body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; margin:0; box-sizing: border-box;}
                #chat { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
                .msg { padding: 10px; border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); word-wrap: break-word; white-space: pre-wrap;}
                .msg.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 80%; }
                .msg.gemini { border-left: 4px solid #8A2BE2; }
                .msg.claude { border-left: 4px solid #D2691E; }
                .msg.system { font-style: italic; color: var(--vscode-descriptionForeground); font-size: 0.9em; background: transparent; text-align: center; }
                #input-area { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; padding-bottom: 20px;}
                textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; min-height: 60px; resize: vertical; margin-bottom: 4px; font-family: inherit;}
                select, button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px; cursor: pointer; border-radius: 2px;}
                button:hover { background: var(--vscode-button-hoverBackground); }
                #status { font-size: 0.85em; color: var(--vscode-textLink-activeForeground); min-height: 20px; font-weight: bold;}
            </style>
        </head>
        <body>
            <div id="chat"></div>
            <div id="status"></div>
            <div id="input-area">
                <select id="agent">
                    <option value="gemini"> PM: Copilot Gemini 3.0</option>
                    <option value="claude"> Dev: Claude Code Opus</option>
                </select>
                <textarea id="prompt" placeholder="指派你的任务..."></textarea>
                <button id="send">发送指令</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const chat = document.getElementById("chat");
                const status = document.getElementById("status");
                
                document.getElementById("send").onclick = () => {
                    const text = document.getElementById("prompt").value;
                    const agent = document.getElementById("agent").value;
                    if(!text) return;
                    vscode.postMessage({ type: "ask", text, agent });
                    document.getElementById("prompt").value = "";
                };

                window.addEventListener("message", event => {
                    const msg = event.data;
                    if (msg.type === "addMessage") {
                        const div = document.createElement("div");
                        div.className = "msg " + msg.role;
                        const prefix = msg.role === "gemini" ? " PM 指示:\\n" : (msg.role === "claude" ? " Dev 处理:\\n" : "");
                        div.innerText = (msg.role !== "user" && msg.role !== "system" ? prefix : "") + msg.content;
                        chat.appendChild(div);
                        chat.scrollTop = chat.scrollHeight;
                    } else if (msg.type === "status") {
                        status.innerText = msg.content;
                    }
                });
            </script>
        </body>
        </html>\`;
    }
}`;
fs.writeFileSync("src/providers/ChatViewProvider.ts", providerCode);

// 3. Update extension.ts
let ext = fs.readFileSync("src/extension.ts", "utf8");
// Remove LM tool bindings
ext = ext.replace(/const claudeToolOpus[\s\S]*?(?=\s*if \(workspacePathHint\)|$)/, "");
ext = ext.replace(/import \{ ClaudeCodeAdapter \}.*;\n/g, "");
ext = ext.replace(/const activeSessions = new Map<string, ClaudeCodeAdapter>\(\);\n/g, "");

// Add back Webview provider
if (!ext.includes("ChatViewProvider")) {
    ext = `import { ChatViewProvider } from "./providers/ChatViewProvider";\n` + ext;
    ext = ext.replace("export function activate(context: vscode.ExtensionContext) {", 
      "export function activate(context: vscode.ExtensionContext) {\n" + 
      "    const provider = new ChatViewProvider(context.extensionUri, context);\n" +
      "    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));\n"
    );
}

fs.writeFileSync("src/extension.ts", ext);
console.log("UI reverted successfully.");

