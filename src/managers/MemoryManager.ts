import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { debugLog } from '../debugLogger';

export class MemoryManager {
    private static readonly memoryFileName = 'state/memory.md';
    private static readonly optimusDir = '.optimus';

    private getMemoryFilePath(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
        return path.join(workspaceFolders[0].uri.fsPath, MemoryManager.optimusDir, MemoryManager.memoryFileName);
    }

    public readMemory(): string | null {
        try {
            const filePath = this.getMemoryFilePath();
            if (!filePath || !fs.existsSync(filePath)) { return null; }
            return fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            debugLog('MemoryManager', 'Failed to read memory file', String(err));
            return null;
        }
    }

    public appendMemory(entry: string): void {
        try {
            const filePath = this.getMemoryFilePath();
            if (!filePath) {
                debugLog('MemoryManager', 'No workspace folder available; memory not persisted');
                return;
            }
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            const timestamp = new Date().toISOString().slice(0, 10);
            const block = `\n<!-- updated ${timestamp} -->\n${entry.trim()}\n`;
            fs.appendFileSync(filePath, block, 'utf8');
            debugLog('MemoryManager', 'Memory entry appended', JSON.stringify({ length: entry.length }));
        } catch (err) {
            debugLog('MemoryManager', 'Failed to append to memory file', String(err));
        }
    }

    public clearMemory(): void {
        try {
            const filePath = this.getMemoryFilePath();
            if (!filePath || !fs.existsSync(filePath)) { return; }
            fs.writeFileSync(filePath, '', 'utf8');
            debugLog('MemoryManager', 'Memory file cleared');
        } catch (err) {
            debugLog('MemoryManager', 'Failed to clear memory file', String(err));
        }
    }
}
