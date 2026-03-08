import * as vscode from 'vscode';
import * as path from 'path';
import { PersistentAgentAdapter } from './adapters/PersistentAgentAdapter';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { debugLog, registerDebugOutputChannel } from './debugLogger';

export function activate(context: vscode.ExtensionContext) {
    registerDebugOutputChannel(context);
    debugLog('Extension', 'Optimus Code is now active!');

    const workspacePathHint = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || (vscode.window.activeTextEditor?.document?.uri.scheme === 'file'
            ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
            : undefined)
        || (context.extensionMode === vscode.ExtensionMode.Development
            ? context.extensionUri.fsPath
            : undefined);
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
