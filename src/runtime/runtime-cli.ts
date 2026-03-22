#!/usr/bin/env node
/**
 * Optimus Agent Runtime — CLI Contract
 *
 * A JSON-in / JSON-out CLI for application embedding.
 * Host applications can call this without implementing MCP transport.
 *
 * Usage:
 *   optimus-runtime run     < request.json   → envelope.json (stdout)
 *   optimus-runtime start   < request.json   → envelope.json (stdout)
 *   optimus-runtime status  --run-id <id>    → envelope.json (stdout)
 *   optimus-runtime resume  < resume.json    → envelope.json (stdout)
 *   optimus-runtime cancel  --run-id <id>    → envelope.json (stdout)
 *
 * All output goes to stdout as JSON. Logs/traces go to stderr.
 * Exit code 0 = success, 1 = error (error JSON on stdout).
 *
 * Environment:
 *   OPTIMUS_WORKSPACE_ROOT — workspace path (or --workspace flag)
 */
import {
    normalizeRuntimeRequest,
    runSync,
    startRun,
    getRunStatus,
    resumeRun,
    cancelRun,
    RuntimeError
} from './agentRuntimeService';
import dotenv from 'dotenv';
import path from 'path';
import { ensureWorktreeStateDirs } from '../utils/worktree';

function getWorkspacePath(args: string[]): string {
    const wsIdx = args.indexOf('--workspace');
    if (wsIdx !== -1 && args[wsIdx + 1]) {
        return path.resolve(args[wsIdx + 1]);
    }
    return process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
}

function getArg(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return (idx !== -1 && args[idx + 1]) ? args[idx + 1] : undefined;
}

async function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);

        // If stdin is a TTY (no pipe), resolve immediately with empty string
        if (process.stdin.isTTY) {
            resolve('');
        }
    });
}

function output(data: unknown): void {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function outputError(code: string, message: string): void {
    output({ error: { code, message } });
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const workspacePath = getWorkspacePath(args);

    // Load .env
    if (process.env.DOTENV_PATH) {
        dotenv.config({ path: path.resolve(process.env.DOTENV_PATH), override: true });
    } else {
        dotenv.config({ override: true });
    }

    ensureWorktreeStateDirs(workspacePath);

    if (!command || command === '--help' || command === '-h') {
        console.error(`Usage: optimus-runtime <command> [options]

Commands:
  run      Run agent synchronously (reads JSON from stdin)
  start    Start agent asynchronously (reads JSON from stdin)
  status   Get run status (--run-id <id>)
  resume   Resume blocked run (reads JSON from stdin)
  cancel   Cancel active run (--run-id <id> [--reason "..."])

Options:
  --workspace <path>   Workspace root (default: OPTIMUS_WORKSPACE_ROOT or cwd)
  --run-id <id>        Run ID for status/cancel
  --reason <text>      Cancellation reason

Input format (stdin JSON):
  { "role": "...", "input": {...}, "instructions": "...", ... }

Output: JSON AgentRuntimeEnvelope on stdout. Logs on stderr.`);
        process.exit(0);
    }

    try {
        switch (command) {
            case 'run': {
                const input = await readStdin();
                if (!input.trim()) {
                    outputError('empty_input', 'No JSON input provided on stdin. Pipe a JSON request.');
                    return;
                }
                const body = JSON.parse(input);
                if (!body.workspace_path) body.workspace_path = workspacePath;
                const request = normalizeRuntimeRequest(body);
                console.error(`[CLI] run role=${request.role} engine=${request.role_engine || 'default'}`);
                const envelope = await runSync(request);
                output(envelope);
                break;
            }

            case 'start': {
                const input = await readStdin();
                if (!input.trim()) {
                    outputError('empty_input', 'No JSON input provided on stdin.');
                    return;
                }
                const body = JSON.parse(input);
                if (!body.workspace_path) body.workspace_path = workspacePath;
                const request = normalizeRuntimeRequest(body);
                console.error(`[CLI] start role=${request.role}`);
                const envelope = startRun(request);
                output(envelope);
                break;
            }

            case 'status': {
                const runId = getArg(args, '--run-id');
                if (!runId) {
                    outputError('missing_params', 'Missing --run-id flag.');
                    return;
                }
                const envelope = getRunStatus(workspacePath, runId);
                output(envelope);
                break;
            }

            case 'resume': {
                const input = await readStdin();
                if (!input.trim()) {
                    outputError('empty_input', 'No JSON input provided on stdin.');
                    return;
                }
                const body = JSON.parse(input);
                const runId = body.run_id || getArg(args, '--run-id');
                if (!runId) {
                    outputError('missing_params', 'Missing run_id in JSON or --run-id flag.');
                    return;
                }
                const ws = body.workspace_path || workspacePath;
                const envelope = resumeRun(ws, runId, body.human_answer);
                output(envelope);
                break;
            }

            case 'cancel': {
                const runId = getArg(args, '--run-id');
                if (!runId) {
                    outputError('missing_params', 'Missing --run-id flag.');
                    return;
                }
                const reason = getArg(args, '--reason');
                const envelope = await cancelRun(workspacePath, runId, reason);
                output(envelope);
                break;
            }

            default:
                outputError('unknown_command', `Unknown command: ${command}. Use --help.`);
        }
    } catch (err: any) {
        if (err instanceof RuntimeError) {
            outputError(err.code, err.message);
        } else {
            outputError('internal_error', err.message || 'Unknown error');
        }
    }
}

main().catch(err => {
    outputError('fatal', err.message);
});
