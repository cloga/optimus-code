import { AgentAdapter } from './AgentAdapter';
import { AgentMode } from '../types/SharedTaskContext';
import * as cp from 'child_process';
import * as path from 'path';
import { debugLog } from '../debugLogger';

// ─── JSON-RPC Message Framing (Content-Length, same as LSP) ───

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

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function encodeMessage(msg: JsonRpcMessage): Buffer {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return Buffer.concat([header, body]);
}

/**
 * Streaming parser for Content-Length framed JSON-RPC messages.
 * Accumulates stdin chunks and emits parsed messages via callback.
 */
class MessageParser {
    private buffer = Buffer.alloc(0);
    private onMessage: (msg: any) => void;

    constructor(onMessage: (msg: any) => void) {
        this.onMessage = onMessage;
    }

    feed(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.tryParse()) { /* keep parsing */ }
    }

    private tryParse(): boolean {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return false;

        const headerStr = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
            // Malformed header — skip past it
            this.buffer = this.buffer.subarray(headerEnd + 4);
            return true;
        }

        const contentLength = parseInt(match[1], 10);
        const totalLength = headerEnd + 4 + contentLength;
        if (this.buffer.length < totalLength) return false; // not enough data yet

        const bodyBuf = this.buffer.subarray(headerEnd + 4, totalLength);
        this.buffer = this.buffer.subarray(totalLength);

        try {
            const msg = JSON.parse(bodyBuf.toString('utf8'));
            this.onMessage(msg);
        } catch (e: any) {
            debugLog('[AcpAdapter]', `Malformed JSON-RPC body, skipping: ${e.message}`);
        }
        return true;
    }
}

/**
 * AcpAdapter: Universal Agent Client Protocol (ACP) Engine Adapter.
 * Communicates with ACP-compatible agents via JSON-RPC over stdio.
 */
export class AcpAdapter implements AgentAdapter {
    public id: string;
    public name: string;
    public isEnabled: boolean = true;
    public modes: AgentMode[] = ['plan', 'agent', 'chat'];

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

    private sendRequest(method: string, params?: any): Promise<any> {
        if (!this.process?.stdin?.writable) {
            return Promise.reject(new Error('[AcpAdapter] Process stdin not writable'));
        }
        const id = this.nextRequestId++;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        debugLog('[AcpAdapter]', `→ ${method} (id=${id})`);
        this.process.stdin.write(encodeMessage(msg));
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
        });
    }

    private sendNotification(method: string, params?: any): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
        debugLog('[AcpAdapter]', `→ notification ${method}`);
        this.process.stdin.write(encodeMessage(msg));
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
        });

        const parser = new MessageParser((msg) => this.handleIncoming(msg));
        this.process.stdout!.on('data', (chunk: Buffer) => parser.feed(chunk));
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
        for (const [id, pending] of this.pendingRequests) {
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
            // Step 2: Initialize handshake
            const initResult = await this.sendRequest('initialize', {
                capabilities: {},
                clientInfo: { name: 'optimus', version: '0.4.0' }
            });
            debugLog('[AcpAdapter]', `Initialize response: ${JSON.stringify(initResult)?.substring(0, 200)}`);

            // Step 3: Create or resume session
            let currentSessionId: string;
            if (sessionId) {
                const loadResult = await this.sendRequest('session/load', { sessionId });
                currentSessionId = loadResult?.sessionId || sessionId;
                debugLog('[AcpAdapter]', `Session loaded: ${currentSessionId}`);
            } else {
                const newParams: any = { cwd: process.cwd() };
                const newResult = await this.sendRequest('session/new', newParams);
                currentSessionId = newResult?.sessionId || `acp-session-${Date.now()}`;
                debugLog('[AcpAdapter]', `New session created: ${currentSessionId}`);
            }
            this.lastSessionId = currentSessionId;

            // Step 4 + 5 + 6: Send prompt, collect streaming updates, await final response
            const outputChunks: string[] = [];

            // Register notification handler for streaming updates
            this.notificationHandlers.set('session/update', (params: any) => {
                const text = params?.text || params?.content || '';
                if (text) {
                    outputChunks.push(text);
                    if (onUpdate) onUpdate(text);
                }
            });

            // Send the prompt and wait for the response
            const promptResult = await this.sendRequest('session/prompt', {
                sessionId: currentSessionId,
                prompt,
            });

            // The final result may contain the complete text
            const resultText = promptResult?.text
                || promptResult?.content
                || promptResult?.result
                || '';

            // Combine: if we got streaming chunks, use those; otherwise use the final result
            const fullOutput = outputChunks.length > 0
                ? outputChunks.join('')
                : (typeof resultText === 'string' ? resultText : JSON.stringify(resultText));

            this.lastDebugInfo.endTime = Date.now();
            return fullOutput;

        } catch (err: any) {
            debugLog('[AcpAdapter]', `Error during ACP flow: ${err.message}`);
            throw err;
        } finally {
            this.cleanup();
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
                this.process.stdin.write(encodeMessage(cancelMsg));
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
