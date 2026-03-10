import * as vscode from 'vscode';
import * as path from 'path';
import { PersistentAgentAdapter } from './adapters/PersistentAgentAdapter';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { debugLog, setCustomLogger, setDebugMode } from './debugLogger';

let outputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext) {
    // Setup vscode debug logger
    outputChannel = vscode.window.createOutputChannel('Optimus Code Debug');
    context.subscriptions.push(outputChannel);
    setCustomLogger((msg) => outputChannel!.appendLine(msg));
    
    const updateDebugMode = () => {
        setDebugMode(vscode.workspace.getConfiguration('optimusCode').get<boolean>('debugMode', false));
    };
    updateDebugMode();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('optimusCode.debugMode')) {
            updateDebugMode();
        }
    }));
    
    debugLog('Extension', 'Optimus Code is now active!');

    const workspacePathHint = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || (vscode.window.activeTextEditor?.document?.uri.scheme === 'file'
            ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
            : undefined)
        || (context.extensionMode === vscode.ExtensionMode.Development
            ? context.extensionUri.fsPath
            : undefined);
    

    // Ensure .optimus directory exists for runtime prompts, memory, etc.
    if (workspacePathHint) {
        const fs = require('fs');
        const dDir = path.join(workspacePathHint, '.optimus');
        if (!fs.existsSync(dDir)) { fs.mkdirSync(dDir, { recursive: true }); }
    }

    if (workspacePathHint) {
        PersistentAgentAdapter.setWorkspacePathHint(workspacePathHint);
        debugLog('Extension', 'Registered workspace path hint', JSON.stringify({ workspacePathHint }));
    } else {
        debugLog('Extension', 'No workspace path hint available during activation');
    }

    // Register our new Sidebar Webview Provider
    const provider = new ChatViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
    );
}

export function deactivate() {}
