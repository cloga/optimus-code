import { describe, expect, it } from 'vitest';
import path from 'path';
import { renderCanonicalMcpServers } from '../utils/mcpConfig';

const canonicalConfig = {
    version: 1,
    servers: {
        'spartan-swarm': {
            type: 'stdio',
            command: 'node',
            args: ['${workspaceRoot}/.optimus/dist/mcp-server.js'],
            env: {
                OPTIMUS_WORKSPACE_ROOT: '${workspaceRoot}',
                DOTENV_PATH: '${workspaceRoot}/.env'
            },
            clients: {
                vscode: {
                    env: {
                        PATH: '${env:PATH}'
                    }
                }
            }
        }
    }
};

describe('mcp config rendering', () => {
    it('renders VS Code config with workspace macros and client overrides', () => {
        const rendered = renderCanonicalMcpServers(canonicalConfig, 'vscode', 'C:\\workspace');
        expect(rendered['spartan-swarm']).toEqual({
            type: 'stdio',
            command: 'node',
            args: ['${workspaceFolder}/.optimus/dist/mcp-server.js'],
            env: {
                OPTIMUS_WORKSPACE_ROOT: '${workspaceFolder}',
                DOTENV_PATH: '${workspaceFolder}/.env',
                PATH: '${env:PATH}'
            }
        });
    });

    it('renders Claude config as portable project-relative paths', () => {
        const rendered = renderCanonicalMcpServers(canonicalConfig, 'claude', 'C:\\workspace');
        expect(rendered['spartan-swarm']).toEqual({
            type: 'stdio',
            command: 'node',
            args: ['./.optimus/dist/mcp-server.js'],
            env: {
                OPTIMUS_WORKSPACE_ROOT: '.',
                DOTENV_PATH: './.env'
            }
        });
    });

    it('renders runtime config with absolute paths', () => {
        const workspaceRoot = path.join('C:\\', 'workspace');
        const rendered = renderCanonicalMcpServers(canonicalConfig, 'runtime', workspaceRoot);
        expect(rendered['spartan-swarm']).toEqual({
            type: 'stdio',
            command: 'node',
            args: [path.join(workspaceRoot, '.optimus', 'dist', 'mcp-server.js')],
            env: {
                OPTIMUS_WORKSPACE_ROOT: workspaceRoot,
                DOTENV_PATH: path.join(workspaceRoot, '.env')
            }
        });
    });
});
