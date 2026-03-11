import { AgentAdapter } from './AgentAdapter';
import { AgentMode } from '../types/SharedTaskContext';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import stripAnsi from 'strip-ansi';
import * as iconv from 'iconv-lite';
import { debugLog, formatChunk } from '../debugLogger';
import { ANSI_RE } from '../utils/textParsing';

type WindowsSpawnResolution = {
    cmd: string;
    argsPrefix: string[];
};

type PreparedPrompt = {
    prompt: string;
    transport: 'inline' | 'file';
    filePath?: string;
    cleanup?: () => void;
};

type StructuredInputSummary = string | number | boolean | null | undefined | Record<string, unknown> | Array<unknown>;

type StructuredToolRecord = {
    name: string;
    input?: StructuredInputSummary;
};

type SharedThinkingExtractionOptions = {
    processLineRe: RegExp;
    captureBracketLines?: boolean;
    captureProcessLinesAfterOutputStarts?: boolean;
    collectUsageLog?: boolean;
};

const windowsSpawnResolutionCache = new Map<string, WindowsSpawnResolution | null>();
const DEFAULT_PROMPT_FILE_THRESHOLD = 12000;
const MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB safety cap

// On Windows, cmd.exe writes system error messages (e.g. "path not found") in the system
// code page (GBK/CP936 on Chinese Windows). Most external CLIs still emit UTF-8,
// so prefer UTF-8 and only fall back to CP936 when UTF-8 clearly fails.
function decodeBuffer(buf: Buffer): string {
    if (process.platform === 'win32') {
        const utf8Text = buf.toString('utf8');
        if (!utf8Text.includes('\uFFFD')) {
            return utf8Text;
        }
        return iconv.decode(buf, 'cp936');
    }
    return buf.toString('utf8');
}

function resolveWindowsSpawnResolution(cmd: string): WindowsSpawnResolution | null {
    const cached = windowsSpawnResolutionCache.get(cmd);
    if (cached !== undefined) {
        return cached;
    }

    const whereResult = cp.spawnSync('where.exe', [cmd], { encoding: 'utf8' });
    if (whereResult.status !== 0 || !whereResult.stdout) {
        windowsSpawnResolutionCache.set(cmd, null);
        return null;
    }

    const candidates = whereResult.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(candidate => fs.existsSync(candidate))
        .sort((left, right) => {
            const extRank = (filePath: string) => {
                const ext = path.extname(filePath).toLowerCase();
                if (ext === '.exe' || ext === '.com') {
                    return 0;
                }
                if (ext === '.cmd') {
                    return 1;
                }
                if (ext === '.bat') {
                    return 2;
                }
                return 3;
            };

            return extRank(left) - extRank(right);
        });

    for (const candidate of candidates) {
        const ext = path.extname(candidate).toLowerCase();
        if (ext === '.exe' || ext === '.com') {
            const resolved = { cmd: candidate, argsPrefix: [] };
            windowsSpawnResolutionCache.set(cmd, resolved);
            return resolved;
        }

        if (ext !== '.cmd') {
            continue;
        }

        try {
            const wrapperText = fs.readFileSync(candidate, 'utf8');
            const scriptMatch = wrapperText.match(/"%dp0%\\([^\"]+?\.js)"/i);
            if (!scriptMatch) {
                continue;
            }

            const wrapperDir = path.dirname(candidate);
            const nodeExecutable = fs.existsSync(path.join(wrapperDir, 'node.exe'))
                ? path.join(wrapperDir, 'node.exe')
                : 'node';
            const entryScript = path.join(wrapperDir, scriptMatch[1].replace(/\\/g, path.sep));
            const resolved = { cmd: nodeExecutable, argsPrefix: [entryScript] };
            windowsSpawnResolutionCache.set(cmd, resolved);
            return resolved;
        } catch {
            continue;
        }
    }

    windowsSpawnResolutionCache.set(cmd, null);
    return null;
}

/**
 * On Windows, npm-installed CLIs often resolve to `.cmd` wrappers. Routing those
 * through `cmd /c` drops the maximum usable command length to the shell limit,
 * which is too small for large synthesized prompts. Resolve known wrappers to
 * their underlying Node entrypoints so we can spawn them directly.
 */
function platformSpawn(
    cmd: string,
    args: string[],
    options: cp.SpawnOptionsWithoutStdio
): cp.ChildProcessWithoutNullStreams {
    // Force windowsHide to prevent annoying console popups
    options = { ...options, windowsHide: true };
    
    if (process.platform === 'win32') {
        const resolved = resolveWindowsSpawnResolution(cmd);
        if (resolved) {
            return cp.spawn(resolved.cmd, [...resolved.argsPrefix, ...args], options);
        }
        return cp.spawn('cmd', ['/c', cmd, ...args], options);
    }
    return cp.spawn(cmd, args, options);
}

/**
 * A persistent adapter that supports two execution modes:
 * - Non-interactive (-p flag): for plan/ask/auto modes, spawns a one-shot process per request
 * - Interactive daemon: for agent mode, keeps a persistent process alive across turns
 */
export abstract class PersistentAgentAdapter implements AgentAdapter {
    private static workspacePathHint: string | null = null;

    public static setWorkspacePathHint(hint: string) {
        PersistentAgentAdapter.workspacePathHint = hint;
    }

    private static resolveWorkspacePath(): { path: string; source: string } {
        if (process.env.OPTIMUS_WORKSPACE) {
            return { path: process.env.OPTIMUS_WORKSPACE, source: 'process.env.OPTIMUS_WORKSPACE' };
        }

        if (PersistentAgentAdapter.workspacePathHint) {
            return { path: PersistentAgentAdapter.workspacePathHint, source: 'workspacePathHint' };
        }

        // Last-resort fallback: process.cwd() may not be the project root when running as a
        // VS Code extension (VS Code typically sets cwd to its own install directory).
        // Set OPTIMUS_WORKSPACE or call setWorkspacePathHint() to ensure .optimus/ files land
        // in the correct project directory.
        debugLog('PersistentAgentAdapter', 'WARNING: workspace path resolved via process.cwd() fallback — .optimus/ artifacts may land outside the active project. Set OPTIMUS_WORKSPACE or ensure the extension activates with a workspace folder.', JSON.stringify({ cwd: process.cwd() }));
        return { path: process.cwd(), source: 'process.cwd()' };
    }

    id: string;
    name: string;
    modelFlag?: string;
    isEnabled: boolean = true;
    modes: AgentMode[] = ['plan', 'agent'];
    lastDebugInfo?: {
        command: string;
        cwd: string;
        pid: number;
        startTime: number;
        endTime?: number;
        promptTransport?: 'inline' | 'file';
        promptFilePath?: string;
        originalPromptLength?: number;
        sentPromptLength?: number;
        promptFileThreshold?: number;
    };
    lastUsageLog?: string;
    lastSessionId?: string;
    
    protected childProcess: cp.ChildProcessWithoutNullStreams | null = null;
    protected promptString: string;
    protected outputBuffer: string = '';
    protected currentMode: AgentMode = 'plan';
    protected currentTurnMarker: string | null = null;
    
    protected turnResolve: ((val: string) => void) | null = null;
    protected turnReject: ((err: Error) => void) | null = null;
    protected turnOnUpdate: ((chunk: string) => void) | null = null;

    constructor(id: string, name: string, modelFlag: string = '', promptString: string, modes?: AgentMode[]) {
        this.id = id;
        this.name = name;
        this.modelFlag = modelFlag;
        this.promptString = promptString;
        if (modes) { this.modes = modes; }
    }

    /**
     * Returns the active workspace folder path, with robust fallback.
     */
    public static getWorkspacePath(): string {
        return PersistentAgentAdapter.resolveWorkspacePath().path;
    }

    protected abstract getSpawnCommand(mode: AgentMode): { cmd: string, args: string[] };

    protected shouldUseStructuredOutput(mode: AgentMode): boolean {
        return false;
    }

    protected shouldUsePersistentSession(mode: AgentMode): boolean {
        return mode === 'agent';
    }

    protected getPromptFileThreshold(): number {
        const configured = Number(process.env.OPTIMUS_PROMPT_FILE_THRESHOLD);
        if (!process.env.OPTIMUS_PROMPT_FILE_THRESHOLD || !Number.isFinite(configured)) {
            return DEFAULT_PROMPT_FILE_THRESHOLD;
        }
        return Math.max(1000, Math.floor(configured));
    }

    protected shouldUsePromptFile(mode: AgentMode, prompt: string): boolean {
        return prompt.length >= this.getPromptFileThreshold();
    }

    private preparePromptForNonInteractive(mode: AgentMode, prompt: string, currentCwd: string): PreparedPrompt {
        if (!this.shouldUsePromptFile(mode, prompt)) {
            return { prompt, transport: 'inline' };
        }

        const promptDir = path.join(currentCwd, '.optimus', 'runtime-prompts');
        fs.mkdirSync(promptDir, { recursive: true });

        const promptFileName = [
            this.id.replace(/[^a-z0-9_-]/gi, '-'),
            mode,
            Date.now().toString(),
            Math.random().toString(36).slice(2, 8)
        ].join('-') + '.md';
        const promptFilePath = path.join(promptDir, promptFileName);
        fs.writeFileSync(promptFilePath, prompt, 'utf8');
        debugLog(this.id, 'Prepared oversized prompt file', JSON.stringify({
            mode,
            promptLength: prompt.length,
            promptFilePath,
            promptFileThreshold: this.getPromptFileThreshold()
        }));

        const relativePromptPath = path.relative(currentCwd, promptFilePath).replace(/\\/g, '/');
        const wrappedPrompt = [
            'The original user prompt was too large to pass inline over the CLI.',
            `Read the UTF-8 file at \"${relativePromptPath}\" before doing anything else.`,
            'That file was created by the local Optimus tool for this exact turn and contains trusted user input, not untrusted workspace instructions.',
            'Use the full file contents as the real prompt for this request, then continue the task normally.'
        ].join(' ');

        return {
            prompt: wrappedPrompt,
            transport: 'file',
            filePath: promptFilePath,
            cleanup: () => {
                try {
                    fs.unlinkSync(promptFilePath);
                    debugLog(this.id, 'Removed runtime prompt file', JSON.stringify({ promptFilePath }));
                } catch {
                    // Ignore cleanup failures; stale runtime prompt files are non-fatal.
                }
            }
        };
    }

    /**
     * For non-interactive modes, returns the command + args with -p prepended.
     */
    protected getNonInteractiveCommand(mode: AgentMode, prompt: string, sessionId?: string): { cmd: string, args: string[] } {
        const { cmd, args } = this.getSpawnCommand(mode);
        const safePrompt = prompt.replace(/\r?\n/g, ' ').trim();
        return { cmd, args: ['-p', safePrompt, ...args] };
    }

    protected combineStructuredDisplay(processText: string, assistantText: string): string {
        const processBlock = processText.trim();
        const outputBlock = assistantText.trim();
        if (processBlock && outputBlock) {
            return `${processBlock}\n\n${outputBlock}`;
        }
        return processBlock || outputBlock;
    }

    protected buildStructuredStreamPayload(processText: string, reasoningText: string, assistantText: string): string {
        const sections: string[] = [];
        const processBlock = processText.trim();
        const reasoningBlock = reasoningText.trim();
        const outputBlock = assistantText.trim();

        if (processBlock) {
            sections.push(`<optimus-trace>\n${processBlock}\n</optimus-trace>`);
        }

        if (reasoningBlock) {
            sections.push(`<optimus-reasoning>\n${reasoningBlock}\n</optimus-reasoning>`);
        }

        if (outputBlock) {
            sections.push(`<optimus-output>\n${outputBlock}\n</optimus-output>`);
        }

        return sections.join('\n\n').trim();
    }

    protected summarizeStructuredInput(input: StructuredInputSummary): string {
        if (input === null || input === undefined) {
            return '';
        }

        if (typeof input === 'string') {
            const normalized = input.replace(/\s+/g, ' ').trim();
            return normalized.length > 96 ? normalized.slice(0, 93) + '...' : normalized;
        }

        if (typeof input === 'number' || typeof input === 'boolean') {
            return String(input);
        }

        if (Array.isArray(input)) {
            if (input.length === 0) {
                return '[]';
            }
            const primitiveItems = input.filter(item => ['string', 'number', 'boolean'].includes(typeof item));
            if (primitiveItems.length > 0) {
                const preview = primitiveItems.slice(0, 3).map(item => this.summarizeStructuredInput(item as StructuredInputSummary)).join(', ');
                return input.length > 3 ? `${preview}, ... (${input.length} items)` : preview;
            }
            return `${input.length} items`;
        }

        const preferredKeys = [
            'role_prompt',
            'engine',
            'model',
            'instruction',
            'workdir',
            'file_path',
            'path',
            'relative_workspace_path',
            'start_line',
            'end_line',
            'startLine',
            'endLine',
            'line',
            'insert_line',
            'command',
            'query',
            'pattern',
            'symbol',
            'url',
            'name',
            'description',
            'task',
            'includePattern',
            'filePath',
            'input'
        ];
        const parts: string[] = [];

        for (const key of preferredKeys) {
            if (!(key in input)) {
                continue;
            }
            const value = (input as Record<string, unknown>)[key] as StructuredInputSummary;
            const summary = this.summarizeStructuredInput(value);
            if (summary) {
                parts.push(`${key}=${summary}`);
            }
            if (parts.length >= 4) {
                break;
            }
        }

        if (parts.length === 0) {
            const keys = Object.keys(input);
            if (keys.length === 0) {
                return '{}';
            }
            return keys.slice(0, 3).join(', ');
        }

        return parts.join(', ');
    }

    protected formatStructuredToolCall(toolName: string, input?: StructuredInputSummary): string {
        const normalizedName = toolName.trim() || 'tool';
        const summary = this.summarizeStructuredInput(input);
        return summary ? `• ${normalizedName}\n↳ ${summary}` : `• ${normalizedName}`;
    }

    protected appendProcessLines(currentText: string, lines: string[]): string {
        const existingLines = currentText ? currentText.split('\n').filter(Boolean) : [];
        for (const line of lines) {
            // Split multi-line entries (e.g. "• tool\n↳ summary") into individual lines
            for (const subLine of line.split('\n').map(l => l.trim()).filter(Boolean)) {
                if (existingLines[existingLines.length - 1] === subLine) {
                    continue;
                }
                existingLines.push(subLine);
            }
        }
        return existingLines.join('\n');
    }

    protected registerStructuredToolCall(
        toolCalls: Map<string, StructuredToolRecord>,
        toolCallId: string | undefined,
        toolName: string,
        input?: StructuredInputSummary
    ): void {
        if (!toolCallId) {
            return;
        }
        toolCalls.set(toolCallId, { name: toolName, input });
    }

    protected summarizeStructuredToolResult(result: unknown): string {
        if (result === null || result === undefined) {
            return '';
        }

        if (typeof result === 'string') {
            const nonEmptyLines = result
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && line !== '[LOG]');

            if (nonEmptyLines.length === 0) {
                return 'empty result';
            }

            const preview = nonEmptyLines[0].replace(/\s+/g, ' ').trim();
            if (nonEmptyLines.length === 1) {
                return preview.length > 96 ? preview.slice(0, 93) + '...' : preview;
            }

            const lineCount = `${nonEmptyLines.length} lines`;
            const clippedPreview = preview.length > 72 ? preview.slice(0, 69) + '...' : preview;
            return `${lineCount}, preview=${clippedPreview}`;
        }

        if (typeof result === 'number' || typeof result === 'boolean') {
            return String(result);
        }

        if (Array.isArray(result)) {
            if (result.length === 0) {
                return '0 items';
            }
            return `${result.length} items`;
        }

        const record = result as Record<string, unknown>;
        if (typeof record.stdout === 'string' && record.stdout.trim()) {
            return this.summarizeStructuredToolResult(record.stdout);
        }
        if (typeof record.content === 'string' && record.content.trim()) {
            return this.summarizeStructuredToolResult(record.content);
        }
        if (typeof record.detailedContent === 'string' && record.detailedContent.trim()) {
            return this.summarizeStructuredToolResult(record.detailedContent);
        }
        if (typeof record.stderr === 'string' && record.stderr.trim()) {
            return `stderr=${this.summarizeStructuredToolResult(record.stderr)}`;
        }

        const keys = Object.keys(record);
        return keys.length > 0 ? keys.slice(0, 4).join(', ') : 'object result';
    }

    protected countMeaningfulLines(value: string): string[] {
        return value
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && line !== '[LOG]');
    }

    protected looksLikePathList(lines: string[]): boolean {
        if (lines.length === 0) {
            return false;
        }
        const sample = lines.slice(0, Math.min(lines.length, 6));
        return sample.every(line => !/\s{2,}/.test(line) && !/[{}<>]/.test(line));
    }

    protected sanitizeStructuredSummaryValue(value: string, maxLength: number = 96): string {
        return value.replace(/\s+/g, ' ').replace(/,\s*/g, '; ').trim().slice(0, maxLength);
    }

    protected getStructuredResultText(record: Record<string, unknown> | undefined, result: unknown): string {
        const candidateKeys = ['content', 'stdout', 'text', 'output', 'detailedContent', 'message'];
        for (const key of candidateKeys) {
            const value = record?.[key];
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
        return typeof result === 'string' ? result : '';
    }

    protected getStructuredResultPath(record: Record<string, unknown> | undefined): string | undefined {
        const candidateKeys = ['file_path', 'filepath', 'path', 'relative_workspace_path', 'target_file', 'targetPath'];
        for (const key of candidateKeys) {
            const value = record?.[key];
            if (typeof value === 'string' && value.trim()) {
                return this.sanitizeStructuredSummaryValue(value, 120);
            }
        }
        return undefined;
    }

    protected getStructuredResultLineRange(record: Record<string, unknown> | undefined): string | undefined {
        const start = typeof record?.start_line === 'number'
            ? record.start_line
            : typeof record?.startLine === 'number'
                ? record.startLine
                : undefined;
        const end = typeof record?.end_line === 'number'
            ? record.end_line
            : typeof record?.endLine === 'number'
                ? record.endLine
                : undefined;
        const insertLine = typeof record?.insert_line === 'number'
            ? record.insert_line
            : typeof record?.insertLine === 'number'
                ? record.insertLine
                : undefined;

        if (typeof start === 'number' && typeof end === 'number') {
            return `lines=${start}-${end}`;
        }
        if (typeof start === 'number') {
            return `line=${start}`;
        }
        if (typeof insertLine === 'number') {
            return `line=${insertLine}`;
        }
        return undefined;
    }

    protected buildStructuredSummary(parts: Array<string | undefined>): string {
        return parts.filter((part): part is string => Boolean(part && part.trim())).join(', ');
    }

    protected summarizeToolResultByName(toolName: string, result: unknown): string {
        const normalizedName = toolName.toLowerCase();
        const record = typeof result === 'object' && result !== null ? result as Record<string, unknown> : undefined;
        const content = this.getStructuredResultText(record, result);
        const lines = this.countMeaningfulLines(content);
        const path = this.getStructuredResultPath(record);
        const lineRange = this.getStructuredResultLineRange(record);
        const preview = lines.length > 0 ? `preview=${this.sanitizeStructuredSummaryValue(lines[0], 80)}` : undefined;

        if (/delegate_task/.test(normalizedName)) {
            const cleanedLines = lines.filter(line => !/^Worker output:/i.test(line) && !/^\[Session:/i.test(line) && !/^\[In:/i.test(line));
            if (cleanedLines.length === 0) {
                return 'worker completed';
            }

            const firstLine = this.sanitizeStructuredSummaryValue(cleanedLines[0], 120);
            if (cleanedLines.length === 1) {
                return `worker=${firstLine}`;
            }

            return `worker=${firstLine}, lines=${cleanedLines.length}`;
        }

        if (/bash|shell|run|exec|command/.test(normalizedName)) {
            const stdout = typeof record?.stdout === 'string' ? record.stdout : content;
            const stderr = typeof record?.stderr === 'string' ? record.stderr : '';
            const stdoutLines = this.countMeaningfulLines(stdout);
            const stderrLines = this.countMeaningfulLines(stderr);
            const exitCode = typeof record?.exit_code === 'number'
                ? record.exit_code
                : typeof record?.exitCode === 'number'
                    ? record.exitCode
                    : undefined;
            const segments: string[] = [`stdout=${stdoutLines.length > 0 ? `${stdoutLines.length} lines` : 'empty'}`];
            if (typeof exitCode === 'number') {
                segments.push(`exit=${exitCode}`);
            }
            if (stderrLines.length > 0) {
                segments.push(`stderr=${stderrLines.length} lines`);
            }
            if (stdoutLines.length > 0) {
                segments.push(`preview=${this.sanitizeStructuredSummaryValue(stdoutLines[0], 80)}`);
            }
            return segments.join(', ');
        }

        if (/grep|search/.test(normalizedName)) {
            if (lines.length === 0) {
                return this.buildStructuredSummary([path, 'matches=0']);
            }
            return this.buildStructuredSummary([path, `matches=${lines.length}`, preview]);
        }

        if (/edit|write|create|update|patch|save|insert/.test(normalizedName)) {
            if (lines.length === 0) {
                return this.buildStructuredSummary([path, lineRange, 'status=updated']);
            }
            return this.buildStructuredSummary([path, lineRange, `lines=${lines.length}`, preview]);
        }

        if (/read|view/.test(normalizedName)) {
            if (lines.length === 0) {
                return this.buildStructuredSummary([path, lineRange, 'lines=0']);
            }
            return this.buildStructuredSummary([path, lineRange, `lines=${lines.length}`, preview]);
        }

        if (/glob|list|ls|dir/.test(normalizedName)) {
            if (lines.length === 0) {
                return this.buildStructuredSummary([path, 'items=0']);
            }
            if (this.looksLikePathList(lines)) {
                return this.buildStructuredSummary([path, `items=${lines.length}`, `first=${this.sanitizeStructuredSummaryValue(lines[0], 80)}`]);
            }
            return this.buildStructuredSummary([path, `lines=${lines.length}`, preview]);
        }

        return this.summarizeStructuredToolResult(result);
    }

    protected formatStructuredToolCompletion(toolName: string, result: unknown, success: boolean = true): string[] {
        const summary = this.summarizeToolResultByName(toolName, result);
        const lines = [`${success ? '✓' : '✗'} ${toolName.trim() || 'tool'}`];
        if (summary) {
            lines.push(`↳ result=${summary}`);
        }
        return lines;
    }

    protected extractThinkingWithSharedParser(
        rawText: string,
        options: SharedThinkingExtractionOptions
    ): { thinking: string; output: string; usageLog?: string } {
        if (!rawText) {
            return { thinking: '', output: '' };
        }

        const tagRegex = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
        const thinkingBlocks: string[] = [];
        const logLines: string[] = [];
        let remaining = rawText;
        let match: RegExpExecArray | null;

        while ((match = tagRegex.exec(rawText)) !== null) {
            thinkingBlocks.push(match[2].trim());
            remaining = remaining.replace(match[0], '');
        }

        const lines = remaining.split(/\r?\n|\r/);
        const processLines: string[] = [];
        const outputLines: string[] = [];
        let outputStarted = false;

        const isProcessLine = (clean: string) => {
            if (!clean) {
                return true;
            }
            if (options.processLineRe.test(clean)) {
                return true;
            }
            if (clean.startsWith('> [')) {
                return true;
            }
            if (options.captureBracketLines && clean.startsWith('[')) {
                return true;
            }
            return false;
        };

        for (const line of lines) {
            const clean = line.replace(ANSI_RE, '').trim();

            if (options.collectUsageLog && /\[LOG\]/i.test(clean)) {
                logLines.push(clean);
                continue;
            }

            if (!outputStarted) {
                if (isProcessLine(clean)) {
                    processLines.push(line);
                } else {
                    outputStarted = true;
                    outputLines.push(line);
                }
            } else if (options.captureProcessLinesAfterOutputStarts && isProcessLine(clean) && clean !== '') {
                processLines.push(line);
            } else {
                outputLines.push(line);
            }
        }

        while (processLines.length > 0 && processLines[processLines.length - 1].trim() === '') {
            outputLines.unshift(processLines.pop() as string);
        }

        const processBlock = processLines.join('\n').trim();
        if (processBlock) {
            thinkingBlocks.push('```text\n' + processBlock + '\n```');
        }

        return {
            thinking: thinkingBlocks.join('\n\n---\n\n'),
            output: outputLines.join('\n').trim(),
            usageLog: logLines.length > 0 ? logLines.join('\n') : this.lastUsageLog
        };
    }

    private buildTurnCompletionMarker(): string {
        return `[[OPTIMUS_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}]]`;
    }

    private stripTurnCompletionArtifacts(text: string): string {
        let cleaned = text;
        if (this.currentTurnMarker) {
            cleaned = cleaned.replace(this.currentTurnMarker, '');
        }
        return cleaned.trim();
    }

    /**
     * One-shot execution using -p flag. Spawns a process, collects all output, resolves when done.
     */
    private invokeNonInteractive(prompt: string, mode: AgentMode, sessionId?: string, onUpdate?: (chunk: string) => void): Promise<string> {
        return new Promise((resolve, reject) => {
            const workspacePath = PersistentAgentAdapter.resolveWorkspacePath();
            const currentCwd = workspacePath.path;
            const preparedPrompt = this.preparePromptForNonInteractive(mode, prompt, currentCwd);
            const promptFileThreshold = this.getPromptFileThreshold();
            const { cmd, args } = this.getNonInteractiveCommand(mode, preparedPrompt.prompt, sessionId);
            const useStructuredOutput = this.shouldUseStructuredOutput(mode);
            this.lastUsageLog = undefined;
            // Retain lastSessionId across invokes if not explicitly overwritten
            debugLog(this.id, 'Starting non-interactive invoke', JSON.stringify({
                mode,
                cwd: currentCwd,
                cwdSource: workspacePath.source,
                cmd,
                args: args.map((a, i) => i === 0 ? a : `[${a.length} chars]`),
                promptLength: prompt.length,
                sentPromptLength: preparedPrompt.prompt.length,
                promptTransport: preparedPrompt.transport,
                promptFilePath: preparedPrompt.filePath,
                promptFileThreshold
            }));

            let output = '';
            let structuredBuffer = '';
            let structuredProcessText = '';
            let structuredReasoningText = '';
            let structuredAssistantText = '';
            let structuredResultText = '';
            const structuredToolCalls = new Map<string, StructuredToolRecord>();
            const startTime = Date.now();
            let stallWarningTimer: ReturnType<typeof setTimeout> | null = null;
            const safeEnv: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', CI: 'false', FORCE_COLOR: '0' };
            if (process.platform === 'win32' && !safeEnv.CLAUDE_CODE_GIT_BASH_PATH) {
                safeEnv.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
            }
            
            const child = platformSpawn(cmd, args, {
                cwd: currentCwd,
                env: safeEnv as any
            });

            this.lastDebugInfo = {
                command: cmd + ' ' + args.join(' '),
                cwd: currentCwd,
                pid: child.pid || 0,
                startTime,
                promptTransport: preparedPrompt.transport,
                promptFilePath: preparedPrompt.filePath,
                originalPromptLength: prompt.length,
                sentPromptLength: preparedPrompt.prompt.length,
                promptFileThreshold
            };

            // One-shot CLI calls should not wait for any stdin payload after -p.
            child.stdin.end();
            debugLog(this.id, 'Closed stdin for non-interactive invoke');

            stallWarningTimer = setTimeout(() => {
                debugLog(this.id, 'Non-interactive invoke still running after threshold', JSON.stringify({
                    mode,
                    thresholdMs: 15000,
                    pid: child.pid,
                    cwd: currentCwd,
                    outputLength: output.length
                }));
            }, 15000);

            child.stdout.on('data', (data) => {
                const chunk = stripAnsi(decodeBuffer(data));
                debugLog(this.id, 'stdout chunk', formatChunk(chunk));
                if (useStructuredOutput) {
                    structuredBuffer += chunk;
                    const lines = structuredBuffer.split(/\r?\n/);
                    structuredBuffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) {
                            continue;
                        }

                        try {
                            const event = JSON.parse(trimmed);
                            const nextProcessText = this.applyStructuredProcessEvent(structuredProcessText, event, structuredToolCalls);
                            const hasProcessUpdate = nextProcessText !== structuredProcessText;
                            if (hasProcessUpdate) {
                                structuredProcessText = nextProcessText;
                            }

                            const nextStreamingText = this.applyStructuredStreamingEvent(structuredAssistantText, event);
                            const hasAssistantUpdate = nextStreamingText !== structuredAssistantText;
                            if (hasAssistantUpdate) {
                                structuredAssistantText = nextStreamingText;
                            }

                            const nextReasoningText = this.applyStructuredReasoningEvent(structuredReasoningText, event);
                            const hasReasoningUpdate = nextReasoningText !== structuredReasoningText;
                            if (hasReasoningUpdate) {
                                structuredReasoningText = nextReasoningText;
                            }

                            if ((hasProcessUpdate || hasReasoningUpdate || hasAssistantUpdate) && onUpdate) {
                                onUpdate(this.buildStructuredStreamPayload(structuredProcessText, structuredReasoningText, structuredAssistantText));
                            }

                            if (event?.type === 'result') {
                                const resultText = typeof event.result === 'string' ? event.result : '';
                                if (resultText) {
                                    structuredResultText = resultText;
                                }
                                this.lastUsageLog = this.extractStructuredUsageLog(event) || this.lastUsageLog;
                            }
                            
                            // Capture active session ID if reported by the CLI
                            if (event?.session_id || event?.sessionId) {
                                this.lastSessionId = event.session_id || event.sessionId;
                            }
                        } catch {
                            output += chunk;
                            if (onUpdate) {
                                onUpdate(output.trim());
                            }
                            break;
                        }
                    }
                } else {
                    output += chunk;
                    if (onUpdate) {
                        onUpdate(output.trim());
                    }
                }
                
                // Fallback regex to capture session ID natively
                const sessionMatch = chunk.match(/"?(?:session_id|sessionId)"?\s*[:=]\s*"([0-9a-f-]{36})"/i);
                if (sessionMatch) {
                    this.lastSessionId = sessionMatch[1];
                }
            });

            child.stderr.on('data', (data) => {
                const chunk = stripAnsi(decodeBuffer(data));
                debugLog(this.id, 'stderr chunk', formatChunk(chunk));
                output += '\n> [LOG] ' + chunk;
            });

            child.on('error', (err) => {
                preparedPrompt.cleanup?.();
                if (stallWarningTimer) {
                    clearTimeout(stallWarningTimer);
                    stallWarningTimer = null;
                }
                if (this.childProcess === child) {
                    this.childProcess = null;
                }
                debugLog(this.id, 'Process error during non-interactive invoke', err.stack || String(err));
                reject(err);
            });

            child.on('close', (code) => {
                preparedPrompt.cleanup?.();
                if (stallWarningTimer) {
                    clearTimeout(stallWarningTimer);
                    stallWarningTimer = null;
                }
                if (this.childProcess === child) {
                    this.childProcess = null;
                }
                if (this.lastDebugInfo) { this.lastDebugInfo.endTime = Date.now(); }
                debugLog(this.id, 'Non-interactive process closed', JSON.stringify({
                    code,
                    duration: this.lastDebugInfo?.endTime && this.lastDebugInfo?.startTime
                        ? this.lastDebugInfo.endTime - this.lastDebugInfo.startTime
                        : undefined,
                    outputLength: output.trim().length,
                    promptTransport: this.lastDebugInfo?.promptTransport,
                    promptFilePath: this.lastDebugInfo?.promptFilePath
                }));
                if (useStructuredOutput && structuredBuffer.trim()) {
                    try {
                        const event = JSON.parse(structuredBuffer.trim());
                        structuredProcessText = this.applyStructuredProcessEvent(structuredProcessText, event, structuredToolCalls);
                        structuredReasoningText = this.applyStructuredReasoningEvent(structuredReasoningText, event);
                        structuredAssistantText = this.applyStructuredStreamingEvent(structuredAssistantText, event);
                        if (event?.type === 'result' && typeof event.result === 'string') {
                            structuredResultText = event.result;
                        }
                        this.lastUsageLog = this.extractStructuredUsageLog(event) || this.lastUsageLog;
                    } catch {
                        output += structuredBuffer;
                    }
                }

                const finalOutput = useStructuredOutput
                    ? this.combineStructuredDisplay(structuredProcessText, structuredResultText.trim() || structuredAssistantText.trim() || output.trim()).trim()
                    : output.trim();

                if (code !== 0 && !finalOutput) {
                    reject(new Error(`Process exited with code ${code}`));
                } else {
                    resolve(finalOutput);
                }
            });

            // Store reference so stop() can kill it
            this.childProcess = child;
        });
    }

    protected extractStructuredAssistantText(event: any): string {
        if (event?.type === 'assistant.message' && typeof event?.data?.content === 'string') {
            return event.data.content;
        }

        const content = event?.message?.content;
        if (!Array.isArray(content)) {
            return typeof event?.text === 'string' ? event.text : '';
        }

        return content
            .map((block: any) => {
                if (block?.type === 'text' && typeof block.text === 'string') {
                    return block.text;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    protected applyStructuredProcessEvent(currentText: string, event: any, toolCalls: Map<string, StructuredToolRecord>): string {
        if (event?.type === 'assistant') {
            const content = event?.message?.content;
            if (!Array.isArray(content)) {
                return currentText;
            }

            const lines = content
                .map((block: any) => {
                    if (block?.type !== 'tool_use') {
                        return '';
                    }
                    const toolName = typeof block.name === 'string' ? block.name : 'tool';
                    this.registerStructuredToolCall(toolCalls, typeof block.id === 'string' ? block.id : undefined, toolName, block.input);
                    return this.formatStructuredToolCall(toolName, block.input);
                })
                .filter(Boolean);

            return this.appendProcessLines(currentText, lines);
        }

        if (event?.type === 'assistant.message') {
            const toolRequests = Array.isArray(event?.data?.toolRequests) ? event.data.toolRequests : [];
            const lines = toolRequests.map((request: any) => {
                const toolName = typeof request?.name === 'string' ? request.name : 'tool';
                const toolCallId = typeof request?.toolCallId === 'string' ? request.toolCallId : undefined;
                this.registerStructuredToolCall(toolCalls, toolCallId, toolName, request?.arguments);
                return this.formatStructuredToolCall(toolName, request?.arguments);
            });

            return this.appendProcessLines(currentText, lines);
        }

        if (event?.type === 'tool.execution_start') {
            const toolCallId = typeof event?.data?.toolCallId === 'string' ? event.data.toolCallId : undefined;
            const toolName = typeof event?.data?.toolName === 'string' ? event.data.toolName : 'tool';
            const alreadyRegistered = toolCallId ? toolCalls.has(toolCallId) : false;
            this.registerStructuredToolCall(toolCalls, toolCallId, toolName, event?.data?.arguments);
            if (alreadyRegistered) {
                return currentText;
            }
            return this.appendProcessLines(currentText, [this.formatStructuredToolCall(toolName, event?.data?.arguments)]);
        }

        if (event?.type === 'tool.execution_complete') {
            const toolCallId = typeof event?.data?.toolCallId === 'string' ? event.data.toolCallId : undefined;
            const toolName = typeof event?.data?.toolName === 'string'
                ? event.data.toolName
                : (toolCallId && toolCalls.get(toolCallId)?.name) || 'tool';
            const success = event?.data?.success !== false;
            return this.appendProcessLines(currentText, this.formatStructuredToolCompletion(toolName, event?.data?.result, success));
        }

        if (event?.type === 'user') {
            const toolResultBlocks = Array.isArray(event?.message?.content)
                ? event.message.content.filter((block: any) => block?.type === 'tool_result')
                : [];
            if (toolResultBlocks.length === 0) {
                return currentText;
            }

            let updatedText = currentText;
            for (const block of toolResultBlocks) {
                const toolCallId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined;
                if (!toolCallId) { continue; }
                const toolName = toolCalls.get(toolCallId)?.name || 'tool';
                const success = block?.is_error !== true;
                const result = block?.content;
                updatedText = this.appendProcessLines(updatedText, this.formatStructuredToolCompletion(toolName, result, success));
            }
            return updatedText;
        }

        if (event?.type === 'stream_event') {
            const innerEvent = event.event;
            if (innerEvent?.type === 'content_block_start' && innerEvent.content_block?.type === 'tool_use') {
                const toolName = typeof innerEvent.content_block.name === 'string' ? innerEvent.content_block.name : 'tool';
                this.registerStructuredToolCall(
                    toolCalls,
                    typeof innerEvent.content_block.id === 'string' ? innerEvent.content_block.id : undefined,
                    toolName,
                    innerEvent.content_block.input
                );
                return this.appendProcessLines(currentText, [
                    this.formatStructuredToolCall(toolName, innerEvent.content_block.input)
                ]);
            }
        }

        return currentText;
    }

    protected applyStructuredStreamingEvent(currentText: string, event: any): string {
        if (event?.type === 'assistant.message_delta' && typeof event?.data?.deltaContent === 'string') {
            return currentText + event.data.deltaContent;
        }

        if (event?.type === 'assistant.message' && typeof event?.data?.content === 'string') {
            return this.mergeStreamingText(currentText, event.data.content);
        }

        if (event?.type === 'assistant') {
            const nextAssistantText = this.extractStructuredAssistantText(event);
            return nextAssistantText ? this.mergeStreamingText(currentText, nextAssistantText) : currentText;
        }

        if (event?.type === 'stream_event') {
            const innerEvent = event.event;
            if (innerEvent?.type === 'content_block_delta' && innerEvent.delta?.type === 'text_delta' && typeof innerEvent.delta.text === 'string') {
                return currentText + innerEvent.delta.text;
            }
        }

        return currentText;
    }

    protected applyStructuredReasoningEvent(currentText: string, event: any): string {
        if (event?.type === 'assistant.reasoning_delta' && typeof event?.data?.deltaContent === 'string') {
            return currentText + event.data.deltaContent;
        }

        if (event?.type === 'assistant.reasoning' && typeof event?.data?.content === 'string') {
            return this.mergeStreamingText(currentText, event.data.content);
        }

        if (event?.type === 'assistant.message' && typeof event?.data?.reasoningText === 'string') {
            return this.mergeStreamingText(currentText, event.data.reasoningText);
        }

        return currentText;
    }

    protected mergeStreamingText(currentText: string, nextText: string): string {
        if (!currentText) {
            return nextText;
        }
        if (!nextText) {
            return currentText;
        }
        if (nextText.startsWith(currentText)) {
            return nextText;
        }
        if (currentText.endsWith(nextText)) {
            return currentText;
        }
        return currentText + nextText;
    }

    protected extractStructuredUsageLog(event: any): string | undefined {
        return undefined;
    }

    /**
     * Interactive daemon initialization for agent mode.
     */
    public async initialize(mode: AgentMode): Promise<void> {
        if (this.childProcess) {
            if (this.currentMode !== mode) {
                debugLog(this.id, 'Stopping existing daemon because mode changed', JSON.stringify({ from: this.currentMode, to: mode }));
                this.stop();
            } else {
                debugLog(this.id, 'Reusing existing daemon', JSON.stringify({ mode }));
                return;
            }
        }

        this.currentMode = mode;
        const workspacePath = PersistentAgentAdapter.resolveWorkspacePath();
        const currentCwd = workspacePath.path;
        const { cmd, args } = this.getSpawnCommand(mode);
        debugLog(this.id, 'Starting daemon', JSON.stringify({ mode, cwd: currentCwd, cwdSource: workspacePath.source, cmd, args }));

        const safeEnv: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', CI: 'false', FORCE_COLOR: '0' };
        if (process.platform === 'win32' && !safeEnv.CLAUDE_CODE_GIT_BASH_PATH) {
            safeEnv.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
        }

        this.childProcess = platformSpawn(cmd, args, {
            cwd: currentCwd,
            env: safeEnv as any
        });

        this.childProcess.stdout.on('data', (data) => {
            const chunk = stripAnsi(decodeBuffer(data));
            debugLog(this.id, 'daemon stdout chunk', formatChunk(chunk));
            this.handleOutput(chunk);
        });

        this.childProcess.stderr.on('data', (data) => {
            const chunk = stripAnsi(decodeBuffer(data));
            debugLog(this.id, 'daemon stderr chunk', formatChunk(chunk));
            this.handleOutput(chunk, true);
        });

        this.childProcess.on('error', (err) => {
            debugLog(this.id, 'Daemon process error', err.stack || String(err));
            if (this.turnReject) {
                this.turnReject(err);
                this.resetTurnState();
            }
        });

        this.childProcess.on('close', (code) => {
            debugLog(this.id, 'Daemon process closed', JSON.stringify({ code, mode: this.currentMode }));
            this.childProcess = null;
            if (this.turnReject) {
                this.turnReject(new Error(`Daemon exited unexpectedly (code ${code})`));
                this.resetTurnState();
            }
        });
    }

    protected handleOutput(chunk: string, isError: boolean = false): void {
        // Prevent unbounded memory growth — discard oldest output when buffer is too large
        if (this.outputBuffer.length > MAX_OUTPUT_BUFFER_BYTES) {
            const keepFrom = this.outputBuffer.length - Math.floor(MAX_OUTPUT_BUFFER_BYTES * 0.8);
            this.outputBuffer = this.outputBuffer.slice(keepFrom);
            debugLog(this.id, 'Output buffer truncated to stay within safety cap');
        }

        const lines = chunk.split('\n');
        
        for (const line of lines) {
            if (isError) {
                this.outputBuffer += `\n> [LOG] ${line}`;
            } else {
                this.outputBuffer += !!line ? `\n${line}` : '';
            }
        }

        const hasCompletionMarker = !isError && !!this.currentTurnMarker && this.outputBuffer.includes(this.currentTurnMarker);
        const hasPromptTerminator = !isError && chunk.includes(this.promptString);

        if (this.turnOnUpdate) {
            this.turnOnUpdate(this.stripTurnCompletionArtifacts(this.outputBuffer));
        }

        if (hasCompletionMarker) {
            debugLog(this.id, 'Turn completion marker detected', JSON.stringify({ marker: this.currentTurnMarker }));
            if (this.turnResolve) {
                this.turnResolve(this.stripTurnCompletionArtifacts(this.outputBuffer));
                this.resetTurnState();
            }
            return;
        }

        if (hasPromptTerminator) {
            debugLog(this.id, 'Prompt terminator detected', JSON.stringify({ promptString: this.promptString }));
            if (this.turnResolve) {
                this.turnResolve(this.stripTurnCompletionArtifacts(this.outputBuffer));
                this.resetTurnState();
            }
        }
    }

    private resetTurnState() {
        this.turnResolve = null;
        this.turnReject = null;
        this.turnOnUpdate = null;
        this.outputBuffer = '';
        this.currentTurnMarker = null;
    }

    async invoke(prompt: string, mode: AgentMode = 'plan', sessionId?: string, onUpdate?: (chunk: string) => void): Promise<string> {
        // Use one-shot execution unless the adapter explicitly requires a persistent interactive session.
        if (!this.shouldUsePersistentSession(mode)) {
            return this.invokeNonInteractive(prompt, mode, sessionId, onUpdate);
        }

        // Agent mode: use persistent interactive daemon
        if (!this.childProcess || this.currentMode !== mode) {
            await this.initialize(mode);
        }

        return new Promise((resolve, reject) => {
            if (this.turnResolve) {
                debugLog(this.id, 'Rejected invoke because agent is already busy', JSON.stringify({ mode }));
                return reject(new Error(`[${this.id}] Agent is already processing a request.`));
            }

            this.turnResolve = resolve;
            this.turnReject = reject;
            this.turnOnUpdate = onUpdate || null;
            this.outputBuffer = '';
            this.currentTurnMarker = this.buildTurnCompletionMarker();

            const safePrompt = [
                prompt.replace(/\r?\n/g, ' '),
                `When you finish this turn, output exactly ${this.currentTurnMarker} on its own line.`
            ].join(' ') + '\n';
            debugLog(this.id, 'Writing prompt to daemon stdin', JSON.stringify({
                mode,
                promptLength: prompt.length,
                safePromptPreview: safePrompt.slice(0, 400),
                completionMarker: this.currentTurnMarker
            }));
            this.childProcess!.stdin.write(safePrompt);
        });
    }

    public stop(): void {
        if (this.childProcess) {
            debugLog(this.id, 'Killing child process', JSON.stringify({ pid: this.childProcess.pid }));
            this.childProcess.kill();
            this.childProcess = null;
        }
    }
}
