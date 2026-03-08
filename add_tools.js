const fs = require("fs");
const file = "src/extension.ts";
let code = fs.readFileSync(file, "utf8");

if (!code.includes("ClaudeCodeAdapter")) {
    code = `import { ClaudeCodeAdapter } from "./adapters/ClaudeCodeAdapter";\n` + code;
}
if (!code.includes("GitHubCopilotAdapter")) {
    code = `import { GitHubCopilotAdapter } from "./adapters/GitHubCopilotAdapter";\n` + code;
}

const toolInsertStr = `
    const activeSessions = new Map<string, ClaudeCodeAdapter>();

    const claudeToolOpus = vscode.lm.registerTool("optimus.claudeWorkerOpus", {
        async prepareInvocation() {
            return { invocationMessage: "唤起 Claude Code (Opus 4.6 1M) 处理任务..." };
        },
        async invoke(options, token) {
            const threadId = String(options.toolInvocationToken);
            if (!activeSessions.has(threadId)) {
                // Using Opus 4.6 alias
                activeSessions.set(threadId, new ClaudeCodeAdapter("claude-opus", "Claude Worker", "--model claude-3-opus-20240229"));
            }
            const claude = activeSessions.get(threadId)!;
            if (!options.input.instruction) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: No instruction.")]);
            vscode.window.showInformationMessage("Optimus: Claude Code (Opus 4.6) is running...");
            try { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await claude.invoke(options.input.instruction, "agent", () => {}) || "Done.")]); }
            catch (err) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: " + String(err))]); }
        }
    });
    context.subscriptions.push(claudeToolOpus);

    const copilotGeminiTool = vscode.lm.registerTool("optimus.copilotGeminiWorker", {
        async prepareInvocation() { return { invocationMessage: "唤起 Copilot (Gemini 3.0) 处理任务..." }; },
        async invoke(options, token) {
            const adapter = new GitHubCopilotAdapter("copilot-gemini", "Copilot Worker", "vendor.google.gemini-3.0");
            if (!options.input.instruction) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: No instruction.")]);
            vscode.window.showInformationMessage("Optimus: Copilot Gemini is answering...");
            try { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await adapter.invoke(options.input.instruction, "agent", () => {}) || "Done.")]); }
            catch (err) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: " + String(err))]); }
        }
    });
    context.subscriptions.push(copilotGeminiTool);

    const copilotGptTool = vscode.lm.registerTool("optimus.copilotGptWorker", {
        async prepareInvocation() { return { invocationMessage: "唤起 Copilot (GPT 5.4) 处理任务..." }; },
        async invoke(options, token) {
            const adapter = new GitHubCopilotAdapter("copilot-gpt", "Copilot Worker", "vendor.openai.gpt-5.4");
            if (!options.input.instruction) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: No instruction.")]);
            vscode.window.showInformationMessage("Optimus: Copilot GPT 5.4 is answering...");
            try { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await adapter.invoke(options.input.instruction, "agent", () => {}) || "Done.")]); }
            catch (err) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: " + String(err))]); }
        }
    });
    context.subscriptions.push(copilotGptTool);
    
    // Fallback Claude Code just in case
    const claudeToolGpt = vscode.lm.registerTool("optimus.claudeWorkerGpt", {
        async prepareInvocation() { return { invocationMessage: "唤起 Claude Code (GPT 5.4) 处理任务..." }; },
        async invoke(options, token) {
            const threadId = String(options.toolInvocationToken);
            if (!activeSessions.has(threadId + "_gpt")) {
                activeSessions.set(threadId + "_gpt", new ClaudeCodeAdapter("claude-gpt", "Claude Worker", "--model gpt-5.4"));
            }
            const claude = activeSessions.get(threadId + "_gpt")!;
            if (!options.input.instruction) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: No instruction.")]);
            vscode.window.showInformationMessage("Optimus: Claude Code (GPT 5.4) is running...");
            try { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await claude.invoke(options.input.instruction, "agent", () => {}) || "Done.")]); }
            catch (err) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: " + String(err))]); }
        }
    });
    context.subscriptions.push(claudeToolGpt);
`;

code = code.replace("if (workspacePathHint) {", toolInsertStr + "\n    if (workspacePathHint) {");
fs.writeFileSync(file, code);

