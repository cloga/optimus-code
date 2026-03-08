const fs = require("fs");
let code = fs.readFileSync("src/extension.ts", "utf8");
code = code.replace("import { ChatViewProvider } from './providers/ChatViewProvider';\n", "");

let insert = `
    const claudeToolOpus = (vscode.lm as any).registerTool("optimus-claudeWorkerOpus", {
        async prepareInvocation(options: any, token: any) { return { invocationMessage: "Waking Claude..." }; },
        async invoke(options: any, token: any) {
            const claude = new ClaudeCodeAdapter("claude-opus", "Claude Worker", "--model claude-3-opus-20240229");
            vscode.window.showInformationMessage("Running Tool: Claude Code...");
            try { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await claude.invoke(options.input.instruction, "agent", ()=>{}) || "Done.")]); }
            catch (err) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: "+err)]); }
        }
    });
    context.subscriptions.push(claudeToolOpus);
`;
code = code.replace("const provider = new ChatViewProvider(context.extensionUri, context);\n\n    context.subscriptions.push(\n        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)\n    );", insert);
code = `import { ClaudeCodeAdapter } from "./adapters/ClaudeCodeAdapter";\n` + code;
fs.writeFileSync("src/extension.ts", code);

