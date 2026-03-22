/**
 * Optimus Agent Runtime — TypeScript SDK
 *
 * A thin HTTP client for consuming the Optimus Agent Runtime API
 * from TypeScript/JavaScript applications.
 *
 * Usage:
 *   import { OptimusRuntime } from '@cloga/optimus-swarm-mcp/sdk';
 *
 *   const runtime = new OptimusRuntime({ baseUrl: 'http://localhost:3100' });
 *   const result = await runtime.runAgent({ role: 'writer', input: { ... } });
 *
 * The SDK wraps the REST API with typed methods and clean error handling.
 * No MCP, JSON-RPC, or transport details are exposed.
 */
import type {
    AgentRuntimeRequest,
    AgentRuntimeEnvelope,
    AgentRuntimePolicy,
} from '../utils/agentRuntime';

// ─── SDK Types ───

export interface RuntimeOptions {
    /** Base URL of the Optimus HTTP runtime server. Default: http://localhost:3100 */
    baseUrl?: string;
    /** Default workspace path (used if not specified per-request) */
    workspacePath?: string;
    /** Request timeout in milliseconds. Default: 300000 (5 min) */
    timeoutMs?: number;
    /** Custom headers to include in every request */
    headers?: Record<string, string>;
}

export interface RunAgentInput {
    role: string;
    input: unknown;
    skill?: string;
    instructions?: string;
    output_schema?: unknown;
    runtime_policy?: AgentRuntimePolicy;
    role_description?: string;
    role_engine?: string;
    role_model?: string;
    agent_id?: string;
    context_files?: string[];
    workspace_path?: string;
}

export interface ResumeInput {
    human_answer: string;
    workspace_path?: string;
}

export interface CancelInput {
    reason?: string;
    workspace_path?: string;
}

export class RuntimeApiError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly httpStatus: number,
        public readonly body?: unknown
    ) {
        super(message);
        this.name = 'RuntimeApiError';
    }
}

// ─── SDK Client ───

export class OptimusRuntime {
    private baseUrl: string;
    private workspacePath?: string;
    private timeoutMs: number;
    private headers: Record<string, string>;

    constructor(options: RuntimeOptions = {}) {
        this.baseUrl = (options.baseUrl || 'http://localhost:3100').replace(/\/+$/, '');
        this.workspacePath = options.workspacePath;
        this.timeoutMs = options.timeoutMs || 300_000;
        this.headers = options.headers || {};
    }

    /**
     * Run an agent synchronously. Blocks until the run completes, fails, or times out.
     * Returns the full AgentRuntimeEnvelope with result or error.
     */
    async runAgent(input: RunAgentInput): Promise<AgentRuntimeEnvelope> {
        const body = this.buildRequestBody(input);
        return this.post('/api/v1/agent/run', body);
    }

    /**
     * Start an agent run asynchronously. Returns immediately with run_id.
     * Use getStatus() to poll for completion.
     */
    async startRun(input: RunAgentInput): Promise<AgentRuntimeEnvelope> {
        const body = this.buildRequestBody(input);
        return this.post('/api/v1/agent/start', body);
    }

    /**
     * Get the current status of a run.
     */
    async getStatus(runId: string, workspacePath?: string): Promise<AgentRuntimeEnvelope> {
        const headers: Record<string, string> = {};
        if (workspacePath || this.workspacePath) {
            headers['X-Optimus-Workspace'] = workspacePath || this.workspacePath!;
        }
        return this.request('GET', `/api/v1/agent/runs/${encodeURIComponent(runId)}`, undefined, headers);
    }

    /**
     * Resume a run that is blocked on manual intervention.
     */
    async resumeRun(runId: string, input: ResumeInput): Promise<AgentRuntimeEnvelope> {
        const body = {
            human_answer: input.human_answer,
            workspace_path: input.workspace_path || this.workspacePath,
        };
        return this.post(`/api/v1/agent/runs/${encodeURIComponent(runId)}/resume`, body);
    }

    /**
     * Cancel an active run.
     */
    async cancelRun(runId: string, input?: CancelInput): Promise<AgentRuntimeEnvelope> {
        const body = {
            reason: input?.reason,
            workspace_path: input?.workspace_path || this.workspacePath,
        };
        return this.post(`/api/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, body);
    }

    /**
     * Health check.
     */
    async health(): Promise<{ status: string; version: string; workspace: string; uptime_ms: number }> {
        return this.request('GET', '/api/v1/health');
    }

    /**
     * Poll for run completion. Convenience wrapper around getStatus().
     */
    async waitForCompletion(runId: string, options?: { pollIntervalMs?: number; timeoutMs?: number; workspacePath?: string }): Promise<AgentRuntimeEnvelope> {
        const pollInterval = options?.pollIntervalMs || 2000;
        const timeout = options?.timeoutMs || this.timeoutMs;
        const startedAt = Date.now();

        while (true) {
            const envelope = await this.getStatus(runId, options?.workspacePath);
            const terminal = ['completed', 'failed', 'blocked_manual_intervention', 'cancelled'];
            if (terminal.includes(envelope.status)) {
                return envelope;
            }

            if (Date.now() - startedAt > timeout) {
                return this.cancelRun(runId, { reason: `Client-side timeout after ${timeout}ms` });
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
    }

    // ─── Internal ───

    private buildRequestBody(input: RunAgentInput): Record<string, unknown> {
        return {
            role: input.role,
            input: input.input,
            ...(input.skill !== undefined ? { skill: input.skill } : {}),
            ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
            ...(input.output_schema !== undefined ? { output_schema: input.output_schema } : {}),
            ...(input.runtime_policy !== undefined ? { runtime_policy: input.runtime_policy } : {}),
            ...(input.role_description !== undefined ? { role_description: input.role_description } : {}),
            ...(input.role_engine !== undefined ? { role_engine: input.role_engine } : {}),
            ...(input.role_model !== undefined ? { role_model: input.role_model } : {}),
            ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
            ...(input.context_files !== undefined ? { context_files: input.context_files } : {}),
            workspace_path: input.workspace_path || this.workspacePath,
        };
    }

    private async post(path: string, body: unknown): Promise<any> {
        return this.request('POST', path, body);
    }

    private async request(method: string, urlPath: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<any> {
        const url = `${this.baseUrl}${urlPath}`;
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            ...this.headers,
            ...extraHeaders,
        };

        const fetchOptions: RequestInit = {
            method,
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
        };

        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);
        const responseBody = await response.text();

        let parsed: any;
        try {
            parsed = JSON.parse(responseBody);
        } catch {
            throw new RuntimeApiError(
                `Invalid JSON response from server: ${responseBody.slice(0, 200)}`,
                'invalid_response',
                response.status
            );
        }

        if (parsed.error) {
            throw new RuntimeApiError(
                parsed.error.message || 'Unknown API error',
                parsed.error.code || 'api_error',
                response.status,
                parsed
            );
        }

        return parsed;
    }
}
