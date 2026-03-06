"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const util = __importStar(require("util"));
const exec = util.promisify(cp.exec);
function activate(context) {
    console.log('Optimus Code is now active!');
    let disposable = vscode.commands.registerCommand('optimus-code.summonCouncil', async () => {
        // Step 1: Get the current selected context
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor.');
            return;
        }
        const selection = editor.selection;
        const textToReview = editor.document.getText(selection);
        if (!textToReview) {
            vscode.window.showInformationMessage('Please select some code first.');
            return;
        }
        vscode.window.showInformationMessage('Summoning the AI Council for debate...');
        try {
            // MVP: Call to `gh copilot suggest` (assuming user has gh CLI and copilot extension)
            // Just a barebones concept:
            const prompt = `Review the following code:\n${textToReview}`;
            // Note: This requires gh copilot to be installed
            const { stdout, stderr } = await exec(`gh copilot suggest -t generic "${prompt.replace(/"/g, '\\"')}"`, {
                env: { ...process.env, TERM: 'dumb' } // stripping colors
            });
            if (stderr && stderr.trim() !== '') {
                console.warn('stderr:', stderr);
            }
            // Present the result - MVP: just show in a new untitled document
            const document = await vscode.workspace.openTextDocument({
                content: `// === Optimus Code: The Council's Decision ===\n\n${stdout}`,
                language: editor.document.languageId
            });
            await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Council failed to convene: ${error.message}`);
        }
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map