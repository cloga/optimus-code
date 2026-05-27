import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WORKSPACE = process.cwd();
const SERVER_PATH = path.join(WORKSPACE, 'optimus-plugin', 'dist', 'mcp-server.js');
const activeConnections: Array<{ client: Client; transport: StdioClientTransport }> = [];

async function connectClient() {
    const transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH],
        cwd: WORKSPACE,
        env: { ...process.env, OPTIMUS_WORKSPACE_ROOT: WORKSPACE } as Record<string, string>,
        stderr: 'pipe',
    });

    const client = new Client({ name: 'delegate-task-compat-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const connection = { client, transport };
    activeConnections.push(connection);
    return connection;
}

afterEach(async () => {
    while (activeConnections.length > 0) {
        const data = activeConnections.pop()!;
        try {
            await data.transport.close();
        } catch {}
        try {
            await data.client.close();
        } catch {}
    }
});

describe('delegate_task compatibility layer', () => {
    it('advertises delegate_task as a blocking compatibility wrapper', async () => {
        const data = await connectClient();

        const tools = await data.client.listTools();
        const delegateTool = tools.tools.find(tool => tool.name === 'delegate_task');

        expect(delegateTool).toBeDefined();
        expect(delegateTool?.description).toContain('Blocking compatibility wrapper');
        expect(delegateTool?.description).toContain('Prefer delegate_task_async');
    });

    it('advertises dispatch_plan_async for optimus-like batch orchestration', async () => {
        const data = await connectClient();

        const tools = await data.client.listTools();
        const planTool = tools.tools.find(tool => tool.name === 'dispatch_plan_async');

        expect(planTool).toBeDefined();
        expect(planTool?.description).toContain('batch of work items');
        expect(planTool?.description).toContain('dependency edges');
    });

    it('documents and implements async tools as non-blocking by default in source', () => {
        const source = fs.readFileSync(path.join(WORKSPACE, 'src', 'mcp', 'mcp-server.ts'), 'utf8');

        expect(source).toContain('Default is false, so the tool returns promptly after queueing/spawning the background task.');
        expect(source).toContain('Default is false, so the tool returns promptly after queueing/spawning background tasks.');
        expect(source).toContain('Optional timeout used only when wait_for_completion is true.');
        expect(source).toContain('const wait_for_completion = (request.params.arguments as any).wait_for_completion === true;');
        expect(source).not.toContain('wait_for_completion ?? true');
    });

    it('advertises delegate_task_async as an async non-blocking tool', async () => {
        const data = await connectClient();

        const tools = await data.client.listTools();
        const asyncTool = tools.tools.find(tool => tool.name === 'delegate_task_async');

        expect(asyncTool).toBeDefined();
        expect(asyncTool?.description).toContain('without blocking');
    });

    it('advertises optimus_orchestrate for automatic orchestration selection', async () => {
        const data = await connectClient();

        const tools = await data.client.listTools();
        const optimusTool = tools.tools.find(tool => tool.name === 'optimus_orchestrate');

        expect(optimusTool).toBeDefined();
        expect(optimusTool?.description).toContain('choose the best orchestration mode');
        expect(optimusTool?.description).toContain('safe parallelism');
        const schemaProperties = (optimusTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties || {};
        expect(schemaProperties).toHaveProperty('wait_for_completion');
        expect(schemaProperties).toHaveProperty('completion_timeout_ms');
    });

    it('advertises explicit scheduler control tools for interruptible work', async () => {
        const data = await connectClient();

        const tools = await data.client.listTools();
        const byName = new Map(tools.tools.map(tool => [tool.name, tool]));

        for (const name of ['scheduler_pause_task', 'scheduler_resume_task', 'scheduler_reassign_task', 'scheduler_get_task', 'scheduler_checkpoint_task', 'scheduler_handoff_task', 'scheduler_yield_task', 'scheduler_resume_context', 'scheduler_promote_memory']) {
            expect(byName.get(name)).toBeDefined();
            const schemaProperties = (byName.get(name)?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties || {};
            expect(schemaProperties).toHaveProperty('workspace_path');
            expect(schemaProperties).toHaveProperty('task_id');
        }
        expect(byName.get('scheduler_pause_task')?.description).toContain('not ACP hot-pause');
        expect(byName.get('scheduler_reassign_task')?.description).toContain('redispatch');
        expect(byName.get('scheduler_checkpoint_task')?.description).toContain('without stopping running sub-agents');
        expect(byName.get('scheduler_handoff_task')?.description).toContain('without pausing existing worker runs');
        expect(byName.get('scheduler_yield_task')?.description).toContain('without changing running sub-agent state');
        expect(byName.get('scheduler_resume_context')?.description).toContain('durable task_events');
        expect(byName.get('scheduler_promote_memory')?.description).toContain('never copies the full scheduler event log');
    });

    it('rejects synchronous delegate_task calls without workspace_path', async () => {
        const data = await connectClient();

        await expect(data.client.callTool({
            name: 'delegate_task',
            arguments: {
                role: 'dev',
                task_description: 'no-op',
                output_path: path.join(WORKSPACE, '.optimus', 'results', 'missing-workspace-path.md'),
            }
        })).rejects.toThrow(/missing required parameter\(s\): workspace_path/i);
    });
});
