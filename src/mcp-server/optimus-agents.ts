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
import * as fs from "fs";
import * as path from "path";
import { AUTOMATION_CONTINUATION_VALUES, AUTOMATION_MODE_VALUES, getClaudeCliAutomationArgs, getCopilotCliAutomationArgs } from "../utils/automationPolicy";

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

const automationModeSchema = z.enum(AUTOMATION_MODE_VALUES);
const automationContinuationSchema = z.enum(AUTOMATION_CONTINUATION_VALUES);

function getClaudeAutomationConfig(mode: "plan" | "agent", automationMode?: z.infer<typeof automationModeSchema>) {
    return mode === "plan"
        ? { mode: "plan" as const }
        : { mode: automationMode || "auto-approve" };
}

function getCopilotAutomationConfig(
    mode: "plan" | "agent",
    automationMode?: z.infer<typeof automationModeSchema>,
    automationContinuation?: z.infer<typeof automationContinuationSchema>,
    maxContinues?: number,
) {
    return mode === "plan"
        ? { mode: "plan" as const, continuation: "single" as const }
        : {
            mode: automationMode || "auto-approve",
            continuation: automationContinuation || "autopilot",
            max_continues: maxContinues,
        };
}

function runCli(cmd: string, args: string[], cwd: string, timeoutMs = 300_000): Promise<CliResult> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";

        const safeEnv: NodeJS.ProcessEnv = { ...process.env, TERM: "dumb", CI: "false", FORCE_COLOR: "0" };
        if (process.platform === 'win32' && !safeEnv.CLAUDE_CODE_GIT_BASH_PATH) {
            safeEnv.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
        }

        const child = cp.spawn(cmd, args, {
            cwd,
            env: safeEnv as any,
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
            windowsHide: true
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
        automation_mode: automationModeSchema.optional().describe("Normalized automation policy. Prefer auto-approve / interactive / accept-edits / deny-unapproved over vendor-specific names."),
        model: z.string().optional().describe("Model override (e.g. 'opus', 'sonnet')"),
        session_id: z.string().optional().describe("Resume session by UUID"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, mode, automation_mode, model, session_id, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--add-dir", cwd];
        args.push(...getClaudeCliAutomationArgs(mode, getClaudeAutomationConfig(mode, automation_mode)));
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
        automation_mode: automationModeSchema.optional().describe("Normalized automation policy for the resumed Claude session."),
        model: z.string().optional().describe("Model override"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, session_id, automation_mode, model, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--resume", session_id, "--add-dir", cwd];
        args.push(...getClaudeCliAutomationArgs("agent", getClaudeAutomationConfig("agent", automation_mode)));
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
        automation_mode: automationModeSchema.optional().describe("Normalized approval policy. Copilot currently supports interactive and auto-approve best."),
        automation_continuation: automationContinuationSchema.optional().describe("Continuation policy. Use autopilot to enable multi-step continuation in Copilot CLI."),
        max_continues: z.number().int().min(0).optional().describe("Maximum autopilot continuations when automation_continuation=autopilot."),
        model: z.string().optional().describe("Model override (e.g. 'gpt-5.2', 'o3')"),
        session_id: z.string().optional().describe("Resume session by UUID"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, mode, automation_mode, automation_continuation, max_continues, model, session_id, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--add-dir", cwd];
        args.push(...getCopilotCliAutomationArgs(mode, getCopilotAutomationConfig(mode, automation_mode, automation_continuation, max_continues)));
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
        automation_mode: automationModeSchema.optional().describe("Normalized approval policy for the resumed Copilot session."),
        automation_continuation: automationContinuationSchema.optional().describe("Continuation policy for the resumed Copilot session."),
        max_continues: z.number().int().min(0).optional().describe("Maximum autopilot continuations when automation_continuation=autopilot."),
        model: z.string().optional().describe("Model override"),
        workdir: z.string().optional().describe("Working directory"),
    },
    async ({ prompt, session_id, automation_mode, automation_continuation, max_continues, model, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        const args = ["-p", prompt, "--resume", session_id, "--add-dir", cwd];
        args.push(...getCopilotCliAutomationArgs("agent", getCopilotAutomationConfig("agent", automation_mode, automation_continuation, max_continues)));
        if (model) { args.push("--model", model); }
        args.push("--output-format", "json", "--stream", "on");

        const r = await runCli("copilot", args, cwd);
        if (r.error) { return makeError(r.error, r.output); }
        const parsed = parseCopilotJson(r.output);
        return makeResult(parsed.text, session_id, parsed.usage);
    }
);

// ── Swarm / Delegation Tool ───────────────────────────────────────────────

server.tool(
    "delegate_task",
    "Delegate a task to a specialized Sub-Agent (Worker). Use this to spin up a new worker or resume an existing worker by ID.",
    {
        engine: z.enum(["claude_code", "copilot_cli"]).optional().describe("The CLI engine. Omit to use the agent's default."),
        model: z.string().optional().describe("The specific model to use (e.g., 'gpt-5.4', 'claude-opus-4.6-1m'). Omit to use the CLI's default."),
        instruction: z.string().describe("The specific task or prompt for the worker to execute."),
        role_prompt: z.string().optional().describe("Optional persona/system prompt (e.g., 'You are a QA engineer focused on unit tests.')."),
        session_id: z.string().optional().describe("If resuming a previous worker, provide its session UUID. If omitted, a new worker is created."),
        automation_mode: automationModeSchema.optional().describe("Normalized automation policy to apply to the delegated worker."),
        automation_continuation: automationContinuationSchema.optional().describe("Continuation policy for the delegated worker. Copilot supports autopilot continuation."),
        max_continues: z.number().int().min(0).optional().describe("Maximum autopilot continuations when automation_continuation=autopilot."),
        workdir: z.string().optional().describe("Working directory for the worker."),
    },
    async ({ engine, model, instruction, role_prompt, session_id, automation_mode, automation_continuation, max_continues, workdir }) => {
        const cwd = workdir || getWorkspaceRoot();
        
        let prompt = instruction;
        let finalEngine = engine;
        let finalModel = model;

        if (role_prompt && !session_id) {
            // Prepend role if it's a new session
            let roleContent = role_prompt;
            try {
                // Try to load the corresponding agent plugin from resources/plugins/roles
                const possiblePaths = [
                    path.join(__dirname, "../../../resources/plugins/roles", `${role_prompt}.md`), // if in out/mcp-server/
                    path.join(__dirname, "../../resources/plugins/roles", `${role_prompt}.md`)   // if in src/mcp-server/
                ];
                
                let foundPath = "";
                for (const p of possiblePaths) {
                    if (fs.existsSync(p)) {
                        foundPath = p;
                        break;
                    }
                }

                if (foundPath) {
                    roleContent = fs.readFileSync(foundPath, "utf-8");
                    
                    // Parse YAML frontmatter for defaults
                    const fmMatch = roleContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                    if (fmMatch) {
                        const fm = fmMatch[1];
                        if (!finalEngine) {
                            const eMatch = fm.match(/defaultEngine:\s*([^\r\n]+)/);
                            if (eMatch) finalEngine = eMatch[1].trim() as any;
                        }
                        if (!finalModel) {
                            const mMatch = fm.match(/defaultModel:\s*([^\r\n]+)/);
                            if (mMatch) finalModel = mMatch[1].trim();
                        }
                        // Strip frontmatter from prompt to avoid confusing the CLI
                        roleContent = roleContent.slice(fmMatch[0].length).trim();
                    }
                }
            } catch (err) {
                console.error(`Failed to load role plugin for ${role_prompt}:`, err);
            }

            prompt = `[SYSTEM PERSONA/ROLE]:\n${roleContent}\n\n[TASK]:\n${instruction}`;
        }

        // Fallback to claude_code if still no engine resolved
        finalEngine = finalEngine || "claude_code";

        if (finalEngine === "claude_code") {
            const args = ["-p", prompt, "--add-dir", cwd];
            args.push(...getClaudeCliAutomationArgs("agent", getClaudeAutomationConfig("agent", automation_mode)));
            if (finalModel) { args.push("--model", finalModel); }
            if (session_id) { args.push("--resume", session_id); }
            args.push("--output-format", "stream-json", "--verbose");

            const r = await runCli("claude", args, cwd);
            if (r.error) { return makeError(r.error, r.output); }
            const parsed = parseClaudeStreamJson(r.output);
            return makeResult(`Worker output:\n${parsed.text}`, r.sessionId, parsed.usage);
            
        } else if (finalEngine === "copilot_cli") {
            const args = ["-p", prompt, "--add-dir", cwd];
            args.push(...getCopilotCliAutomationArgs("agent", getCopilotAutomationConfig("agent", automation_mode, automation_continuation, max_continues)));
            if (finalModel) { args.push("--model", finalModel); }
            if (session_id) { args.push("--resume", session_id); }
            args.push("--output-format", "json", "--stream", "on");

            const r = await runCli("copilot", args, cwd);
            if (r.error) { return makeError(r.error, r.output); }
            const parsed = parseCopilotJson(r.output);
            return makeResult(`Worker output:\n${parsed.text}`, r.sessionId, parsed.usage);
        }

        return makeError("Invalid engine specified.");
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
