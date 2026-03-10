// Core logging implementation without vscode dependencies
let customLogger: ((message: string) => void) | undefined;
let cachedDebugMode: boolean = process.env.OPTIMUS_DEBUG === '1';

export function setCustomLogger(logger: (message: string) => void) {
    customLogger = logger;
}

export function setDebugMode(enabled: boolean) {
    cachedDebugMode = enabled;
}

export function isDebugModeEnabled(): boolean {
    return cachedDebugMode;
}

export function debugLog(scope: string, message: string, details?: string) {
    if (!isDebugModeEnabled()) {
        return;
    }

    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] [${scope}] ${message}`;
    if (details) {
        logMessage += `\n${details}`;
    }

    if (customLogger) {
        customLogger(logMessage);
    } else {
        console.error(logMessage);
    }
}

export function showDebugOutputChannel(preserveFocus: boolean = true) {
    // No-op for pure node context
}

export function formatChunk(chunk: string, maxLength: number = 800): string {
    const normalized = chunk.replace(/\r/g, '\\r').replace(/\n/g, '\\n\n');
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return normalized.slice(0, maxLength) + '... [truncated]';
}
