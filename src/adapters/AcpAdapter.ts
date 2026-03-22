import { AgentAdapter } from './AgentAdapter';
import { AgentMode } from '../types/SharedTaskContext';
import * as cp from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../debugLogger';
import { loadProjectMcpServers } from '../utils/mcpConfig';

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
 * Supports two lifecycle modes:
 *   - **Ephemeral** (default): Process spawned per invoke(), killed in finally.
 *   - **Persistent**: Process stays alive between invocations. Used by AcpProcessPool
 *     to eliminate cold-start overhead (~1-2s per task). Process auto-recovers
 *     from crashes on next invoke().
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
    private activityTimeoutMs: number;
    private lastUpdateTime: number = 0;
    private activityTimer?: ReturnType<typeof setInterval>;

    // Persistent mode state
    private _persistent: boolean;
    private _initialized: boolean = false;
    private _busy: boolean = false;
    private _idleSince: number = 0;
    private _invocationCount: number = 0;

    constructor(id: string, name: string, executable: string, defaultArgs: string[] = [], activityTimeoutMs: number = 0, persistent: boolean = false) {
        this.id = id;
        this.name = name;
        this.executable = executable;
        this.defaultArgs = defaultArgs;
        this.activityTimeoutMs = activityTimeoutMs;
        this._persistent = persistent;
    }

    // --- Pool management API ---

    get persistent(): boolean { return this._persistent; }
    get idleSince(): number { return this._idleSince; }
    get invocationCount(): number { return this._invocationCount; }

    /** Check if the adapter's process is alive and initialized */
    isAlive(): boolean {
        return !!this.process && this._initialized && !this.process.killed;
    }

    /** Check if the adapter is currently handling a task */
    isBusy(): boolean {
        return this._busy;
    }

    /** Graceful shutdown — kills process and resets state. Used by pool eviction. */
    shutdown(): void {
        debugLog('[AcpAdapter]', `Shutting down adapter ${this.id} (invocations: ${this._invocationCount})`);
        this.cleanup();
        this._initialized = false;
        this._busy = false;
    }

    private isInvalidParamsError(err: unknown): boolean {
        const message = err instanceof Error ? err.message : String(err);
        return message.includes('ACP error -32602')
            || message.includes('ACP error -32603')
            || /invalid params/i.test(message)
            || /invalid.?input/i.test(message);
    }

    /**
     * Classify raw ACP JSON-RPC errors into actionable error messages
     * so calling agents know how to recover.
     */
    private classifyAcpError(error: { code: number; message: string; data?: any }): Error {
        const msg = error.message || '';
        const code = error.code;
        const data = error.data ? ` Details: ${JSON.stringify(error.data)}` : '';

        // Authentication
        if (/auth/i.test(msg) || /unauthorized/i.test(msg) || /login/i.test(msg)) {
            return new Error(
                `ACP auth_failed: ${msg}. Fix: set GH_TOKEN/GITHUB_TOKEN env var (for Copilot) or run the engine's login command before starting the runtime.`
            );
        }

        // Rate limiting
        if (/rate.?limit/i.test(msg) || code === 429 || /too many requests/i.test(msg) || /quota/i.test(msg)) {
            return new Error(
                `ACP rate_limit: ${msg}. Fix: wait and retry. Consider adding runtime_policy.retries to your request.`
            );
        }

        // Model not found
        if (/model.*not.*found/i.test(msg) || /invalid.*model/i.test(msg) || /unknown.*model/i.test(msg)) {
            return new Error(
                `ACP invalid_model: ${msg}. Fix: remove role_model to use the default, or check available_models in .optimus/config/available-agents.json.`
            );
        }

        // Schema validation (invalid params structure)
        if (code === -32602 || code === -32603) {
            if (error.data && Array.isArray(error.data)) {
                const fields = error.data.map((d: any) => `${d.path?.join('.') || '?'}: expected ${d.expected}, got ${d.message}`).join('; ');
                return new Error(
                    `ACP error ${code}: parameter validation failed — ${fields}. This may indicate an ACP protocol version mismatch.`
                );
            }
        }

        // Permission denied
        if (/permission/i.test(msg) && /denied/i.test(msg)) {
            return new Error(
                `ACP permission_denied: ${msg}. The engine denied a tool/file operation. Check auto-approve settings or engine permissions.`
            );
        }

        // Default: include code and message for debugging
        return new Error(`ACP error ${code}: ${msg}${data}`);
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
                    pending.reject(this.classifyAcpError(msg.error));
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

        // Track process identity for exit handler closure
        const thisProcess = this.process;

        this.process.on('error', (err) => {
            debugLog('[AcpAdapter]', `Process error: ${err.message}`);
            if (this.process === thisProcess) {
                this.rejectAllPending(err);
            }
        });

        this.process.on('exit', (code, signal) => {
            debugLog('[AcpAdapter]', `Process exited: code=${code} signal=${signal}`);
            // Only handle if this is still the current process (not replaced by respawn)
            if (this.process !== thisProcess) return;
            this.rejectAllPending(new Error(
                `ACP acp_process_crashed: engine process exited unexpectedly (code=${code}, signal=${signal}). ` +
                `The warm pool will auto-recover on the next request. If persistent, check engine installation and auth.`
            ));
            this.process = undefined;
            this._initialized = false;
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

    private stopActivityTimer(): void {
        if (this.activityTimer) {
            clearInterval(this.activityTimer);
            this.activityTimer = undefined;
        }
    }

    private cleanup(): void {
        this.stopActivityTimer();
        this.notificationHandlers.clear();
        this.pendingRequests.clear();
        if (this.process) {
            const proc = this.process;
            this.process = undefined; // Clear reference first to prevent stale exit handler from clobbering new process
            proc.kill('SIGTERM');
        }
    }

    /**
     * Configure ACP session mode (autopilot) and model after session creation.
     * Tries session/configure first, then falls back to session/setConfiguration.
     * Silently skips if the agent doesn't support configuration.
     */
    private async configureSession(
        sessionId: string,
        options?: { model?: string; autopilot?: boolean; maxContinues?: number }
    ): Promise<void> {
        if (!options) return;

        const configOptions: { id: string; value: string }[] = [];

        if (options.autopilot) {
            configOptions.push({
                id: 'mode',
                value: 'https://agentclientprotocol.com/protocol/session-modes#autopilot'
            });
        }

        if (options.model) {
            configOptions.push({ id: 'model', value: options.model });
        }

        if (configOptions.length === 0) return;

        // Try session/configure (ACP standard)
        try {
            await this.sendRequest('session/configure', {
                sessionId,
                configOptions
            });
            debugLog('[AcpAdapter]', `Session configured: ${configOptions.map(o => `${o.id}=${o.value}`).join(', ')}`);
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // -32601 = Method not found — try alternative
            if (!msg.includes('-32601')) {
                debugLog('[AcpAdapter]', `session/configure failed (non-fatal): ${msg}`);
                return;
            }
        }

        // Fallback: try session/setConfiguration (some agents use this)
        try {
            const configMap: Record<string, string> = {};
            for (const opt of configOptions) configMap[opt.id] = opt.value;
            await this.sendRequest('session/setConfiguration', {
                sessionId,
                configuration: configMap
            });
            debugLog('[AcpAdapter]', `Session configured via setConfiguration: ${configOptions.map(o => `${o.id}=${o.value}`).join(', ')}`);
        } catch (err) {
            debugLog('[AcpAdapter]', `session/setConfiguration also not supported (non-fatal): ${err instanceof Error ? err.message : err}`);
        }
    }

    // ─── Core ACP Invocation flow ───

    async invoke(
        prompt: string,
        mode: AgentMode,
        sessionId?: string,
        onUpdate?: (chunk: string) => void,
        extraEnv?: Record<string, string>,
        options?: { model?: string; autopilot?: boolean; maxContinues?: number }
    ): Promise<string> {
        if (this._persistent) {
            return this._invokePersistent(prompt, mode, sessionId, onUpdate, extraEnv, options);
        }
        return this._invokeEphemeral(prompt, mode, sessionId, onUpdate, extraEnv, options);
    }

    /**
     * Ensure the ACP process is spawned and initialized. Idempotent.
     * Auto-recovers from process crashes by respawning.
     */
    private async _ensureReady(extraEnv?: Record<string, string>): Promise<void> {
        if (this.isAlive()) return;

        // Clean up dead process if any
        if (this.process) {
            try { this.process.kill('SIGTERM'); } catch { /* already dead */ }
            this.process = undefined;
            this._initialized = false;
        }

        this.spawnProcess(extraEnv);

        const initResult = await this.sendRequest('initialize', {
            protocolVersion: 1,
            capabilities: {},
            clientInfo: { name: 'optimus', version: '0.4.0' }
        });
        debugLog('[AcpAdapter]', `Initialize OK (persistent): ${JSON.stringify(initResult)?.substring(0, 200)}`);
        this._initialized = true;
    }

    /**
     * Persistent mode: process stays alive between invocations.
     * Each call creates a new session, sends prompt, collects output.
     * Process is NOT killed after completion — reused by next invocation.
     */
    private async _invokePersistent(
        prompt: string,
        mode: AgentMode,
        sessionId?: string,
        onUpdate?: (chunk: string) => void,
        extraEnv?: Record<string, string>,
        options?: { model?: string; autopilot?: boolean; maxContinues?: number }
    ): Promise<string> {
        debugLog('[AcpAdapter]', `Invoking persistent for ${this.name} (mode=${mode}, resume=${!!sessionId}, invocation=#${this._invocationCount + 1})`);
        this._busy = true;
        this._invocationCount++;

        try {
            // Step 1: Ensure process is spawned and initialized (no-op if already warm)
            await this._ensureReady(extraEnv);

            // Step 2: Create or resume session (per-task, with per-task MCP env)
            const createSession = async (): Promise<string> => {
                const mcpServers = this.loadMcpServers(extraEnv);
                const sessionParams: Record<string, any> = {
                    cwd: process.cwd(),
                    mcpServers
                };
                // Embed model/mode selection in session/new for agents that support it
                if (options?.model || options?.autopilot) {
                    const configOptions: { id: string; value: string }[] = [];
                    if (options.autopilot) {
                        configOptions.push({ id: 'mode', value: 'https://agentclientprotocol.com/protocol/session-modes#autopilot' });
                    }
                    if (options.model) {
                        configOptions.push({ id: 'model', value: options.model });
                    }
                    sessionParams.configOptions = configOptions;
                }
                const newResult = await this.sendRequest('session/new', sessionParams);
                const freshSessionId = newResult?.sessionId || `acp-session-${Date.now()}`;
                debugLog('[AcpAdapter]', `New session created (persistent): ${freshSessionId}`);
                return freshSessionId;
            };

            const sendPromptWithCompatibility = async (currentSessionId: string): Promise<any> => {
                try {
                    return await this.sendRequest('session/prompt', {
                        sessionId: currentSessionId,
                        prompt: [{ type: 'text', text: prompt }]
                    });
                } catch (err) {
                    if (!this.isInvalidParamsError(err)) throw err;
                    debugLog('[AcpAdapter]', `session/prompt rejected content-array params; retrying text param`);
                    return await this.sendRequest('session/prompt', {
                        sessionId: currentSessionId,
                        text: prompt
                    });
                }
            };

            let currentSessionId: string;
            if (sessionId) {
                try {
                    const loadResult = await this.sendRequest('session/load', { sessionId });
                    currentSessionId = loadResult?.sessionId || sessionId;
                    debugLog('[AcpAdapter]', `Session loaded (persistent): ${currentSessionId}`);
                } catch (err) {
                    if (!this.isInvalidParamsError(err)) throw err;
                    debugLog('[AcpAdapter]', `session/load rejected; falling back to fresh session`);
                    currentSessionId = await createSession();
                }
            } else {
                currentSessionId = await createSession();
            }
            this.lastSessionId = currentSessionId;

            // Step 2.5: Configure session mode (autopilot) and model if requested
            await this.configureSession(currentSessionId, options);

            // Step 3: Register notification handler and send prompt
            const outputChunks: string[] = [];
            this.notificationHandlers.set('session/update', (params: any) => {
                this.lastUpdateTime = Date.now();
                const update = params?.update;
                if (!update) return;

                if (update.sessionUpdate === 'agent_message_chunk') {
                    const text = update.content?.text || '';
                    if (text) {
                        outputChunks.push(text);
                        if (onUpdate) onUpdate(text);
                    }
                    if (update._meta?.usage) {
                        this.lastUsageLog = JSON.stringify(update._meta.usage);
                    }
                } else if (update.sessionUpdate === 'agent_thought_chunk') {
                    const text = update.content?.text || '';
                    if (text && onUpdate) onUpdate(`[thinking] ${text}`);
                }
            });

            this.lastUpdateTime = Date.now();
            if (this.activityTimeoutMs > 0) {
                const checkInterval = Math.min(this.activityTimeoutMs / 4, 30000);
                this.activityTimer = setInterval(() => {
                    const elapsed = Date.now() - this.lastUpdateTime;
                    if (elapsed >= this.activityTimeoutMs) {
                        const timeoutErr = new Error(
                            `ACP task_timeout: no activity from engine for ${Math.round(elapsed / 1000)}s ` +
                            `(limit: ${Math.round(this.activityTimeoutMs / 1000)}s). ` +
                            `The agent may be hung or the task may be too complex. ` +
                            `Fix: retry, or increase timeout via runtime_policy.timeout_ms or config timeout.activity_ms.`
                        );
                        debugLog('[AcpAdapter]', timeoutErr.message);
                        this.stopActivityTimer();
                        this.rejectAllPending(timeoutErr);
                    }
                }, checkInterval);
            }

            let promptResult: any;
            try {
                promptResult = await sendPromptWithCompatibility(currentSessionId);
            } catch (err) {
                if (!sessionId || !this.isInvalidParamsError(err)) throw err;
                debugLog('[AcpAdapter]', `Persisted session rejected; retrying with fresh session`);
                currentSessionId = await createSession();
                this.lastSessionId = currentSessionId;
                promptResult = await sendPromptWithCompatibility(currentSessionId);
            }
            this.stopActivityTimer();

            const fullOutput = outputChunks.join('');
            if (!this.lastDebugInfo) this.lastDebugInfo = {};
            this.lastDebugInfo.endTime = Date.now();
            debugLog('[AcpAdapter]', `Done (persistent, #${this._invocationCount}). Output: ${fullOutput.length} chars`);
            return fullOutput;

        } catch (err: any) {
            debugLog('[AcpAdapter]', `Error during persistent ACP flow: ${err.message}`);
            // If process died, mark for re-init on next invoke
            if (!this.process || this.process.killed) {
                this._initialized = false;
            }
            throw err;
        } finally {
            this._busy = false;
            this._idleSince = Date.now();
            this.stopActivityTimer();
            this.notificationHandlers.clear();
            // Do NOT cleanup/kill process — keep alive for next invocation
        }
    }

    /**
     * Ephemeral mode (original behavior): spawn, work, kill.
     */
    private async _invokeEphemeral(
        prompt: string,
        mode: AgentMode,
        sessionId?: string,
        onUpdate?: (chunk: string) => void,
        extraEnv?: Record<string, string>,
        options?: { model?: string; autopilot?: boolean; maxContinues?: number }
    ): Promise<string> {
        debugLog('[AcpAdapter]', `Invoking for ${this.name} (mode=${mode}, resume=${!!sessionId})`);

        // Step 1: Spawn the subprocess transport
        this.spawnProcess(extraEnv);

        try {
            const createSession = async (): Promise<string> => {
                const mcpServers = this.loadMcpServers();
                const sessionParams: Record<string, any> = {
                    cwd: process.cwd(),
                    mcpServers
                };
                if (options?.model || options?.autopilot) {
                    const configOptions: { id: string; value: string }[] = [];
                    if (options.autopilot) {
                        configOptions.push({ id: 'mode', value: 'https://agentclientprotocol.com/protocol/session-modes#autopilot' });
                    }
                    if (options.model) {
                        configOptions.push({ id: 'model', value: options.model });
                    }
                    sessionParams.configOptions = configOptions;
                }
                const newResult = await this.sendRequest('session/new', sessionParams);
                const freshSessionId = newResult?.sessionId || `acp-session-${Date.now()}`;
                debugLog('[AcpAdapter]', `New session created: ${freshSessionId}`);
                return freshSessionId;
            };

            const sendPromptWithCompatibility = async (currentSessionId: string): Promise<any> => {
                try {
                    return await this.sendRequest('session/prompt', {
                        sessionId: currentSessionId,
                        prompt: [{ type: 'text', text: prompt }]
                    });
                } catch (err) {
                    if (!this.isInvalidParamsError(err)) {
                        throw err;
                    }
                    debugLog('[AcpAdapter]', `session/prompt rejected content-array params; retrying text param for session ${currentSessionId}`);
                    return await this.sendRequest('session/prompt', {
                        sessionId: currentSessionId,
                        text: prompt
                    });
                }
            };

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
                try {
                    const loadResult = await this.sendRequest('session/load', { sessionId });
                    currentSessionId = loadResult?.sessionId || sessionId;
                    debugLog('[AcpAdapter]', `Session loaded: ${currentSessionId}`);
                } catch (err) {
                    if (!this.isInvalidParamsError(err)) {
                        throw err;
                    }
                    debugLog('[AcpAdapter]', `session/load rejected persisted session ${sessionId}; falling back to a fresh ACP session`);
                    currentSessionId = await createSession();
                }
            } else {
                currentSessionId = await createSession();
            }
            this.lastSessionId = currentSessionId;

            // Step 3.5: Configure session mode and model
            await this.configureSession(currentSessionId, options);

            // Step 4 + 5 + 6: Send prompt, collect streaming updates, await final response
            const outputChunks: string[] = [];

            // Register notification handler for streaming updates
            this.notificationHandlers.set('session/update', (params: any) => {
                // Reset activity timer on every update
                this.lastUpdateTime = Date.now();

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
            // Start activity watchdog before sending — any session/update resets the clock
            this.lastUpdateTime = Date.now();
            if (this.activityTimeoutMs > 0) {
                const checkInterval = Math.min(this.activityTimeoutMs / 4, 30000);
                this.activityTimer = setInterval(() => {
                    const elapsed = Date.now() - this.lastUpdateTime;
                    if (elapsed >= this.activityTimeoutMs) {
                        const timeoutErr = new Error(
                            `ACP task_timeout: no activity from engine for ${Math.round(elapsed / 1000)}s ` +
                            `(limit: ${Math.round(this.activityTimeoutMs / 1000)}s). ` +
                            `The agent may be hung or the task may be too complex. ` +
                            `Fix: retry, or increase timeout via runtime_policy.timeout_ms or config timeout.activity_ms.`
                        );
                        debugLog('[AcpAdapter]', timeoutErr.message);
                        this.stopActivityTimer();
                        this.rejectAllPending(timeoutErr);
                        this.cleanup();
                    }
                }, checkInterval);
            }
            let promptResult: any;
            try {
                promptResult = await sendPromptWithCompatibility(currentSessionId);
            } catch (err) {
                if (!sessionId || !this.isInvalidParamsError(err)) {
                    throw err;
                }
                debugLog('[AcpAdapter]', `Persisted session ${currentSessionId} rejected prompt params; creating a fresh session and retrying once`);
                currentSessionId = await createSession();
                this.lastSessionId = currentSessionId;
                promptResult = await sendPromptWithCompatibility(currentSessionId);
            }
            this.stopActivityTimer();

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
     * Load project MCP server config and convert it to ACP array format.
     * ACP expects: [{ name, command, args, env: [{ name, value }] }]
     *
     * In persistent mode, per-task env vars (delegation depth, role, etc.)
     * are injected into each MCP server's env config so child processes
     * get the correct context even though the ACP process is reused.
     */
    private loadMcpServers(extraEnv?: Record<string, string>): any[] {
        const cwd = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
        const servers = loadProjectMcpServers(cwd, 'runtime');

        if (!servers) {
            debugLog('[AcpAdapter]', 'No project MCP config found, mcpServers=[]');
            return [];
        }

        const acpServers = Object.entries(servers).map(([name, config]: [string, any]) => {
            const envEntries = Object.entries(config.env || {}).map(([k, v]) => ({ name: k, value: String(v) }));

            // Inject per-task env vars into MCP server configs
            if (extraEnv) {
                for (const [k, v] of Object.entries(extraEnv)) {
                    if (v !== undefined && v !== '') {
                        const existingIdx = envEntries.findIndex(e => e.name === k);
                        if (existingIdx >= 0) {
                            envEntries[existingIdx].value = v;
                        } else {
                            envEntries.push({ name: k, value: v });
                        }
                    }
                }
            }

            return {
                name,
                command: config.command || '',
                args: config.args || [],
                env: envEntries
            };
        });

        debugLog('[AcpAdapter]', `Loaded ${acpServers.length} MCP servers: ${acpServers.map(s => s.name).join(', ')}`);
        return acpServers;
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
