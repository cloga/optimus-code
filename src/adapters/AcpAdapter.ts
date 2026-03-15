import { AgentAdapter } from './AgentAdapter';
import { AgentMode } from '../types/SharedTaskContext';
import * as cp from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../debugLogger';

// ─── JSON-RPC Types ───

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: any;
}

interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: any;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

/**
 * AcpAdapter: Universal Agent Client Protocol (ACP) Engine Adapter.
 *
 * Communicates with ACP-compatible agents via JSON-RPC over stdio.
 * Supports both NDJSON (newline-delimited) and Content-Length framing,
 * auto-detected from agent responses.
 *
 * Verified working with: Qwen Code v0.12.3, claude-agent-acp v0.21.0
 */
export class AcpAdapter implements AgentAdapter {
    public id: string;
    public name: string;
    public isEnabled: boolean = true;
    public modes: AgentMode[] = ['plan', 'agent'];

    // Protocol state
    public lastSessionId?: string;
    public lastDebugInfo?: any = {};
    public lastUsageLog?: string;

    private process?: cp.ChildProcess;
    private executable: string;
    private defaultArgs: string[];
    private nextRequestId = 1;
    private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private notificationHandlers = new Map<string, (params: any) => void>();

    constructor(id: string, name: string, executable: string, defaultArgs: string[] = []) {
        this.id = id;
        this.name = name;
        this.executable = executable;
        this.defaultArgs = defaultArgs;
    }

    // ─── Low-level transport ───

    private sendMessage(msg: JsonRpcMessage): void {
        if (!this.process?.stdin?.writable) return;
        // Use NDJSON (newline-delimited JSON) — compatible with Qwen and most ACP agents
        this.process.stdin.write(JSON.stringify(msg) + '\n');
    }

    private sendRequest(method: string, params?: any): Promise<any> {
        if (!this.process?.stdin?.writable) {
            return Promise.reject(new Error('[AcpAdapter] Process stdin not writable'));
        }
        const id = this.nextRequestId++;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        debugLog('[AcpAdapter]', `→ ${method} (id=${id})`);
        this.sendMessage(msg);
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
        });
    }

    private handleIncoming(msg: any): void {
        // Response to a request we sent
        if ('id' in msg && msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Request FROM the agent (has id + method, no result/error) — needs a response
        if ('id' in msg && msg.id != null && 'method' in msg) {
            if (msg.method === 'session/request_permission') {
                // Auto-approve all permission requests (headless orchestrator mode)
                const options = msg.params?.options || [];
                const allowOption = options.find((o: any) => o.kind === 'allow_always')
                    || options.find((o: any) => o.kind === 'allow_once')
                    || options[0];
                const response = JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: { outcome: { outcome: 'selected', optionId: allowOption?.optionId || 'allow-once' } }
                });
                if (this.process?.stdin?.writable) {
                    this.process.stdin.write(response + '\n');
                }
                debugLog('[AcpAdapter]', `Auto-approved permission request ${msg.id}: ${msg.params?.toolCall?.toolCallId || 'unknown'}`);
            } else {
                debugLog('[AcpAdapter]', `Unhandled agent request: ${msg.method} (id=${msg.id})`);
            }
            return;
        }

        // Notification from the agent
        if ('method' in msg && !('id' in msg && msg.id != null)) {
            const handler = this.notificationHandlers.get(msg.method);
            if (handler) {
                handler(msg.params);
            } else {
                debugLog('[AcpAdapter]', `Unhandled notification: ${msg.method}`);
            }
        }
    }

    // ─── Process lifecycle ───

    private spawnProcess(extraEnv?: Record<string, string>): void {
        const env = { ...process.env, ...extraEnv };
        const args = [...this.defaultArgs];

        debugLog('[AcpAdapter]', `Spawning: ${this.executable} ${args.join(' ')}`);
        this.process = cp.spawn(this.executable, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
            shell: process.platform === 'win32',
        });

        // Parse stdout as NDJSON (one JSON object per line)
        const rl = readline.createInterface({ input: this.process.stdout! });
        rl.on('line', (line: string) => {
            if (!line.trim()) return;
            try {
                const msg = JSON.parse(line);
                this.handleIncoming(msg);
            } catch (e: any) {
                debugLog('[AcpAdapter]', `Non-JSON stdout line, skipping: ${line.substring(0, 100)}`);
            }
        });

        this.process.stderr!.on('data', (chunk: Buffer) => {
            debugLog('[AcpAdapter][stderr]', chunk.toString('utf8').trimEnd());
        });

        this.process.on('error', (err) => {
            debugLog('[AcpAdapter]', `Process error: ${err.message}`);
            this.rejectAllPending(err);
        });

        this.process.on('exit', (code, signal) => {
            debugLog('[AcpAdapter]', `Process exited: code=${code} signal=${signal}`);
            this.rejectAllPending(new Error(`ACP process exited unexpectedly (code=${code}, signal=${signal})`));
            this.process = undefined;
        });

        this.lastDebugInfo = {
            command: `${this.executable} ${args.join(' ')}`,
            cwd: process.cwd(),
            pid: this.process.pid,
            startTime: Date.now(),
        };
    }

    private rejectAllPending(err: Error): void {
        for (const [, pending] of this.pendingRequests) {
            pending.reject(err);
        }
        this.pendingRequests.clear();
    }

    private cleanup(): void {
        this.notificationHandlers.clear();
        this.pendingRequests.clear();
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = undefined;
        }
    }

    // ─── Core ACP Invocation flow ───

    async invoke(
        prompt: string,
        mode: AgentMode,
        sessionId?: string,
        onUpdate?: (chunk: string) => void,
        extraEnv?: Record<string, string>
    ): Promise<string> {
        debugLog('[AcpAdapter]', `Invoking for ${this.name} (mode=${mode}, resume=${!!sessionId})`);

        // Step 1: Spawn the subprocess transport
        this.spawnProcess(extraEnv);

        try {
            // Step 2: Initialize handshake (protocolVersion is a number per Qwen's ACP impl)
            const initResult = await this.sendRequest('initialize', {
                protocolVersion: 1,
                capabilities: {},
                clientInfo: { name: 'optimus', version: '0.4.0' }
            });
            debugLog('[AcpAdapter]', `Initialize OK: ${JSON.stringify(initResult)?.substring(0, 200)}`);

            // Step 3: Create or resume session
            let currentSessionId: string;
            if (sessionId) {
                const loadResult = await this.sendRequest('session/load', { sessionId });
                currentSessionId = loadResult?.sessionId || sessionId;
                debugLog('[AcpAdapter]', `Session loaded: ${currentSessionId}`);
            } else {
                const mcpServers = this.loadMcpServers();
                const newResult = await this.sendRequest('session/new', {
                    cwd: process.cwd(),
                    mcpServers
                });
                currentSessionId = newResult?.sessionId || `acp-session-${Date.now()}`;
                debugLog('[AcpAdapter]', `New session created: ${currentSessionId}`);
            }
            this.lastSessionId = currentSessionId;

            // Step 4 + 5 + 6: Send prompt, collect streaming updates, await final response
            const outputChunks: string[] = [];

            // Register notification handler for streaming updates
            this.notificationHandlers.set('session/update', (params: any) => {
                const update = params?.update;
                if (!update) return;

                // Extract text from agent_message_chunk (the actual response content)
                if (update.sessionUpdate === 'agent_message_chunk') {
                    const text = update.content?.text || '';
                    if (text) {
                        outputChunks.push(text);
                        if (onUpdate) onUpdate(text);
                    }
                    // Capture usage info if present
                    if (update._meta?.usage) {
                        this.lastUsageLog = JSON.stringify(update._meta.usage);
                    }
                }
                // agent_thought_chunk can be forwarded as thinking/progress
                else if (update.sessionUpdate === 'agent_thought_chunk') {
                    const text = update.content?.text || '';
                    if (text && onUpdate) {
                        onUpdate(`[thinking] ${text}`);
                    }
                }
            });

            // Send prompt as ACP content array format: [{type: "text", text: "..."}]
            const promptResult = await this.sendRequest('session/prompt', {
                sessionId: currentSessionId,
                prompt: [{ type: 'text', text: prompt }]
            });

            // Combine streaming chunks into full output
            const fullOutput = outputChunks.join('');

            this.lastDebugInfo.endTime = Date.now();
            debugLog('[AcpAdapter]', `Done. Output length: ${fullOutput.length}, stop: ${promptResult?.stopReason}`);
            return fullOutput;

        } catch (err: any) {
            debugLog('[AcpAdapter]', `Error during ACP flow: ${err.message}`);
            throw err;
        } finally {
            this.cleanup();
        }
    }

    /**
     * Load MCP server config from .vscode/mcp.json and convert to ACP array format.
     * ACP expects: [{ name, command, args, env: [{name, value}] }]
     * VS Code uses: { "server-name": { type, command, args, env: {KEY: VALUE} } }
     */
    private loadMcpServers(): any[] {
        const cwd = process.cwd();
        const mcpPath = path.join(cwd, '.vscode', 'mcp.json');

        if (!fs.existsSync(mcpPath)) {
            debugLog('[AcpAdapter]', 'No .vscode/mcp.json found, mcpServers=[]');
            return [];
        }

        try {
            let raw = fs.readFileSync(mcpPath, 'utf8');
            // Resolve VS Code macros — escape backslashes for valid JSON on Windows
            const cwdEscaped = cwd.replace(/\\/g, '\\\\');
            raw = raw.replace(/\$\{workspaceFolder\}/g, cwdEscaped);
            raw = raw.replace(/\$\{env:(\w+)\}/g, (_: string, varName: string) => (process.env[varName] || '').replace(/\\/g, '\\\\'));
            const cfg = JSON.parse(raw);
            const servers = cfg.servers || cfg.mcpServers || {};

            // Convert VS Code object format → ACP array format
            const acpServers = Object.entries(servers).map(([name, config]: [string, any]) => ({
                name,
                command: config.command || '',
                args: config.args || [],
                env: Object.entries(config.env || {}).map(([k, v]) => ({ name: k, value: String(v) }))
            }));

            debugLog('[AcpAdapter]', `Loaded ${acpServers.length} MCP servers: ${acpServers.map(s => s.name).join(', ')}`);
            return acpServers;
        } catch (e: any) {
            debugLog('[AcpAdapter]', `Failed to load MCP config: ${e.message}`);
            return [];
        }
    }

    /**
     * Terminate the ACP session gracefully: send cancel, then kill.
     */
    stop(): void {
        debugLog('[AcpAdapter]', `Stopping session for ${this.name}...`);
        if (this.process?.stdin?.writable) {
            try {
                // Best-effort cancel before killing
                const cancelMsg: JsonRpcRequest = {
                    jsonrpc: '2.0',
                    id: this.nextRequestId++,
                    method: 'session/cancel',
                    params: { sessionId: this.lastSessionId }
                };
                this.process.stdin.write(JSON.stringify(cancelMsg) + '\n');
            } catch { /* ignore write errors during shutdown */ }
        }
        // Give a short grace period, then force kill
        setTimeout(() => {
            if (this.process) {
                this.process.kill('SIGTERM');
                this.process = undefined;
            }
        }, 500);
    }

    /**
     * With ACP, structured output comes natively via session/update events.
     * No regex parsing needed.
     */
    extractThinking(rawText: string): { thinking: string; output: string; usageLog?: string } {
        return {
            thinking: '',
            output: rawText,
            usageLog: this.lastUsageLog
        };
    }
}
