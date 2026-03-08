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
const path = __importStar(require("path"));
const PersistentAgentAdapter_1 = require("./adapters/PersistentAgentAdapter");
const ChatViewProvider_1 = require("./providers/ChatViewProvider");
const debugLogger_1 = require("./debugLogger");
function activate(context) {
    (0, debugLogger_1.registerDebugOutputChannel)(context);
    (0, debugLogger_1.debugLog)('Extension', 'Optimus Code is now active!');
    const workspacePathHint = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || (vscode.window.activeTextEditor?.document?.uri.scheme === 'file'
            ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
            : undefined)
        || (context.extensionMode === vscode.ExtensionMode.Development
            ? context.extensionUri.fsPath
            : undefined);
    if (workspacePathHint) {
        PersistentAgentAdapter_1.PersistentAgentAdapter.setWorkspacePathHint(workspacePathHint);
        (0, debugLogger_1.debugLog)('Extension', 'Registered workspace path hint', JSON.stringify({ workspacePathHint }));
    }
    else {
        (0, debugLogger_1.debugLog)('Extension', 'No workspace path hint available during activation');
    }
    // Register our new Sidebar Webview Provider
    const provider = new ChatViewProvider_1.ChatViewProvider(context.extensionUri, context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider_1.ChatViewProvider.viewType, provider));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map