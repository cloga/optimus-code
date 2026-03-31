import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
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
