import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';

const exec = util.promisify(cp.exec);

export function activate(context: vscode.ExtensionContext) {
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

        } catch (error: any) {
            vscode.window.showErrorMessage(`Council failed to convene: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
