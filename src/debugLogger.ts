import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;
let cachedDebugMode: boolean | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Optimus Code Debug');
    }
    return outputChannel;
}

export function registerDebugOutputChannel(context: vscode.ExtensionContext) {
    const channel = getOutputChannel();
    context.subscriptions.push(channel);

    // Cache the initial value and listen for changes
    cachedDebugMode = vscode.workspace.getConfiguration('optimusCode').get<boolean>('debugMode', false);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('optimusCode.debugMode')) {
                cachedDebugMode = vscode.workspace.getConfiguration('optimusCode').get<boolean>('debugMode', false);
            }
        })
    );
}

export function isDebugModeEnabled(): boolean {
    if (cachedDebugMode !== undefined) {
        return cachedDebugMode;
    }
    return vscode.workspace.getConfiguration('optimusCode').get<boolean>('debugMode', false);
}

export function debugLog(scope: string, message: string, details?: string) {
    if (!isDebugModeEnabled()) {
        return;
    }

    const channel = getOutputChannel();
    const timestamp = new Date().toISOString();
    channel.appendLine('[' + timestamp + '] [' + scope + '] ' + message);
    if (details) {
        channel.appendLine(details);
    }
}

export function showDebugOutputChannel(preserveFocus: boolean = true) {
    getOutputChannel().show(preserveFocus);
}

export function formatChunk(chunk: string, maxLength: number = 800): string {
    const normalized = chunk.replace(/\r/g, '\\r').replace(/\n/g, '\\n\n');
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return normalized.slice(0, maxLength) + '... [truncated]';
}
