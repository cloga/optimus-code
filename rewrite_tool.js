const fs = require("fs");
const file = "src/extension.ts";
let code = fs.readFileSync(file, "utf8");

if (!code.includes("ClaudeCodeAdapter")) {
    code = `import { ClaudeCodeAdapter } from "./adapters/ClaudeCodeAdapter";\n` + code;
}

const toolInsertStr = `
    const activeSessions = new Map<string, ClaudeCodeAdapter>();

    const claudeTool = vscode.lm.registerTool("optimus.claudeWorker", {
        async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<any>) {
            return {
                invocationMessage: "»½ÐÑ Claude Code (Opus 4.6 1M) ÎªÄú°á×©ÖÐ..."
            };
        },
        async invoke(
            options: vscode.LanguageModelToolInvocationOptions<any>,
            token: vscode.CancellationToken
        ) {
            const threadId = options.callId || "default_thread_fallback";
            
            if (!activeSessions.has(threadId)) {
                // Initialize Claude config
                // Here we specifically create it as a "worker" and with whatever name/model logic you had
                const newClaude = new ClaudeCodeAdapter(
                    "claude-mcp-opus", 
                    "Claude Worker", 
                    "--model claude-3-7-sonnet-20250219", // Force specific model or leave empty as configured
                    ["agent"]
                );
                activeSessions.set(threadId, newClaude);
            }
            
            const claude = activeSessions.get(threadId)!;
            const instruction = options.input.instruction;
            
            if (!instruction) {
                 return new vscode.LanguageModelToolResult([
                     new vscode.LanguageModelTextPart("Error: No instruction provided to the tool.")
                 ]);
            }
            
            vscode.window.showInformationMessage("Optimus: Claude Code is analyzing the workspace...");

            try {
                // Invoke through PTY
                const responseLog = await claude.invoke(instruction, "agent", (chunk) => {
                    // Optional: streams to output or handled by tool stream (if vs code adds soon)
                });
                
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(responseLog || "Execution completed with no output.")
                ]);
            } catch (err) {
                 const errMsg = err instanceof Error ? err.message : String(err);
                 return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart("Claude Code Execution Failed:\\n" + errMsg)
                 ]);
            }
        }
    });

    context.subscriptions.push(claudeTool);
`;

code = code.replace("if (workspacePathHint) {", toolInsertStr + "\n    if (workspacePathHint) {");
fs.writeFileSync(file, code);

