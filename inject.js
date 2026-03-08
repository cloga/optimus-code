const fs = require("fs");
let p = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (!p.contributes.languageModelTools) p.contributes.languageModelTools = [];
p.activationEvents = ["*"];
p.contributes.languageModelTools = [
  {
    "name": "optimus-claudeWorkerOpus", "displayName": "claudeWorkerOpus", "tags": ["code"],
    "modelDescription": "Call Claude Code (Opus 4.6 1M model) to execute multi-step engineering tasks safely with shell/workspace context.",
    "inputSchema": { "type": "object", "properties": { "instruction": { "type": "string" } }, "required": ["instruction"] }
  }
];
// clean old UI
delete p.contributes.views;
delete p.contributes.viewsContainers;

fs.writeFileSync("package.json", JSON.stringify(p, null, 2));

let ext = fs.readFileSync("src/extension.ts", "utf8");
ext = ext.replace("import { ChatViewProvider } from './providers/ChatViewProvider';\n", "");
ext = ext.replace("import { ChatViewProvider } from \"./providers/ChatViewProvider\";\n", "");
if(!ext.includes("import { ClaudeCodeAdapter }")) {
    ext = "import { ClaudeCodeAdapter } from \"./adapters/ClaudeCodeAdapter\";\n" + ext;
}
const toolCode = `
    const claudeToolOpus = vscode.lm.registerTool("optimus-claudeWorkerOpus", {
        async prepareInvocation(options, token) { return { invocationMessage: "Waking Claude..." }; },
        async invoke(options, token) {
            const input = options.input as { instruction: string };
            const claude = new ClaudeCodeAdapter("claude-opus", "Claude Worker", "--model claude-3-opus-20240229");
            vscode.window.showInformationMessage("Running Tool: Claude Code...");
            try { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await claude.invoke(input.instruction, "agent", ()=>{}) || "Done.")]); }
            catch (err) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: "+err)]); }
        }
    });
    context.subscriptions.push(claudeToolOpus);
`;
ext = ext.replace(/const provider = new ChatViewProvider[\s\S]*\}\)/, toolCode);
fs.writeFileSync("src/extension.ts", ext);

