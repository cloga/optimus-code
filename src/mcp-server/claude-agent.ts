#!/usr/bin/env node
/**
 * MCP Server: Optimus Agents
 *
 * Exposes both Claude CLI and Copilot CLI as MCP tools.
 *
 * Tools:
 *   - claude_code:        Execute a task via Claude Code CLI
 *   - claude_code_resume: Continue an existing Claude session
 *   - copilot_cli:        Execute a task via GitHub Copilot CLI
 *   - copilot_cli_resume: Continue an existing Copilot session
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cp from "child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): string {
    return process.env.OPTIMUS_WORKSPACE || process.cwd();
}

function stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

interface CliResult {
    output: string;
    sessionId: string | null;
    error: string | null;
}

function runCli(cmd: string, args: string[], cwd: string, timeoutMs = 300_000): Promise<CliResult> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";

        const child = cp.spawn(cmd, args, {
            cwd,
            env: { ...process.env, TERM: "dumb", CI: "false", FORCE_COLOR: "0" },
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
        });

        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            resolve({ output: stripAnsi(stdout).trim(), sessionId: null, error: `Timed out after ${timeoutMs}ms` });
        }, timeoutMs);

        child.on("close", (code) => {
            clearTimeout(timer);
            const cleanOut = stripAnsi(stdout).trim();
            const cleanErr = stripAnsi(stderr).trim();

            let sessionId: string | null = null;
            const sidMatch = cleanErr.match(/session[_\s]?id[:\s]+([0-9a-f-]{36})/i)
                || cleanOut.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/i)
                || cleanOut.match(/sessionId[:\s]+"?([0-9a-f-]{36})"?/i);
            if (sidMatch) { sessionId = sidMatch[1]; }

            if (code !== 0 && !cleanOut) {
                resolve({ output: "", sessionId, error: cleanErr || `Exit code ${code}` });
            } else {
                resolve({ output: cleanOut, sessionId, error: null });
            }
        });

        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ output: "", sessionId: null, error: err.message });
        });
    });
}

function parseClaudeStreamJson(raw: string): { text: string; usage: string } {
    let assistantText = "";
    let usage = "";
    try {
        for (const line of raw.split("\n").filter(l => l.trim())) {
            const event = JSON.parse(line);
            if (event.type === "assistant" && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === "text") { assistantText += block.text; }
                }
            }
            if (event.type === "content_block_delta" && event.delta?.text) {
                assistantText += event.delta.text;
            }
            if (event.type === "result" && typeof event.result === "string") {
                assistantText = event.result;
                if (event.usage) {
                    const u = event.usage;
                    usage = [
                        u.input_tokens ? `In: ${u.input_tokens}` : "",
                        u.output_tokens ? `Out: ${u.output_tokens}` : "",
                        event.total_cost_usd ? `$${event.total_cost_usd.toFixed(4)}` : "",
                        event.duration_ms ? `${event.duration_ms}ms` : "",
                    ].filter(Boolean).join(" | ");
                }
            }
        }
    } catch { /* use raw */ }
    return { text: assistantText || raw, usage };
}

function parseCopilotJson(raw: string): { text: string; usage: string } {
    let assistantText = "";
    let usage = "";
    try {
        for (const line of raw.split("\n").filter(l => l.trim())) {
            const event = JSON.parse(line);
            if (event.type === "result" && typeof event.result === "string") {
                assistantText = event.result;
                if (event.usage) {
                    const u = event.usage;
                    usage = [
                        u.premiumRequests ? `Premium: ${u.premiumRequests}` : "",
                        u.totalApiDurationMs ? `API: ${u.totalApiDurationMs}ms` : "",
                        u.sessionDurationMs ? `Session: ${u.sessionDurationMs}ms` : "",
                    ].filter(Boolean).join(" | ");
                }
            }
            if (event.type === "content_block_delta" && event.delta?.text) {
                assistantText += event.delta.text;
            }
        }
    } catch { /* use raw */ }
    return { text: assistantText || raw, usage };
}

function makeResult(text: string, sessionId: string | null, usage: string) {
    const content: Array<{ type: "text"; text: string }> = [{ type: "text", text }];
    if (sessionId) { content.push({ type: "text", text: `[Session: ${sessionId}]` }); }
    if (usage) { content.push({ type: "text", text: `[${usage}]` }); }
    return { content };
}

function makeError(error: string, output?: string) {
    const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: `Error: ${error}` }];
    if (output) { content.push({ type: "text", text: output }); }
    return { content, isError: true as const };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "optimus-agents", version: "1.1.0" });

// ── Claude Code ──────────────────────────────────────────────────────────

server.tool(
    "claude_code",
    "Execute a task using Claude Code CLI. Claude can read/write files, run commands, and return results. Use for coding, refactoring, debugging, or file analysis.",
    {
        prompt: z.string().describe("Task or question for Claude"),
        mode: z.enum(["plan", "agent"]).default("agent").describe("plan = read-only, agent = full execution"),
        model: z.string().optional().describe("Model override (e.g. 'opus', 'sonnet')"),
        session_id: z.string().optional().describe("Resume session by UUID"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, mode, model, session_id, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--add-dir", cwd];
        if (mode === "plan") { args.push("--permission-mode", "plan"); }
        else { args.push("--dangerously-skip-permissions"); }
        if (model) { args.push("--model", model); }
        if (session_id) { args.push("--resume", session_id); }
        args.push("--output-format", "stream-json", "--verbose");

        const r = await runCli("claude", args, cwd);
        if (r.error) { return makeError(r.error, r.output); }
        const parsed = parseClaudeStreamJson(r.output);
        return makeResult(parsed.text, r.sessionId, parsed.usage);
    }
);

server.tool(
    "claude_code_resume",
    "Continue an existing Claude Code session with a follow-up message.",
    {
        prompt: z.string().describe("Follow-up message"),
        session_id: z.string().describe("Session UUID to resume"),
        model: z.string().optional().describe("Model override"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, session_id, model, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--resume", session_id, "--dangerously-skip-permissions", "--add-dir", cwd];
        if (model) { args.push("--model", model); }
        args.push("--output-format", "stream-json", "--verbose");

        const r = await runCli("claude", args, cwd);
        if (r.error) { return makeError(r.error, r.output); }
        const parsed = parseClaudeStreamJson(r.output);
        return makeResult(parsed.text, session_id, parsed.usage);
    }
);

// ── GitHub Copilot CLI ───────────────────────────────────────────────────

server.tool(
    "copilot_cli",
    "Execute a task using GitHub Copilot CLI. Copilot can read/write files, run commands, search code. Good for code generation, analysis, and multi-step tasks.",
    {
        prompt: z.string().describe("Task or question for Copilot"),
        mode: z.enum(["plan", "agent"]).default("agent").describe("plan = read-only, agent = full execution"),
        model: z.string().optional().describe("Model override (e.g. 'gpt-5.2', 'o3')"),
        session_id: z.string().optional().describe("Resume session by UUID"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, mode, model, session_id, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--add-dir", cwd];
        if (mode === "agent") { args.push("--allow-all-tools", "--no-ask-user"); }
        if (model) { args.push("--model", model); }
        if (session_id) { args.push("--resume", session_id); }
        args.push("--output-format", "json", "--stream", "on");

        const r = await runCli("copilot", args, cwd);
        if (r.error) { return makeError(r.error, r.output); }
        const parsed = parseCopilotJson(r.output);
        return makeResult(parsed.text, r.sessionId, parsed.usage);
    }
);

server.tool(
    "copilot_cli_resume",
    "Continue an existing Copilot CLI session with a follow-up message.",
    {
        prompt: z.string().describe("Follow-up message"),
        session_id: z.string().describe("Session UUID to resume"),
        model: z.string().optional().describe("Model override"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, session_id, model, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--resume", session_id, "--allow-all-tools", "--no-ask-user", "--add-dir", cwd];
        if (model) { args.push("--model", model); }
        args.push("--output-format", "json", "--stream", "on");

        const r = await runCli("copilot", args, cwd);
        if (r.error) { return makeError(r.error, r.output); }
        const parsed = parseCopilotJson(r.output);
        return makeResult(parsed.text, session_id, parsed.usage);
    }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Optimus Agents MCP server running (claude + copilot)");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
