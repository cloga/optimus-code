import * as vscode from 'vscode';
import { getActiveAdapters } from '../adapters';
import { marked } from 'marked';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'optimus-code.chatView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'askCouncil':
                    {
                        await this._delegateToCouncil(data.value);
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
            }
        });
    }

    private async _delegateToCouncil(prompt: string) {
        if (!this._view) { return; }

        const activeAdapters = getActiveAdapters();
        const sessionResponses: {agent: string, text: string, status: 'success' | 'error', raw: boolean}[] = [];
        
        // 1. Tell UI which agents are starting
        this._view.webview.postMessage({ 
            type: 'startCouncil', 
            agents: activeAdapters.map(a => a.name) 
        });
        
        try {
            // 2. Fire them concurrently and stream their individual successes/failures back
            const promises = activeAdapters.map(adapter => {
                return adapter.invoke(prompt, async (incrementalText) => {
                    // Streaming UI update
                    const htmlContent = await marked.parse(incrementalText);
                    this._view?.webview.postMessage({ type: 'agentUpdate', agent: adapter.name, text: htmlContent });
                })
                .then(async res => {
                    sessionResponses.push({ agent: adapter.name, text: res, status: 'success', raw: false });
                    const htmlContent = await marked.parse(res);
                    this._view?.webview.postMessage({ type: 'agentDone', agent: adapter.name, text: htmlContent, status: 'success', raw: false });
                })
                .catch(err => {
                    sessionResponses.push({ agent: adapter.name, text: err.message, status: 'error', raw: true });
                    this._view?.webview.postMessage({ type: 'agentDone', agent: adapter.name, text: err.message, status: 'error', raw: true });
                });
            });

            // 3. Wait for all to finish
            await Promise.all(promises);

            // 4. Tell UI council is dismissed
            this._view.webview.postMessage({ type: 'councilComplete' });
            
            // Save Session History
            this._saveSession(prompt, sessionResponses);
        } catch (error: any) {
            this._view.webview.postMessage({ type: 'agentDone', agent: 'System', text: error.message, status: 'error', raw: true });
        }
    }

    private _saveSession(prompt: string, responses: any[]) {
        const sessions: any[] = this._context.globalState.get('optimusSessions', []);
        sessions.unshift({
            id: Date.now().toString(),
            timestamp: Date.now(),
            prompt: prompt,
            responses: responses
        });
        
        // Keep max 50 sessions
        const limited = sessions.slice(0, 50);
        this._context.globalState.update('optimusSessions', limited);
        this._sendSessionsToUI();
    }

    private _sendSessionsToUI() {
        const sessions: any[] = this._context.globalState.get('optimusSessions', []);
        const lightweightSessions = sessions.map(s => ({ id: s.id, prompt: s.prompt, timestamp: s.timestamp }));
        this._view?.webview.postMessage({ type: 'updateSessionsList', sessions: lightweightSessions });
    }

    private async _loadSessionToUI(id: string) {
        const sessions: any[] = this._context.globalState.get('optimusSessions', []);
        const session = sessions.find(s => s.id === id);
        if (session) {
            // Need to parse everything again since we store pure markdown
            const parsedResponses = await Promise.all(session.responses.map(async (r: any) => {
                const text = (r.status === 'success' && !r.raw) ? await marked.parse(r.text) : r.text;
                return { ...r, parsedText: text };
            }));
            this._view?.webview.postMessage({ type: 'restoreSession', session: { ...session, responses: parsedResponses } });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.js'));

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
                }
                .chat-history {
                    flex-grow: 1;
                    overflow-y: auto;
                    margin-bottom: 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
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
                vscode-text-area {
                    width: 100%;
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
                .council-container {
                    display: flex;
                    flex-direction: row;
                    flex-wrap: nowrap;
                    gap: 16px;
                    overflow-x: auto;
                    padding-bottom: 10px;
                    margin-top: 5px;
                }
                .agent-column {
                    flex: 0 0 calc(100% - 20px);
                    min-width: 280px;
                    max-width: 450px;
                    /* Give max height so overflow triggers sliding inside */
                    max-height: 500px;
                    display: flex;
                    flex-direction: column;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    padding: 12px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                .task-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-weight: 600;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 8px;
                    margin-bottom: 8px;
                }
                .task-icon {
                    font-size: 14px;
                }
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
                /* Blinking animation for thinking */
                @keyframes blink {
                    0% { opacity: .2; }
                    20% { opacity: 1; }
                    100% { opacity: .2; }
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
                    display: none;
                    flex-direction: column;
                    gap: 8px;
                    max-height: 200px;
                    overflow-y: auto;
                    margin-bottom: 10px;
                    padding: 10px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                }
                .session-item {
                    cursor: pointer;
                    padding: 6px;
                    border-radius: 4px;
                    font-size: 12px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .session-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }
            </style>
        </head>
        <body>
            <div class="chat-header">
                <div style="font-weight: bold; font-size: 14px;">Optimus Council</div>
                <vscode-button appearance="secondary" id="toggle-sessions-btn">Sessions History</vscode-button>
            </div>

            <div class="sessions-panel" id="sessions-panel"></div>

            <div class="chat-history" id="chat-history">
                <div class="message agent">
                    <div class="agent-name">🏛️ Optimus Council</div>
                    <p>Welcome! Describe your architecture problem, and I will summon the agents concurrently.</p>
                </div>
            </div>
            
            <div class="input-area">
                <vscode-text-area id="prompt-input" placeholder="E.g., How to implement RBAC in Next.js?" resize="vertical" rows="3"></vscode-text-area>
                <vscode-button id="ask-btn">Ask the Council</vscode-button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const askBtn = document.getElementById('ask-btn');
                const promptInput = document.getElementById('prompt-input');
                const chatHistory = document.getElementById('chat-history');
                const sessionsPanel = document.getElementById('sessions-panel');
                const toggleBtn = document.getElementById('toggle-sessions-btn');

                toggleBtn.addEventListener('click', () => {
                    if (sessionsPanel.style.display === 'none' || sessionsPanel.style.display === '') {
                        sessionsPanel.style.display = 'flex';
                        vscode.postMessage({ type: 'requestSessions' });
                    } else {
                        sessionsPanel.style.display = 'none';
                    }
                });

                function scrollChat() {
                    chatHistory.scrollTop = chatHistory.scrollHeight;
                }
                
                // Keep track of the current council container
                let currentCouncilHeader = null;

                askBtn.addEventListener('click', () => {
                    const text = promptInput.value;
                    if (!text.trim()) return;

                    chatHistory.innerHTML += \`<div class="message user">\${text}</div>\`;
                    scrollChat();
                    
                    vscode.postMessage({ type: 'askCouncil', value: text });
                    promptInput.value = '';
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    
                    if (message.type === 'updateSessionsList') {
                        sessionsPanel.innerHTML = message.sessions.length ? '' : '<i>No history yet.</i>';
                        message.sessions.forEach(s => {
                            const div = document.createElement('div');
                            div.className = 'session-item';
                            div.title = s.prompt;
                            const dateStr = new Date(s.timestamp).toLocaleTimeString();
                            div.textContent = \`🕒 \${dateStr} - \${s.prompt}\`;
                            div.addEventListener('click', () => {
                                vscode.postMessage({ type: 'loadSession', sessionId: s.id });
                                sessionsPanel.style.display = 'none';
                            });
                            sessionsPanel.appendChild(div);
                        });
                    }
                    else if (message.type === 'restoreSession') {
                        chatHistory.innerHTML = \`<div class="message user">\${message.session.prompt}</div>\`;
                        
                        const msgDiv = document.createElement('div');
                        msgDiv.className = 'message agent';
                        let html = \`<div class="agent-name">🏛️ Council Verdict (Restored)</div><div class="council-container">\`;
                        
                        message.session.responses.forEach(r => {
                            const safeId = r.agent.replace(/[^a-zA-Z0-9]/g, '');
                            html += \`
                                <div class="agent-column">
                                    <div class="task-item">
                                        <span class="task-icon">\${r.status === 'success' ? '✅' : '❌'}</span> 
                                        <span class="task-name">\${r.agent}</span>
                                    </div>
                                    <div style="flex-grow: 1; overflow-y: auto;">
                                        \${r.raw ? \`<pre class="\${r.status === 'error' ? 'error-text' : ''}">\${r.parsedText}</pre>\` : \`<div class="markdown-body">\${r.parsedText}</div>\`}
                                    </div>
                                </div>
                            \`;
                        });
                        html += \`</div>\`;
                        msgDiv.innerHTML = html;
                        chatHistory.appendChild(msgDiv);
                        scrollChat();
                    }
                    else if (message.type === 'startCouncil') {
                        // Create the container for this batch of tasks
                        const msgDiv = document.createElement('div');
                        msgDiv.className = 'message agent';
                        
                        let html = \`<div class="agent-name" id="council-status-\${Date.now()}">⏳ Council is deliberating...</div>\`;
                        currentCouncilHeader = \`council-status-\${Date.now()}\`; // track it to update later

                        html += \`<div class="council-container">\`;

                        message.agents.forEach(agent => {
                            // sanitize name to use as generic ID
                            const safeId = agent.replace(/[^a-zA-Z0-9]/g, '');
                            html += \`
                                <div class="agent-column">
                                    <div id="task-\${safeId}" class="task-item thinking">
                                        <span class="task-icon">🔄</span> 
                                        <span class="task-name">\${agent}</span>
                                    </div>
                                    <div id="content-\${safeId}" style="display:none; flex-grow: 1; overflow-y: auto;"></div>
                                </div>
                            \`;
                        });
                        
                        html += \`</div>\`;
                        
                        msgDiv.innerHTML = html;
                        chatHistory.appendChild(msgDiv);
                        scrollChat();
                    } 
                    else if (message.type === 'agentUpdate') {
                        const safeId = message.agent.replace(/[^a-zA-Z0-9]/g, '');
                        const contentEl = document.getElementById(\`content-\${safeId}\`);
                        if (contentEl) {
                            contentEl.style.display = 'block';
                            contentEl.innerHTML = \`<div class="markdown-body">\${message.text}</div>\`;
                            // Smooth scroll inside the specific agent's column
                            contentEl.scrollTop = contentEl.scrollHeight;
                        }
                    }
                    else if (message.type === 'agentDone') {
                        const safeId = message.agent.replace(/[^a-zA-Z0-9]/g, '');
                        const taskEl = document.getElementById(\`task-\${safeId}\`);
                        const contentEl = document.getElementById(\`content-\${safeId}\`);
                        
                        // Update UI individually
                        if (taskEl && contentEl) {
                            taskEl.classList.remove('thinking');
                            taskEl.querySelector('.task-icon').textContent = message.status === 'success' ? '✅' : '❌';
                            
                            if (message.raw) {
                                contentEl.innerHTML = \`<pre class="\${message.status === 'error' ? 'error-text' : ''}">\${message.text}</pre>\`;
                            } else {
                                contentEl.innerHTML = \`<div class="markdown-body">\${message.text}</div>\`;
                            }
                            contentEl.style.display = 'block';
                        }
                        scrollChat();
                    }
                    else if (message.type === 'councilComplete') {
                        // Change header to done
                        if (currentCouncilHeader) {
                            const headerEl = document.getElementById(currentCouncilHeader);
                            if (headerEl) {
                                headerEl.textContent = "🏛️ Council Verdict";
                            }
                        }
                    }
                });
            </script>
        </body>
        </html>`;
    }
}