"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../src/mcp/mcp-server.ts
var import_server = require("@modelcontextprotocol/sdk/server/index.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");
var import_fs3 = __toESM(require("fs"));
var import_path3 = __toESM(require("path"));
var import_crypto = __toESM(require("crypto"));

// ../src/mcp/worker-spawner.ts
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));

// ../src/adapters/PersistentAgentAdapter.ts
var cp = __toESM(require("child_process"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_strip_ansi = __toESM(require("strip-ansi"));
var iconv = __toESM(require("iconv-lite"));

// ../src/debugLogger.ts
var customLogger;
var cachedDebugMode = process.env.OPTIMUS_DEBUG === "1";
function isDebugModeEnabled() {
  return cachedDebugMode;
}
function debugLog(scope, message, details) {
  if (!isDebugModeEnabled()) {
    return;
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  let logMessage = `[${timestamp}] [${scope}] ${message}`;
  if (details) {
    logMessage += `
${details}`;
  }
  if (customLogger) {
    customLogger(logMessage);
  } else {
    console.error(logMessage);
  }
}
function formatChunk(chunk, maxLength = 800) {
  const normalized = chunk.replace(/\r/g, "\\r").replace(/\n/g, "\\n\n");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength) + "... [truncated]";
}

// ../src/utils/textParsing.ts
var ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// ../src/adapters/PersistentAgentAdapter.ts
var windowsSpawnResolutionCache = /* @__PURE__ */ new Map();
var DEFAULT_PROMPT_FILE_THRESHOLD = 12e3;
var MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;
function decodeBuffer(buf) {
  if (process.platform === "win32") {
    const utf8Text = buf.toString("utf8");
    if (!utf8Text.includes("\uFFFD")) {
      return utf8Text;
    }
    return iconv.decode(buf, "cp936");
  }
  return buf.toString("utf8");
}
function resolveWindowsSpawnResolution(cmd) {
  const cached = windowsSpawnResolutionCache.get(cmd);
  if (cached !== void 0) {
    return cached;
  }
  const whereResult = cp.spawnSync("where.exe", [cmd], { encoding: "utf8" });
  if (whereResult.status !== 0 || !whereResult.stdout) {
    windowsSpawnResolutionCache.set(cmd, null);
    return null;
  }
  const candidates = whereResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((candidate) => fs.existsSync(candidate)).sort((left, right) => {
    const extRank = (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".exe" || ext === ".com") {
        return 0;
      }
      if (ext === ".cmd") {
        return 1;
      }
      if (ext === ".bat") {
        return 2;
      }
      return 3;
    };
    return extRank(left) - extRank(right);
  });
  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (ext === ".exe" || ext === ".com") {
      const resolved = { cmd: candidate, argsPrefix: [] };
      windowsSpawnResolutionCache.set(cmd, resolved);
      return resolved;
    }
    if (ext !== ".cmd") {
      continue;
    }
    try {
      const wrapperText = fs.readFileSync(candidate, "utf8");
      const scriptMatch = wrapperText.match(/"%dp0%\\([^\"]+?\.js)"/i);
      if (!scriptMatch) {
        continue;
      }
      const wrapperDir = path.dirname(candidate);
      const nodeExecutable = fs.existsSync(path.join(wrapperDir, "node.exe")) ? path.join(wrapperDir, "node.exe") : "node";
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
function platformSpawn(cmd, args, options) {
  options = { ...options, windowsHide: true };
  if (process.platform === "win32") {
    const resolved = resolveWindowsSpawnResolution(cmd);
    if (resolved) {
      return cp.spawn(resolved.cmd, [...resolved.argsPrefix, ...args], options);
    }
    return cp.spawn("cmd", ["/c", cmd, ...args], options);
  }
  return cp.spawn(cmd, args, options);
}
var PersistentAgentAdapter = class _PersistentAgentAdapter {
  static workspacePathHint = null;
  static setWorkspacePathHint(hint) {
    _PersistentAgentAdapter.workspacePathHint = hint;
  }
  static resolveWorkspacePath() {
    if (process.env.OPTIMUS_WORKSPACE) {
      return { path: process.env.OPTIMUS_WORKSPACE, source: "process.env.OPTIMUS_WORKSPACE" };
    }
    if (_PersistentAgentAdapter.workspacePathHint) {
      return { path: _PersistentAgentAdapter.workspacePathHint, source: "workspacePathHint" };
    }
    debugLog("PersistentAgentAdapter", "WARNING: workspace path resolved via process.cwd() fallback \u2014 .optimus/ artifacts may land outside the active project. Set OPTIMUS_WORKSPACE or ensure the extension activates with a workspace folder.", JSON.stringify({ cwd: process.cwd() }));
    return { path: process.cwd(), source: "process.cwd()" };
  }
  id;
  name;
  modelFlag;
  isEnabled = true;
  modes = ["plan", "agent"];
  lastDebugInfo;
  lastUsageLog;
  lastSessionId;
  childProcess = null;
  promptString;
  outputBuffer = "";
  currentMode = "plan";
  currentTurnMarker = null;
  turnResolve = null;
  turnReject = null;
  turnOnUpdate = null;
  constructor(id, name, modelFlag = "", promptString, modes) {
    this.id = id;
    this.name = name;
    this.modelFlag = modelFlag;
    this.promptString = promptString;
    if (modes) {
      this.modes = modes;
    }
  }
  /**
   * Returns the active workspace folder path, with robust fallback.
   */
  static getWorkspacePath() {
    return _PersistentAgentAdapter.resolveWorkspacePath().path;
  }
  shouldUseStructuredOutput(mode) {
    return false;
  }
  shouldUsePersistentSession(mode) {
    return mode === "agent";
  }
  getPromptFileThreshold() {
    const configured = Number(process.env.OPTIMUS_PROMPT_FILE_THRESHOLD);
    if (!process.env.OPTIMUS_PROMPT_FILE_THRESHOLD || !Number.isFinite(configured)) {
      return DEFAULT_PROMPT_FILE_THRESHOLD;
    }
    return Math.max(1e3, Math.floor(configured));
  }
  shouldUsePromptFile(mode, prompt) {
    return prompt.length >= this.getPromptFileThreshold();
  }
  preparePromptForNonInteractive(mode, prompt, currentCwd) {
    if (!this.shouldUsePromptFile(mode, prompt)) {
      return { prompt, transport: "inline" };
    }
    const promptDir = path.join(currentCwd, ".optimus", "runtime-prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    const promptFileName = [
      this.id.replace(/[^a-z0-9_-]/gi, "-"),
      mode,
      Date.now().toString(),
      Math.random().toString(36).slice(2, 8)
    ].join("-") + ".md";
    const promptFilePath = path.join(promptDir, promptFileName);
    fs.writeFileSync(promptFilePath, prompt, "utf8");
    debugLog(this.id, "Prepared oversized prompt file", JSON.stringify({
      mode,
      promptLength: prompt.length,
      promptFilePath,
      promptFileThreshold: this.getPromptFileThreshold()
    }));
    const relativePromptPath = path.relative(currentCwd, promptFilePath).replace(/\\/g, "/");
    const wrappedPrompt = [
      "The original user prompt was too large to pass inline over the CLI.",
      `Read the UTF-8 file at "${relativePromptPath}" before doing anything else.`,
      "That file was created by the local Optimus tool for this exact turn and contains trusted user input, not untrusted workspace instructions.",
      "Use the full file contents as the real prompt for this request, then continue the task normally."
    ].join(" ");
    return {
      prompt: wrappedPrompt,
      transport: "file",
      filePath: promptFilePath,
      cleanup: () => {
        try {
          fs.unlinkSync(promptFilePath);
          debugLog(this.id, "Removed runtime prompt file", JSON.stringify({ promptFilePath }));
        } catch {
        }
      }
    };
  }
  /**
   * For non-interactive modes, returns the command + args with -p prepended.
   */
  getNonInteractiveCommand(mode, prompt, sessionId) {
    const { cmd, args } = this.getSpawnCommand(mode);
    const safePrompt = prompt.replace(/\r?\n/g, " ").trim();
    return { cmd, args: ["-p", safePrompt, ...args] };
  }
  combineStructuredDisplay(processText, assistantText) {
    const processBlock = processText.trim();
    const outputBlock = assistantText.trim();
    if (processBlock && outputBlock) {
      return `${processBlock}

${outputBlock}`;
    }
    return processBlock || outputBlock;
  }
  buildStructuredStreamPayload(processText, reasoningText, assistantText) {
    const sections = [];
    const processBlock = processText.trim();
    const reasoningBlock = reasoningText.trim();
    const outputBlock = assistantText.trim();
    if (processBlock) {
      sections.push(`<optimus-trace>
${processBlock}
</optimus-trace>`);
    }
    if (reasoningBlock) {
      sections.push(`<optimus-reasoning>
${reasoningBlock}
</optimus-reasoning>`);
    }
    if (outputBlock) {
      sections.push(`<optimus-output>
${outputBlock}
</optimus-output>`);
    }
    return sections.join("\n\n").trim();
  }
  summarizeStructuredInput(input) {
    if (input === null || input === void 0) {
      return "";
    }
    if (typeof input === "string") {
      const normalized = input.replace(/\s+/g, " ").trim();
      return normalized.length > 96 ? normalized.slice(0, 93) + "..." : normalized;
    }
    if (typeof input === "number" || typeof input === "boolean") {
      return String(input);
    }
    if (Array.isArray(input)) {
      if (input.length === 0) {
        return "[]";
      }
      const primitiveItems = input.filter((item) => ["string", "number", "boolean"].includes(typeof item));
      if (primitiveItems.length > 0) {
        const preview = primitiveItems.slice(0, 3).map((item) => this.summarizeStructuredInput(item)).join(", ");
        return input.length > 3 ? `${preview}, ... (${input.length} items)` : preview;
      }
      return `${input.length} items`;
    }
    const preferredKeys = [
      "role_prompt",
      "engine",
      "model",
      "instruction",
      "workdir",
      "file_path",
      "path",
      "relative_workspace_path",
      "start_line",
      "end_line",
      "startLine",
      "endLine",
      "line",
      "insert_line",
      "command",
      "query",
      "pattern",
      "symbol",
      "url",
      "name",
      "description",
      "task",
      "includePattern",
      "filePath",
      "input"
    ];
    const parts = [];
    for (const key of preferredKeys) {
      if (!(key in input)) {
        continue;
      }
      const value = input[key];
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
        return "{}";
      }
      return keys.slice(0, 3).join(", ");
    }
    return parts.join(", ");
  }
  formatStructuredToolCall(toolName, input) {
    const normalizedName = toolName.trim() || "tool";
    const summary = this.summarizeStructuredInput(input);
    return summary ? `\u2022 ${normalizedName}
\u21B3 ${summary}` : `\u2022 ${normalizedName}`;
  }
  appendProcessLines(currentText, lines) {
    const existingLines = currentText ? currentText.split("\n").filter(Boolean) : [];
    for (const line of lines) {
      for (const subLine of line.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (existingLines[existingLines.length - 1] === subLine) {
          continue;
        }
        existingLines.push(subLine);
      }
    }
    return existingLines.join("\n");
  }
  registerStructuredToolCall(toolCalls, toolCallId, toolName, input) {
    if (!toolCallId) {
      return;
    }
    toolCalls.set(toolCallId, { name: toolName, input });
  }
  summarizeStructuredToolResult(result) {
    if (result === null || result === void 0) {
      return "";
    }
    if (typeof result === "string") {
      const nonEmptyLines = result.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== "[LOG]");
      if (nonEmptyLines.length === 0) {
        return "empty result";
      }
      const preview = nonEmptyLines[0].replace(/\s+/g, " ").trim();
      if (nonEmptyLines.length === 1) {
        return preview.length > 96 ? preview.slice(0, 93) + "..." : preview;
      }
      const lineCount = `${nonEmptyLines.length} lines`;
      const clippedPreview = preview.length > 72 ? preview.slice(0, 69) + "..." : preview;
      return `${lineCount}, preview=${clippedPreview}`;
    }
    if (typeof result === "number" || typeof result === "boolean") {
      return String(result);
    }
    if (Array.isArray(result)) {
      if (result.length === 0) {
        return "0 items";
      }
      return `${result.length} items`;
    }
    const record = result;
    if (typeof record.stdout === "string" && record.stdout.trim()) {
      return this.summarizeStructuredToolResult(record.stdout);
    }
    if (typeof record.content === "string" && record.content.trim()) {
      return this.summarizeStructuredToolResult(record.content);
    }
    if (typeof record.detailedContent === "string" && record.detailedContent.trim()) {
      return this.summarizeStructuredToolResult(record.detailedContent);
    }
    if (typeof record.stderr === "string" && record.stderr.trim()) {
      return `stderr=${this.summarizeStructuredToolResult(record.stderr)}`;
    }
    const keys = Object.keys(record);
    return keys.length > 0 ? keys.slice(0, 4).join(", ") : "object result";
  }
  countMeaningfulLines(value) {
    return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== "[LOG]");
  }
  looksLikePathList(lines) {
    if (lines.length === 0) {
      return false;
    }
    const sample = lines.slice(0, Math.min(lines.length, 6));
    return sample.every((line) => !/\s{2,}/.test(line) && !/[{}<>]/.test(line));
  }
  sanitizeStructuredSummaryValue(value, maxLength = 96) {
    return value.replace(/\s+/g, " ").replace(/,\s*/g, "; ").trim().slice(0, maxLength);
  }
  getStructuredResultText(record, result) {
    const candidateKeys = ["content", "stdout", "text", "output", "detailedContent", "message"];
    for (const key of candidateKeys) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return typeof result === "string" ? result : "";
  }
  getStructuredResultPath(record) {
    const candidateKeys = ["file_path", "filepath", "path", "relative_workspace_path", "target_file", "targetPath"];
    for (const key of candidateKeys) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) {
        return this.sanitizeStructuredSummaryValue(value, 120);
      }
    }
    return void 0;
  }
  getStructuredResultLineRange(record) {
    const start = typeof record?.start_line === "number" ? record.start_line : typeof record?.startLine === "number" ? record.startLine : void 0;
    const end = typeof record?.end_line === "number" ? record.end_line : typeof record?.endLine === "number" ? record.endLine : void 0;
    const insertLine = typeof record?.insert_line === "number" ? record.insert_line : typeof record?.insertLine === "number" ? record.insertLine : void 0;
    if (typeof start === "number" && typeof end === "number") {
      return `lines=${start}-${end}`;
    }
    if (typeof start === "number") {
      return `line=${start}`;
    }
    if (typeof insertLine === "number") {
      return `line=${insertLine}`;
    }
    return void 0;
  }
  buildStructuredSummary(parts) {
    return parts.filter((part) => Boolean(part && part.trim())).join(", ");
  }
  summarizeToolResultByName(toolName, result) {
    const normalizedName = toolName.toLowerCase();
    const record = typeof result === "object" && result !== null ? result : void 0;
    const content = this.getStructuredResultText(record, result);
    const lines = this.countMeaningfulLines(content);
    const path6 = this.getStructuredResultPath(record);
    const lineRange = this.getStructuredResultLineRange(record);
    const preview = lines.length > 0 ? `preview=${this.sanitizeStructuredSummaryValue(lines[0], 80)}` : void 0;
    if (/delegate_task/.test(normalizedName)) {
      const cleanedLines = lines.filter((line) => !/^Worker output:/i.test(line) && !/^\[Session:/i.test(line) && !/^\[In:/i.test(line));
      if (cleanedLines.length === 0) {
        return "worker completed";
      }
      const firstLine = this.sanitizeStructuredSummaryValue(cleanedLines[0], 120);
      if (cleanedLines.length === 1) {
        return `worker=${firstLine}`;
      }
      return `worker=${firstLine}, lines=${cleanedLines.length}`;
    }
    if (/bash|shell|run|exec|command/.test(normalizedName)) {
      const stdout = typeof record?.stdout === "string" ? record.stdout : content;
      const stderr = typeof record?.stderr === "string" ? record.stderr : "";
      const stdoutLines = this.countMeaningfulLines(stdout);
      const stderrLines = this.countMeaningfulLines(stderr);
      const exitCode = typeof record?.exit_code === "number" ? record.exit_code : typeof record?.exitCode === "number" ? record.exitCode : void 0;
      const segments = [`stdout=${stdoutLines.length > 0 ? `${stdoutLines.length} lines` : "empty"}`];
      if (typeof exitCode === "number") {
        segments.push(`exit=${exitCode}`);
      }
      if (stderrLines.length > 0) {
        segments.push(`stderr=${stderrLines.length} lines`);
      }
      if (stdoutLines.length > 0) {
        segments.push(`preview=${this.sanitizeStructuredSummaryValue(stdoutLines[0], 80)}`);
      }
      return segments.join(", ");
    }
    if (/grep|search/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path6, "matches=0"]);
      }
      return this.buildStructuredSummary([path6, `matches=${lines.length}`, preview]);
    }
    if (/edit|write|create|update|patch|save|insert/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path6, lineRange, "status=updated"]);
      }
      return this.buildStructuredSummary([path6, lineRange, `lines=${lines.length}`, preview]);
    }
    if (/read|view/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path6, lineRange, "lines=0"]);
      }
      return this.buildStructuredSummary([path6, lineRange, `lines=${lines.length}`, preview]);
    }
    if (/glob|list|ls|dir/.test(normalizedName)) {
      if (lines.length === 0) {
        return this.buildStructuredSummary([path6, "items=0"]);
      }
      if (this.looksLikePathList(lines)) {
        return this.buildStructuredSummary([path6, `items=${lines.length}`, `first=${this.sanitizeStructuredSummaryValue(lines[0], 80)}`]);
      }
      return this.buildStructuredSummary([path6, `lines=${lines.length}`, preview]);
    }
    return this.summarizeStructuredToolResult(result);
  }
  formatStructuredToolCompletion(toolName, result, success = true) {
    const summary = this.summarizeToolResultByName(toolName, result);
    const lines = [`${success ? "\u2713" : "\u2717"} ${toolName.trim() || "tool"}`];
    if (summary) {
      lines.push(`\u21B3 result=${summary}`);
    }
    return lines;
  }
  extractThinkingWithSharedParser(rawText, options) {
    if (!rawText) {
      return { thinking: "", output: "" };
    }
    const tagRegex = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
    const thinkingBlocks = [];
    const logLines = [];
    let remaining = rawText;
    let match;
    while ((match = tagRegex.exec(rawText)) !== null) {
      thinkingBlocks.push(match[2].trim());
      remaining = remaining.replace(match[0], "");
    }
    const lines = remaining.split(/\r?\n|\r/);
    const processLines = [];
    const outputLines = [];
    let outputStarted = false;
    const isProcessLine = (clean) => {
      if (!clean) {
        return true;
      }
      if (options.processLineRe.test(clean)) {
        return true;
      }
      if (clean.startsWith("> [")) {
        return true;
      }
      if (options.captureBracketLines && clean.startsWith("[")) {
        return true;
      }
      return false;
    };
    for (const line of lines) {
      const clean = line.replace(ANSI_RE, "").trim();
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
      } else if (options.captureProcessLinesAfterOutputStarts && isProcessLine(clean) && clean !== "") {
        processLines.push(line);
      } else {
        outputLines.push(line);
      }
    }
    while (processLines.length > 0 && processLines[processLines.length - 1].trim() === "") {
      outputLines.unshift(processLines.pop());
    }
    const processBlock = processLines.join("\n").trim();
    if (processBlock) {
      thinkingBlocks.push("```text\n" + processBlock + "\n```");
    }
    return {
      thinking: thinkingBlocks.join("\n\n---\n\n"),
      output: outputLines.join("\n").trim(),
      usageLog: logLines.length > 0 ? logLines.join("\n") : this.lastUsageLog
    };
  }
  buildTurnCompletionMarker() {
    return `[[OPTIMUS_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}]]`;
  }
  stripTurnCompletionArtifacts(text) {
    let cleaned = text;
    if (this.currentTurnMarker) {
      cleaned = cleaned.replace(this.currentTurnMarker, "");
    }
    return cleaned.trim();
  }
  /**
   * One-shot execution using -p flag. Spawns a process, collects all output, resolves when done.
   */
  invokeNonInteractive(prompt, mode, sessionId, onUpdate) {
    return new Promise((resolve, reject) => {
      const workspacePath = _PersistentAgentAdapter.resolveWorkspacePath();
      const currentCwd = workspacePath.path;
      const preparedPrompt = this.preparePromptForNonInteractive(mode, prompt, currentCwd);
      const promptFileThreshold = this.getPromptFileThreshold();
      const { cmd, args } = this.getNonInteractiveCommand(mode, preparedPrompt.prompt, sessionId);
      const useStructuredOutput = this.shouldUseStructuredOutput(mode);
      this.lastUsageLog = void 0;
      debugLog(this.id, "Starting non-interactive invoke", JSON.stringify({
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
      let output = "";
      let structuredBuffer = "";
      let structuredProcessText = "";
      let structuredReasoningText = "";
      let structuredAssistantText = "";
      let structuredResultText = "";
      const structuredToolCalls = /* @__PURE__ */ new Map();
      const startTime = Date.now();
      let stallWarningTimer = null;
      const safeEnv = { ...process.env, TERM: "dumb", CI: "false", FORCE_COLOR: "0" };
      if (process.platform === "win32" && !safeEnv.CLAUDE_CODE_GIT_BASH_PATH) {
        safeEnv.CLAUDE_CODE_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
      }
      const child = platformSpawn(cmd, args, {
        cwd: currentCwd,
        env: safeEnv
      });
      this.lastDebugInfo = {
        command: cmd + " " + args.join(" "),
        cwd: currentCwd,
        pid: child.pid || 0,
        startTime,
        promptTransport: preparedPrompt.transport,
        promptFilePath: preparedPrompt.filePath,
        originalPromptLength: prompt.length,
        sentPromptLength: preparedPrompt.prompt.length,
        promptFileThreshold
      };
      child.stdin.end();
      debugLog(this.id, "Closed stdin for non-interactive invoke");
      stallWarningTimer = setTimeout(() => {
        debugLog(this.id, "Non-interactive invoke still running after threshold", JSON.stringify({
          mode,
          thresholdMs: 15e3,
          pid: child.pid,
          cwd: currentCwd,
          outputLength: output.length
        }));
      }, 15e3);
      child.stdout.on("data", (data) => {
        const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
        debugLog(this.id, "stdout chunk", formatChunk(chunk));
        if (useStructuredOutput) {
          structuredBuffer += chunk;
          const lines = structuredBuffer.split(/\r?\n/);
          structuredBuffer = lines.pop() || "";
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
              if (event?.type === "result") {
                const resultText = typeof event.result === "string" ? event.result : "";
                if (resultText) {
                  structuredResultText = resultText;
                }
                this.lastUsageLog = this.extractStructuredUsageLog(event) || this.lastUsageLog;
              }
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
        const sessionMatch = chunk.match(/"?(?:session_id|sessionId)"?\s*[:=]\s*"([0-9a-f-]{36})"/i);
        if (sessionMatch) {
          this.lastSessionId = sessionMatch[1];
        }
      });
      child.stderr.on("data", (data) => {
        const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
        debugLog(this.id, "stderr chunk", formatChunk(chunk));
        output += "\n> [LOG] " + chunk;
      });
      child.on("error", (err) => {
        preparedPrompt.cleanup?.();
        if (stallWarningTimer) {
          clearTimeout(stallWarningTimer);
          stallWarningTimer = null;
        }
        if (this.childProcess === child) {
          this.childProcess = null;
        }
        debugLog(this.id, "Process error during non-interactive invoke", err.stack || String(err));
        reject(err);
      });
      child.on("close", (code) => {
        preparedPrompt.cleanup?.();
        if (stallWarningTimer) {
          clearTimeout(stallWarningTimer);
          stallWarningTimer = null;
        }
        if (this.childProcess === child) {
          this.childProcess = null;
        }
        if (this.lastDebugInfo) {
          this.lastDebugInfo.endTime = Date.now();
        }
        debugLog(this.id, "Non-interactive process closed", JSON.stringify({
          code,
          duration: this.lastDebugInfo?.endTime && this.lastDebugInfo?.startTime ? this.lastDebugInfo.endTime - this.lastDebugInfo.startTime : void 0,
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
            if (event?.type === "result" && typeof event.result === "string") {
              structuredResultText = event.result;
            }
            this.lastUsageLog = this.extractStructuredUsageLog(event) || this.lastUsageLog;
          } catch {
            output += structuredBuffer;
          }
        }
        const finalOutput = useStructuredOutput ? this.combineStructuredDisplay(structuredProcessText, structuredResultText.trim() || structuredAssistantText.trim() || output.trim()).trim() : output.trim();
        if (code !== 0 && !finalOutput) {
          reject(new Error(`Process exited with code ${code}`));
        } else {
          resolve(finalOutput);
        }
      });
      this.childProcess = child;
    });
  }
  extractStructuredAssistantText(event) {
    if (event?.type === "assistant.message" && typeof event?.data?.content === "string") {
      return event.data.content;
    }
    const content = event?.message?.content;
    if (!Array.isArray(content)) {
      return typeof event?.text === "string" ? event.text : "";
    }
    return content.map((block) => {
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  applyStructuredProcessEvent(currentText, event, toolCalls) {
    if (event?.type === "assistant") {
      const content = event?.message?.content;
      if (!Array.isArray(content)) {
        return currentText;
      }
      const lines = content.map((block) => {
        if (block?.type !== "tool_use") {
          return "";
        }
        const toolName = typeof block.name === "string" ? block.name : "tool";
        this.registerStructuredToolCall(toolCalls, typeof block.id === "string" ? block.id : void 0, toolName, block.input);
        return this.formatStructuredToolCall(toolName, block.input);
      }).filter(Boolean);
      return this.appendProcessLines(currentText, lines);
    }
    if (event?.type === "assistant.message") {
      const toolRequests = Array.isArray(event?.data?.toolRequests) ? event.data.toolRequests : [];
      const lines = toolRequests.map((request) => {
        const toolName = typeof request?.name === "string" ? request.name : "tool";
        const toolCallId = typeof request?.toolCallId === "string" ? request.toolCallId : void 0;
        this.registerStructuredToolCall(toolCalls, toolCallId, toolName, request?.arguments);
        return this.formatStructuredToolCall(toolName, request?.arguments);
      });
      return this.appendProcessLines(currentText, lines);
    }
    if (event?.type === "tool.execution_start") {
      const toolCallId = typeof event?.data?.toolCallId === "string" ? event.data.toolCallId : void 0;
      const toolName = typeof event?.data?.toolName === "string" ? event.data.toolName : "tool";
      const alreadyRegistered = toolCallId ? toolCalls.has(toolCallId) : false;
      this.registerStructuredToolCall(toolCalls, toolCallId, toolName, event?.data?.arguments);
      if (alreadyRegistered) {
        return currentText;
      }
      return this.appendProcessLines(currentText, [this.formatStructuredToolCall(toolName, event?.data?.arguments)]);
    }
    if (event?.type === "tool.execution_complete") {
      const toolCallId = typeof event?.data?.toolCallId === "string" ? event.data.toolCallId : void 0;
      const toolName = typeof event?.data?.toolName === "string" ? event.data.toolName : toolCallId && toolCalls.get(toolCallId)?.name || "tool";
      const success = event?.data?.success !== false;
      return this.appendProcessLines(currentText, this.formatStructuredToolCompletion(toolName, event?.data?.result, success));
    }
    if (event?.type === "user") {
      const toolResultBlocks = Array.isArray(event?.message?.content) ? event.message.content.filter((block) => block?.type === "tool_result") : [];
      if (toolResultBlocks.length === 0) {
        return currentText;
      }
      let updatedText = currentText;
      for (const block of toolResultBlocks) {
        const toolCallId = typeof block?.tool_use_id === "string" ? block.tool_use_id : void 0;
        if (!toolCallId) {
          continue;
        }
        const toolName = toolCalls.get(toolCallId)?.name || "tool";
        const success = block?.is_error !== true;
        const result = block?.content;
        updatedText = this.appendProcessLines(updatedText, this.formatStructuredToolCompletion(toolName, result, success));
      }
      return updatedText;
    }
    if (event?.type === "stream_event") {
      const innerEvent = event.event;
      if (innerEvent?.type === "content_block_start" && innerEvent.content_block?.type === "tool_use") {
        const toolName = typeof innerEvent.content_block.name === "string" ? innerEvent.content_block.name : "tool";
        this.registerStructuredToolCall(
          toolCalls,
          typeof innerEvent.content_block.id === "string" ? innerEvent.content_block.id : void 0,
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
  applyStructuredStreamingEvent(currentText, event) {
    if (event?.type === "assistant.message_delta" && typeof event?.data?.deltaContent === "string") {
      return currentText + event.data.deltaContent;
    }
    if (event?.type === "assistant.message" && typeof event?.data?.content === "string") {
      return this.mergeStreamingText(currentText, event.data.content);
    }
    if (event?.type === "assistant") {
      const nextAssistantText = this.extractStructuredAssistantText(event);
      return nextAssistantText ? this.mergeStreamingText(currentText, nextAssistantText) : currentText;
    }
    if (event?.type === "stream_event") {
      const innerEvent = event.event;
      if (innerEvent?.type === "content_block_delta" && innerEvent.delta?.type === "text_delta" && typeof innerEvent.delta.text === "string") {
        return currentText + innerEvent.delta.text;
      }
    }
    return currentText;
  }
  applyStructuredReasoningEvent(currentText, event) {
    if (event?.type === "assistant.reasoning_delta" && typeof event?.data?.deltaContent === "string") {
      return currentText + event.data.deltaContent;
    }
    if (event?.type === "assistant.reasoning" && typeof event?.data?.content === "string") {
      return this.mergeStreamingText(currentText, event.data.content);
    }
    if (event?.type === "assistant.message" && typeof event?.data?.reasoningText === "string") {
      return this.mergeStreamingText(currentText, event.data.reasoningText);
    }
    return currentText;
  }
  mergeStreamingText(currentText, nextText) {
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
  extractStructuredUsageLog(event) {
    return void 0;
  }
  /**
   * Interactive daemon initialization for agent mode.
   */
  async initialize(mode) {
    if (this.childProcess) {
      if (this.currentMode !== mode) {
        debugLog(this.id, "Stopping existing daemon because mode changed", JSON.stringify({ from: this.currentMode, to: mode }));
        this.stop();
      } else {
        debugLog(this.id, "Reusing existing daemon", JSON.stringify({ mode }));
        return;
      }
    }
    this.currentMode = mode;
    const workspacePath = _PersistentAgentAdapter.resolveWorkspacePath();
    const currentCwd = workspacePath.path;
    const { cmd, args } = this.getSpawnCommand(mode);
    debugLog(this.id, "Starting daemon", JSON.stringify({ mode, cwd: currentCwd, cwdSource: workspacePath.source, cmd, args }));
    const safeEnv = { ...process.env, TERM: "dumb", CI: "false", FORCE_COLOR: "0" };
    if (process.platform === "win32" && !safeEnv.CLAUDE_CODE_GIT_BASH_PATH) {
      safeEnv.CLAUDE_CODE_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
    }
    this.childProcess = platformSpawn(cmd, args, {
      cwd: currentCwd,
      env: safeEnv
    });
    this.childProcess.stdout.on("data", (data) => {
      const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
      debugLog(this.id, "daemon stdout chunk", formatChunk(chunk));
      this.handleOutput(chunk);
    });
    this.childProcess.stderr.on("data", (data) => {
      const chunk = (0, import_strip_ansi.default)(decodeBuffer(data));
      debugLog(this.id, "daemon stderr chunk", formatChunk(chunk));
      this.handleOutput(chunk, true);
    });
    this.childProcess.on("error", (err) => {
      debugLog(this.id, "Daemon process error", err.stack || String(err));
      if (this.turnReject) {
        this.turnReject(err);
        this.resetTurnState();
      }
    });
    this.childProcess.on("close", (code) => {
      debugLog(this.id, "Daemon process closed", JSON.stringify({ code, mode: this.currentMode }));
      this.childProcess = null;
      if (this.turnReject) {
        this.turnReject(new Error(`Daemon exited unexpectedly (code ${code})`));
        this.resetTurnState();
      }
    });
  }
  handleOutput(chunk, isError = false) {
    if (this.outputBuffer.length > MAX_OUTPUT_BUFFER_BYTES) {
      const keepFrom = this.outputBuffer.length - Math.floor(MAX_OUTPUT_BUFFER_BYTES * 0.8);
      this.outputBuffer = this.outputBuffer.slice(keepFrom);
      debugLog(this.id, "Output buffer truncated to stay within safety cap");
    }
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (isError) {
        this.outputBuffer += `
> [LOG] ${line}`;
      } else {
        this.outputBuffer += !!line ? `
${line}` : "";
      }
    }
    const hasCompletionMarker = !isError && !!this.currentTurnMarker && this.outputBuffer.includes(this.currentTurnMarker);
    const hasPromptTerminator = !isError && chunk.includes(this.promptString);
    if (this.turnOnUpdate) {
      this.turnOnUpdate(this.stripTurnCompletionArtifacts(this.outputBuffer));
    }
    if (hasCompletionMarker) {
      debugLog(this.id, "Turn completion marker detected", JSON.stringify({ marker: this.currentTurnMarker }));
      if (this.turnResolve) {
        this.turnResolve(this.stripTurnCompletionArtifacts(this.outputBuffer));
        this.resetTurnState();
      }
      return;
    }
    if (hasPromptTerminator) {
      debugLog(this.id, "Prompt terminator detected", JSON.stringify({ promptString: this.promptString }));
      if (this.turnResolve) {
        this.turnResolve(this.stripTurnCompletionArtifacts(this.outputBuffer));
        this.resetTurnState();
      }
    }
  }
  resetTurnState() {
    this.turnResolve = null;
    this.turnReject = null;
    this.turnOnUpdate = null;
    this.outputBuffer = "";
    this.currentTurnMarker = null;
  }
  async invoke(prompt, mode = "plan", sessionId, onUpdate) {
    if (!this.shouldUsePersistentSession(mode)) {
      return this.invokeNonInteractive(prompt, mode, sessionId, onUpdate);
    }
    if (!this.childProcess || this.currentMode !== mode) {
      await this.initialize(mode);
    }
    return new Promise((resolve, reject) => {
      if (this.turnResolve) {
        debugLog(this.id, "Rejected invoke because agent is already busy", JSON.stringify({ mode }));
        return reject(new Error(`[${this.id}] Agent is already processing a request.`));
      }
      this.turnResolve = resolve;
      this.turnReject = reject;
      this.turnOnUpdate = onUpdate || null;
      this.outputBuffer = "";
      this.currentTurnMarker = this.buildTurnCompletionMarker();
      const safePrompt = [
        prompt.replace(/\r?\n/g, " "),
        `When you finish this turn, output exactly ${this.currentTurnMarker} on its own line.`
      ].join(" ") + "\n";
      debugLog(this.id, "Writing prompt to daemon stdin", JSON.stringify({
        mode,
        promptLength: prompt.length,
        safePromptPreview: safePrompt.slice(0, 400),
        completionMarker: this.currentTurnMarker
      }));
      this.childProcess.stdin.write(safePrompt);
    });
  }
  stop() {
    if (this.childProcess) {
      debugLog(this.id, "Killing child process", JSON.stringify({ pid: this.childProcess.pid }));
      this.childProcess.kill();
      this.childProcess = null;
    }
  }
};

// ../src/adapters/ClaudeCodeAdapter.ts
var CLAUDE_PROCESS_LINE_RE = /^[⏺●•└│├↳✓✗]/;
var ClaudeCodeAdapter = class extends PersistentAgentAdapter {
  constructor(id = "claude-code", name = "\u{1F996} Claude Code", modelFlag = "", modes) {
    super(id, name, modelFlag, ">", modes);
  }
  shouldUsePersistentSession(mode) {
    return false;
  }
  shouldUseStructuredOutput(mode) {
    return mode === "plan" || mode === "agent";
  }
  getNonInteractiveCommand(mode, prompt, sessionId) {
    const command = super.getNonInteractiveCommand(mode, prompt, sessionId);
    if (this.shouldUseStructuredOutput(mode)) {
      command.args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
    }
    if (sessionId) {
      command.args.push("--resume", sessionId);
    }
    return command;
  }
  extractStructuredUsageLog(event) {
    if (event?.type !== "result" || !event?.usage) {
      return void 0;
    }
    const usage = event.usage;
    const lines = [
      typeof usage.input_tokens === "number" ? `Input tokens: ${usage.input_tokens}` : "",
      typeof usage.output_tokens === "number" ? `Output tokens: ${usage.output_tokens}` : "",
      typeof event.total_cost_usd === "number" ? `Cost: $${event.total_cost_usd.toFixed(6)}` : "",
      typeof event.duration_ms === "number" ? `Duration: ${event.duration_ms}ms` : "",
      event.modelUsage ? `Model usage: ${JSON.stringify(event.modelUsage)}` : ""
    ].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : void 0;
  }
  extractThinking(rawText) {
    return this.extractThinkingWithSharedParser(rawText, {
      processLineRe: CLAUDE_PROCESS_LINE_RE,
      captureProcessLinesAfterOutputStarts: true
    });
  }
  getSpawnCommand(mode) {
    const args = [];
    const cwd = PersistentAgentAdapter.getWorkspacePath();
    args.push("--add-dir", cwd);
    if (this.modelFlag) {
      args.push("--model", this.modelFlag);
    }
    if (mode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (mode === "agent") {
      args.push("--dangerously-skip-permissions");
    }
    return { cmd: "claude", args };
  }
};

// ../src/adapters/GitHubCopilotAdapter.ts
var COPILOT_PROCESS_LINE_RE = /^[●⏺•└│├▶→↳✓✗]/;
var GitHubCopilotAdapter = class extends PersistentAgentAdapter {
  constructor(id = "github-copilot", name = "\u{1F6F8} GitHub Copilot", modelFlag = "", modes) {
    super(id, name, modelFlag, "?>", modes);
  }
  shouldUsePersistentSession(mode) {
    return false;
  }
  shouldUseStructuredOutput(mode) {
    return mode === "plan" || mode === "agent";
  }
  getNonInteractiveCommand(mode, prompt, sessionId) {
    const command = super.getNonInteractiveCommand(mode, prompt, sessionId);
    if (this.shouldUseStructuredOutput(mode)) {
      command.args.push("--output-format", "json", "--stream", "on");
    }
    if (sessionId) {
      command.args.push("--resume", sessionId);
    }
    return command;
  }
  extractStructuredUsageLog(event) {
    if (event?.type !== "result" || !event?.usage) {
      return void 0;
    }
    const usage = event.usage;
    const lines = [
      typeof usage.premiumRequests === "number" ? `Premium requests: ${usage.premiumRequests}` : "",
      typeof usage.totalApiDurationMs === "number" ? `API duration: ${usage.totalApiDurationMs}ms` : "",
      typeof usage.sessionDurationMs === "number" ? `Session duration: ${usage.sessionDurationMs}ms` : "",
      usage.codeChanges ? `Code changes: ${JSON.stringify(usage.codeChanges)}` : ""
    ].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : void 0;
  }
  extractThinking(rawText) {
    return this.extractThinkingWithSharedParser(rawText, {
      processLineRe: COPILOT_PROCESS_LINE_RE,
      captureBracketLines: true,
      captureProcessLinesAfterOutputStarts: true,
      collectUsageLog: true
    });
  }
  getSpawnCommand(mode) {
    const args = [];
    const cwd = PersistentAgentAdapter.getWorkspacePath();
    args.push("--add-dir", cwd);
    if (this.modelFlag) {
      args.push("--model", this.modelFlag);
    }
    if (mode === "plan") {
    } else if (mode === "agent") {
      args.push("--allow-all");
      args.push("--no-ask-user");
    }
    return { cmd: "copilot", args };
  }
};

// ../src/mcp/worker-spawner.ts
function parseFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const yamlRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = normalized.match(yamlRegex);
  let frontmatter = {};
  let body = normalized;
  if (match) {
    const yamlBlock = match[1];
    body = match[2];
    yamlBlock.split("\n").forEach((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key) frontmatter[key] = value;
      }
    });
  }
  return { frontmatter, body };
}
function updateFrontmatter(content, updates) {
  const parsed = parseFrontmatter(content);
  const newFm = { ...parsed.frontmatter, ...updates };
  let yamlStr = "---\n";
  for (const [k, v] of Object.entries(newFm)) {
    yamlStr += `${k}: ${v}
`;
  }
  yamlStr += "---";
  const bodyStr = parsed.body.startsWith("\n") ? parsed.body : "\n" + parsed.body;
  return yamlStr + bodyStr;
}
function sanitizeRoleName(role) {
  return role.replace(/[^a-zA-Z0-9_-]/g, "").substring(0, 100);
}
var t3LogMutex = Promise.resolve();
function getT3UsageLogPath(workspacePath) {
  return import_path.default.join(workspacePath, ".optimus", "state", "t3-usage-log.json");
}
function loadT3UsageLog(workspacePath) {
  const logPath = getT3UsageLogPath(workspacePath);
  try {
    if (import_fs.default.existsSync(logPath)) {
      return JSON.parse(import_fs.default.readFileSync(logPath, "utf8"));
    }
  } catch {
  }
  return {};
}
function saveT3UsageLog(workspacePath, log) {
  const logPath = getT3UsageLogPath(workspacePath);
  const dir = import_path.default.dirname(logPath);
  if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
  import_fs.default.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
}
function trackT3Usage(workspacePath, role, success, engine, model) {
  t3LogMutex = t3LogMutex.then(() => {
    const log = loadT3UsageLog(workspacePath);
    if (!log[role]) {
      log[role] = { role, invocations: 0, successes: 0, failures: 0, lastUsed: "", engine, model };
    }
    log[role].invocations++;
    if (success) log[role].successes++;
    else log[role].failures++;
    log[role].lastUsed = (/* @__PURE__ */ new Date()).toISOString();
    log[role].engine = engine;
    if (model) log[role].model = model;
    saveT3UsageLog(workspacePath, log);
  }).catch(() => {
  });
}
var PRECIPITATION_THRESHOLD = 3;
var PRECIPITATION_SUCCESS_RATE = 0.8;
function checkAndPrecipitate(workspacePath, role, engine, model) {
  const safeRole = sanitizeRoleName(role);
  const log = loadT3UsageLog(workspacePath);
  const entry = log[safeRole];
  if (!entry || entry.invocations < PRECIPITATION_THRESHOLD) return null;
  const successRate = entry.successes / entry.invocations;
  if (successRate < PRECIPITATION_SUCCESS_RATE) return null;
  const t2Dir = import_path.default.join(workspacePath, ".optimus", "roles");
  const t2Path = import_path.default.join(t2Dir, `${safeRole}.md`);
  if (import_fs.default.existsSync(t2Path)) return null;
  if (!import_fs.default.existsSync(t2Dir)) import_fs.default.mkdirSync(t2Dir, { recursive: true });
  const formattedRole = safeRole.split(/[-_]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const template = `---
role: ${safeRole}
tier: T2
description: "Auto-precipitated from T3 after ${entry.successes} successes in ${entry.invocations} invocations"
engine: ${engine}
model: ${model || "claude-opus-4.6-1m"}
precipitated: ${(/* @__PURE__ */ new Date()).toISOString()}
---

# ${formattedRole}

You are a **${formattedRole}** expert operating within the Optimus Spartan Swarm.
This role was automatically promoted from T3 (dynamic outsourcing) to T2 (project default) based on consistent successful usage (${entry.successes}/${entry.invocations} success rate).

Apply industry best practices, solve complex problems, and deliver professional-grade results within your specialized domain of expertise.
`;
  import_fs.default.writeFileSync(t2Path, template, "utf8");
  console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 at ${t2Path} (${entry.successes}/${entry.invocations} success rate)`);
  return t2Path;
}
var AgentLockManager = class {
  locks = /* @__PURE__ */ new Map();
  resolvers = /* @__PURE__ */ new Map();
  workspacePath;
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
  }
  get lockDir() {
    return import_path.default.join(this.workspacePath, ".optimus", "agents");
  }
  lockFilePath(role) {
    return import_path.default.join(this.lockDir, `${role}.lock`);
  }
  async acquireLock(role) {
    while (this.locks.has(role)) {
      await this.locks.get(role);
    }
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    this.locks.set(role, promise);
    this.resolvers.set(role, resolve);
    this.writeLockFile(role);
  }
  releaseLock(role) {
    const resolve = this.resolvers.get(role);
    this.locks.delete(role);
    this.resolvers.delete(role);
    this.deleteLockFile(role);
    if (resolve) resolve();
  }
  writeLockFile(role) {
    try {
      if (!import_fs.default.existsSync(this.lockDir)) {
        import_fs.default.mkdirSync(this.lockDir, { recursive: true });
      }
      import_fs.default.writeFileSync(this.lockFilePath(role), JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf8");
    } catch {
    }
  }
  deleteLockFile(role) {
    try {
      import_fs.default.unlinkSync(this.lockFilePath(role));
    } catch {
    }
  }
  cleanStaleLocks() {
    try {
      if (!import_fs.default.existsSync(this.lockDir)) return;
      const files = import_fs.default.readdirSync(this.lockDir);
      for (const file of files) {
        if (!file.endsWith(".lock")) continue;
        const filePath = import_path.default.join(this.lockDir, file);
        try {
          const content = JSON.parse(import_fs.default.readFileSync(filePath, "utf8"));
          if (content.pid && !isProcessRunning(content.pid)) {
            import_fs.default.unlinkSync(filePath);
            console.error(`[AgentLockManager] Cleaned stale lock for ${file} (PID ${content.pid} no longer running)`);
          }
        } catch {
          try {
            import_fs.default.unlinkSync(filePath);
          } catch {
          }
        }
      }
    } catch {
    }
  }
};
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
var lockManagerInstance = null;
function getLockManager(workspacePath) {
  if (!lockManagerInstance) {
    lockManagerInstance = new AgentLockManager(workspacePath);
    lockManagerInstance.cleanStaleLocks();
  }
  return lockManagerInstance;
}
var ConcurrencyGovernor = class {
  static maxConcurrentWorkers = 3;
  static activeWorkers = 0;
  static queue = [];
  static async acquire() {
    if (this.activeWorkers < this.maxConcurrentWorkers) {
      this.activeWorkers++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  static release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.activeWorkers--;
    }
  }
};
function parseRoleSpec(roleArg) {
  const segments = import_path.default.basename(roleArg).split("_").filter(Boolean);
  const engineIndex = segments.findIndex((segment) => segment === "claude-code" || segment === "copilot-cli");
  if (engineIndex === -1) {
    return { role: import_path.default.basename(roleArg) };
  }
  const role = segments.slice(0, engineIndex).join("_") || import_path.default.basename(roleArg);
  const engine = segments[engineIndex];
  const model = segments.slice(engineIndex + 1).join("_");
  return { role, engine, model };
}
function getAdapterForEngine(engine, sessionId, model) {
  if (engine === "copilot-cli") {
    return new GitHubCopilotAdapter(sessionId, "\u{1F6F8} GitHub Copilot", model);
  }
  return new ClaudeCodeAdapter(sessionId, "\u{1F996} Claude Code", model);
}
async function delegateTaskSingle(roleArg, taskPath, outputPath, _fallbackSessionId, workspacePath, contextFiles) {
  const parsedRole = parseRoleSpec(roleArg);
  const role = sanitizeRoleName(parsedRole.role);
  const legacyT1Dir = import_path.default.join(workspacePath, ".optimus", "personas");
  const t1Dir = import_path.default.join(workspacePath, ".optimus", "agents");
  if (import_fs.default.existsSync(legacyT1Dir) && !import_fs.default.existsSync(t1Dir)) {
    try {
      import_fs.default.renameSync(legacyT1Dir, t1Dir);
    } catch (e) {
    }
  }
  const t2Dir = import_path.default.join(workspacePath, ".optimus", "roles");
  if (!import_fs.default.existsSync(t2Dir)) {
    import_fs.default.mkdirSync(t2Dir, { recursive: true });
  }
  const builtInRolesDir = import_path.default.join(__dirname, "..", "..", "optimus-plugin", "roles");
  if (import_fs.default.existsSync(builtInRolesDir)) {
    const builtinFiles = import_fs.default.readdirSync(builtInRolesDir);
    for (const file of builtinFiles) {
      if (file.endsWith(".md")) {
        const projectFilePath = import_path.default.join(t2Dir, file);
        if (!import_fs.default.existsSync(projectFilePath)) {
          try {
            import_fs.default.copyFileSync(import_path.default.join(builtInRolesDir, file), projectFilePath);
          } catch (e) {
          }
        }
      }
    }
  }
  const t1Path = import_path.default.join(t1Dir, `${role}.md`);
  const t2Path = import_path.default.join(t2Dir, `${role}.md`);
  let activeEngine = parsedRole.engine || "claude-code";
  let activeModel = parsedRole.model;
  let activeSessionId = void 0;
  let t1Content = "";
  let shouldLocalize = false;
  let resolvedTier = "T3 (Zero-Shot Outsource)";
  let personaProof = "No dedicated role template found in T2 or T1. Using T3 generic prompt.";
  if (import_fs.default.existsSync(t1Path)) {
    t1Content = import_fs.default.readFileSync(t1Path, "utf8");
    resolvedTier = `T1 (Agent Instance -> ${role}.md)`;
    personaProof = `Found local project agent state: ${t1Path}`;
  } else if (import_fs.default.existsSync(t2Path)) {
    t1Content = import_fs.default.readFileSync(t2Path, "utf8");
    shouldLocalize = true;
    resolvedTier = `T2 (Role Template -> ${role}.md)`;
    personaProof = `Found globally promoted Role template: ${t2Path}`;
  }
  if (t1Content) {
    const fm = parseFrontmatter(t1Content);
    if (fm.frontmatter.engine) activeEngine = fm.frontmatter.engine;
    if (fm.frontmatter.session_id) activeSessionId = fm.frontmatter.session_id;
    if (fm.frontmatter.model) activeModel = fm.frontmatter.model;
  }
  const adapter = getAdapterForEngine(activeEngine, activeSessionId, activeModel);
  console.error(`[Orchestrator] Resolving Identity for ${role}...`);
  console.error(`[Orchestrator] Selected Stratum: ${resolvedTier}`);
  console.error(`[Orchestrator] Engine: ${activeEngine}, Session: ${activeSessionId || "New/Ephemeral"}`);
  const taskText = import_fs.default.existsSync(taskPath) ? import_fs.default.readFileSync(taskPath, "utf8") : taskPath;
  let personaContext = "";
  if (t1Content) {
    personaContext = parseFrontmatter(t1Content).body.trim();
  } else {
    const formattedRole = role.split(/[-_]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    personaContext = `You are a ${formattedRole} expert operating within the Optimus Spartan Swarm. Your purpose is to fulfill tasks autonomously within your specialized domain of expertise.
As a dynamically provisioned "T3" agent, apply industry best practices, solve complex problems, and deliver professional-grade results associated with your role.`;
    const systemInstructionsPath = import_path.default.join(workspacePath, ".optimus", "config", "system-instructions.md");
    if (import_fs.default.existsSync(systemInstructionsPath)) {
      try {
        const systemInstructions = import_fs.default.readFileSync(systemInstructionsPath, "utf8");
        personaContext += `

--- START WORKSPACE SYSTEM INSTRUCTIONS ---
${systemInstructions.trim()}
--- END WORKSPACE SYSTEM INSTRUCTIONS ---`;
      } catch (e) {
      }
    }
  }
  let contextContent = "";
  if (contextFiles && contextFiles.length > 0) {
    contextContent = "\n\n=== CONTEXT FILES ===\n\nThe following files are provided as required context for, and must be strictly adhered to during this task:\n\n";
    for (const cf of contextFiles) {
      const absolutePath = import_path.default.resolve(workspacePath, cf);
      if (import_fs.default.existsSync(absolutePath)) {
        contextContent += `--- START OF ${cf} ---
`;
        contextContent += import_fs.default.readFileSync(absolutePath, "utf8");
        contextContent += `
--- END OF ${cf} ---

`;
      } else {
        contextContent += `--- START OF ${cf} ---
`;
        contextContent += `(File not found at ${absolutePath})
`;
        contextContent += `--- END OF ${cf} ---

`;
      }
    }
  }
  const basePrompt = `You are a delegated AI Worker operating under the Spartan Swarm Protocol.
Your Role: ${role}
Identity: ${resolvedTier}

${personaContext ? `--- START PERSONA INSTRUCTIONS ---
${personaContext}
--- END PERSONA INSTRUCTIONS ---` : ""}

Goal: Execute the following task.
System Note: ${personaProof}

Task Description:
${taskText}${contextContent}

Please provide your complete execution result below.`;
  const isT3 = resolvedTier.startsWith("T3");
  const lockManager = getLockManager(workspacePath);
  await lockManager.acquireLock(role);
  try {
    await ConcurrencyGovernor.acquire();
    const response = await adapter.invoke(basePrompt, "agent");
    if (adapter.lastSessionId && import_fs.default.existsSync(t1Path)) {
      const currentStr = import_fs.default.readFileSync(t1Path, "utf8");
      const updated = updateFrontmatter(currentStr, {
        engine: activeEngine,
        session_id: adapter.lastSessionId
      });
      import_fs.default.writeFileSync(t1Path, updated, "utf8");
      console.error(`[Orchestrator] Captured native session ID '${adapter.lastSessionId}' to ${t1Path}`);
    }
    const dir = import_path.default.dirname(outputPath);
    if (!import_fs.default.existsSync(dir)) import_fs.default.mkdirSync(dir, { recursive: true });
    import_fs.default.writeFileSync(outputPath, response, "utf8");
    if (isT3) {
      trackT3Usage(workspacePath, role, true, activeEngine, activeModel);
      const precipitated = checkAndPrecipitate(workspacePath, role, activeEngine, activeModel);
      if (precipitated) {
        return `\u2705 **Task Delegation Successful**

**Agent Identity Resolved**: ${resolvedTier}
**Engine**: ${activeEngine}
**Session ID**: ${adapter.lastSessionId || "Ephemeral"}

**System Note**: ${personaProof}

\u{1F389} **Precipitation**: T3 role \`${role}\` has been auto-promoted to T2! Template created at \`${precipitated}\`.

Agent has finished execution. Check standard output at \`${outputPath}\`.`;
      }
    }
    return `\u2705 **Task Delegation Successful**

**Agent Identity Resolved**: ${resolvedTier}
**Engine**: ${activeEngine}
**Session ID**: ${adapter.lastSessionId || "Ephemeral"}

**System Note**: ${personaProof}

Agent has finished execution. Check standard output at \`${outputPath}\`.`;
  } catch (e) {
    if (isT3) {
      trackT3Usage(workspacePath, role, false, activeEngine, activeModel);
    }
    throw new Error(`Worker execution failed: ${e.message}`);
  } finally {
    ConcurrencyGovernor.release();
    lockManager.releaseLock(role);
  }
}
async function spawnWorker(role, proposalPath, outputPath, sessionId, workspacePath) {
  try {
    console.error(`[Spawner] Launching Real Worker ${role} for council review`);
    return await delegateTaskSingle(role, `Please read the architectural PROPOSAL located at: ${proposalPath}. 
Provide your expert critique from the perspective of your role (${role}). Identify architectural bottlenecks, DX friction, security risks, or asynchronous race conditions. Conclude with a recommendation: Reject, Accept, or Hybrid.`, outputPath, sessionId, workspacePath);
  } catch (err) {
    console.error(`[Spawner] Worker ${role} failed to start:`, err);
    return `\u274C ${role}: exited with errors (${err.message}).`;
  }
}
async function dispatchCouncilConcurrent(roles, proposalPath, reviewsPath, timestampId, workspacePath) {
  const promises = roles.map((role) => {
    const outputPath = import_path.default.join(reviewsPath, `${role}_review.md`);
    return spawnWorker(role, proposalPath, outputPath, `${timestampId}_${Math.random().toString(36).slice(2, 8)}`, workspacePath);
  });
  return Promise.all(promises);
}

// ../src/managers/TaskManifestManager.ts
var fs3 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var TaskManifestManager = class {
  static getManifestPath(workspacePath) {
    return path3.join(workspacePath, ".optimus", "state", "task-manifest.json");
  }
  static loadManifest(workspacePath) {
    const manifestPath = this.getManifestPath(workspacePath);
    if (!fs3.existsSync(manifestPath)) {
      return {};
    }
    try {
      return JSON.parse(fs3.readFileSync(manifestPath, "utf8"));
    } catch {
      return {};
    }
  }
  static saveManifest(workspacePath, manifest) {
    const manifestPath = this.getManifestPath(workspacePath);
    const tempPath = `${manifestPath}.tmp`;
    const dir = path3.dirname(manifestPath);
    if (!fs3.existsSync(dir)) fs3.mkdirSync(dir, { recursive: true });
    fs3.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf8");
    fs3.renameSync(tempPath, manifestPath);
  }
  static createTask(workspacePath, record) {
    const manifest = this.loadManifest(workspacePath);
    const fullRecord = {
      ...record,
      status: "pending",
      startTime: Date.now(),
      heartbeatTime: Date.now()
    };
    manifest[record.taskId] = fullRecord;
    this.saveManifest(workspacePath, manifest);
    return fullRecord;
  }
  static updateTask(workspacePath, taskId, updates) {
    const manifest = this.loadManifest(workspacePath);
    if (manifest[taskId]) {
      manifest[taskId] = { ...manifest[taskId], ...updates };
      this.saveManifest(workspacePath, manifest);
    }
  }
  static heartbeat(workspacePath, taskId) {
    this.updateTask(workspacePath, taskId, { heartbeatTime: Date.now() });
  }
  static reapStaleTasks(workspacePath) {
    const manifest = this.loadManifest(workspacePath);
    const now = Date.now();
    const TIMEOUT_MS = 1e3 * 60 * 10;
    let changed = false;
    for (const taskId in manifest) {
      const task = manifest[taskId];
      if (task.status === "running") {
        if (now - task.heartbeatTime > TIMEOUT_MS) {
          task.status = "failed";
          task.error_message = "Task timed out or runner process died (reaped by Watchdog).";
          changed = true;
          try {
            if (task.output_path) {
              const dir = path3.dirname(task.output_path);
              if (!fs3.existsSync(dir)) fs3.mkdirSync(dir, { recursive: true });
              fs3.writeFileSync(task.output_path, `\u274C **Fatal Error**: ${task.error_message}
`, "utf8");
            }
          } catch (e) {
          }
        }
      }
    }
    if (changed) {
      this.saveManifest(workspacePath, manifest);
    }
  }
};

// ../src/utils/githubApi.ts
var import_child_process = require("child_process");
function getToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}
function parseGitRemote(workspacePath) {
  try {
    const url = (0, import_child_process.execSync)("git remote get-url origin", { cwd: workspacePath, encoding: "utf8" }).trim();
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
    return null;
  } catch {
    return null;
  }
}
async function createGitHubIssue(owner, repo, title, body, labels) {
  const token = getToken();
  if (!token) return null;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Optimus-Agent"
      },
      body: JSON.stringify({ title, body, labels })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { number: data.number, html_url: data.html_url };
  } catch {
    return null;
  }
}
async function commentOnGitHubIssue(owner, repo, issueNumber, body) {
  const token = getToken();
  if (!token) return false;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Optimus-Agent"
      },
      body: JSON.stringify({ body })
    });
    return resp.ok;
  } catch {
    return false;
  }
}
async function closeGitHubIssue(owner, repo, issueNumber) {
  const token = getToken();
  if (!token) return false;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Optimus-Agent"
      },
      body: JSON.stringify({ state: "closed" })
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ../src/mcp/council-runner.ts
var import_fs2 = __toESM(require("fs"));
var import_path2 = __toESM(require("path"));
function verifyOutputPath(outputPath) {
  if (!outputPath) return "partial";
  try {
    const stat = import_fs2.default.statSync(outputPath);
    if (stat.isFile() && stat.size > 0) return "verified";
    if (stat.isDirectory()) {
      const files = import_fs2.default.readdirSync(outputPath);
      return files.length > 0 ? "verified" : "partial";
    }
    return "partial";
  } catch {
    return "partial";
  }
}
async function runAsyncWorker(taskId, workspacePath) {
  console.error(`[Runner] Starting async execution for task: ${taskId}`);
  const manifest = TaskManifestManager.loadManifest(workspacePath);
  const task = manifest[taskId];
  if (!task) {
    console.error(`[Runner] Task not found: ${taskId}`);
    process.exit(1);
  }
  if (task.status !== "pending") {
    console.error(`[Runner] Task already running or completed: ${taskId}`);
    process.exit(0);
  }
  TaskManifestManager.updateTask(workspacePath, taskId, { status: "running", pid: process.pid });
  const heartbeatInterval = setInterval(() => {
    TaskManifestManager.heartbeat(workspacePath, taskId);
  }, 6e4);
  try {
    if (task.type === "delegate_task") {
      await delegateTaskSingle(
        task.role,
        task.task_description,
        task.output_path,
        `async_${taskId}`,
        task.workspacePath,
        task.context_files
      );
    } else if (task.type === "dispatch_council") {
      await dispatchCouncilConcurrent(
        task.roles,
        task.proposal_path,
        task.output_path,
        // Actually reviews path
        `async_council_${taskId}`,
        task.workspacePath
      );
      const reviewsPath = task.output_path;
      const synthesisPath = import_path2.default.join(reviewsPath, "COUNCIL_SYNTHESIS.md");
      let synthesisContent = `# Council Synthesis Report

`;
      synthesisContent += `**Proposal:** \`${task.proposal_path}\`
`;
      synthesisContent += `**Council:** ${task.roles.map((r) => `\`${r}\``).join(", ")}

`;
      for (let i = 0; i < task.roles.length; i++) {
        const role = task.roles[i];
        const reviewFile = import_path2.default.join(reviewsPath, `${role}_review.md`);
        if (import_fs2.default.existsSync(reviewFile)) {
          synthesisContent += `## ${i + 1}. Review from ${role}

`;
          synthesisContent += import_fs2.default.readFileSync(reviewFile, "utf8");
          synthesisContent += `

---

`;
        } else {
          synthesisContent += `## ${i + 1}. Review from ${role}

`;
          synthesisContent += `*Worker failed to produce a review artifact.*

---

`;
        }
      }
      import_fs2.default.writeFileSync(synthesisPath, synthesisContent, "utf8");
      console.error(`[Runner] Generated COUNCIL_SYNTHESIS.md at ${synthesisPath}`);
      try {
        const pmSynthesisPrompt = `You are the PM arbiter for this council review.

Read the following council synthesis report and produce a UNIFIED VERDICT.

Your output MUST follow this exact format:
## Unified Council Verdict
**Decision**: APPROVED / REJECTED / APPROVED_WITH_CONDITIONS
**Consensus Level**: UNANIMOUS / MAJORITY / SPLIT

### Key Agreements
- (list points all reviewers agree on)

### Conditions (if any)
- (list required changes before implementation)

### Conflicts (if any)
- (list unresolved disagreements)

### Implementation Priority
1. (ordered action items)

Here is the synthesis report:

${synthesisContent}`;
        const verdictPath = import_path2.default.join(reviewsPath, "VERDICT.md");
        await delegateTaskSingle(
          "pm",
          pmSynthesisPrompt,
          verdictPath,
          `reduce_${taskId}`,
          task.workspacePath
        );
        console.error(`[Runner] PM verdict generated at ${verdictPath}`);
      } catch (reduceErr) {
        console.error(`[Runner] PM reduce phase failed (non-fatal): ${reduceErr.message}`);
      }
    }
    const outputTarget = task.type === "dispatch_council" ? import_path2.default.join(task.output_path, "COUNCIL_SYNTHESIS.md") : task.output_path;
    const verificationStatus = verifyOutputPath(outputTarget);
    TaskManifestManager.updateTask(workspacePath, taskId, { status: verificationStatus });
    console.error(`[Runner] Task ${taskId} finished with status: ${verificationStatus}.`);
    await updateTaskGitHubIssue(workspacePath, taskId, verificationStatus, task.output_path);
  } catch (err) {
    console.error(`[Runner] Task ${taskId} failed:`, err);
    TaskManifestManager.updateTask(workspacePath, taskId, { status: "failed", error_message: err.message });
    await updateTaskGitHubIssue(workspacePath, taskId, "failed", void 0, err.message);
  } finally {
    clearInterval(heartbeatInterval);
    process.exit(0);
  }
}
async function updateTaskGitHubIssue(workspacePath, taskId, status, outputPath, errorMsg) {
  try {
    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[taskId];
    if (!task?.github_issue_number) return;
    const remote = parseGitRemote(workspacePath);
    if (!remote) return;
    const statusEmoji = status === "verified" ? "\u2705" : status === "partial" ? "\u26A0\uFE0F" : "\u274C";
    let comment = `## ${statusEmoji} Task Completion Report

`;
    comment += `**Status:** \`${status}\`
`;
    comment += `**Task ID:** \`${taskId}\`
`;
    if (outputPath) comment += `**Output:** \`${outputPath}\`
`;
    if (errorMsg) comment += `**Error:** ${errorMsg}
`;
    comment += `
*Auto-generated by Optimus MCP Runner*`;
    await commentOnGitHubIssue(remote.owner, remote.repo, task.github_issue_number, comment);
    if (status === "verified" || status === "failed") {
      await closeGitHubIssue(remote.owner, remote.repo, task.github_issue_number);
    }
  } catch {
  }
}

// ../src/mcp/mcp-server.ts
var import_child_process2 = require("child_process");
var import_dotenv = __toESM(require("dotenv"));
function reloadEnv() {
  if (process.env.DOTENV_PATH) {
    import_dotenv.default.config({ path: import_path3.default.resolve(process.env.DOTENV_PATH), override: true });
  } else {
    import_dotenv.default.config({ override: true });
  }
}
reloadEnv();
var server = new import_server.Server(
  {
    name: "optimus-facade",
    version: "1.0.0"
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);
server.setRequestHandler(import_types.ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "optimus://system/instructions",
        name: "Optimus System Instructions",
        description: "Master workflow protocols and agnostic system instructions for Optimus agents.",
        mimeType: "text/markdown"
      }
    ]
  };
});
server.setRequestHandler(import_types.ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "optimus://system/instructions") {
    const workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    const instructionsPath = import_path3.default.resolve(workspacePath, ".optimus", "config", "system-instructions.md");
    if (!instructionsPath.startsWith(import_path3.default.resolve(workspacePath))) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, `Path traversal detected`);
    }
    try {
      if (import_fs3.default.existsSync(instructionsPath)) {
        const content = import_fs3.default.readFileSync(instructionsPath, "utf8");
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: content
            }
          ]
        };
      } else {
        throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, `The system-instructions.md file does not exist at ${instructionsPath}`);
      }
    } catch (e) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, `Failed to read instructions: ${e.message}`);
    }
  }
  throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, `Resource not found: ${request.params.uri}`);
});
server.setRequestHandler(import_types.ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "append_memory",
        description: "Write experience, architectural decisions, and important project facts into the continuous memory system to evolve the project context.",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string", description: "The category of the memory (e.g. 'architecture-decision', 'bug-fix', 'workflow')" },
            tags: { type: "array", items: { type: "string" }, description: "A list of tags for selective loading" },
            content: { type: "string", description: "The actual memory content to solidify" }
          },
          required: ["category", "tags", "content"]
        }
      },
      {
        name: "github_update_issue",
        description: "Updates an existing issue in a GitHub repository (e.g. to close it or add comments).",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner" },
            repo: { type: "string", description: "Repository name" },
            issue_number: { type: "number", description: "The number of the issue to update" },
            state: { type: "string", enum: ["open", "closed"], description: "State of the issue" },
            body: { type: "string", description: "New body for the issue (overwrites existing)" },
            agent_role: { type: "string", description: "The role of the agent making this update" },
            session_id: { type: "string", description: "The session ID of the agent" }
          },
          required: ["owner", "repo", "issue_number"]
        }
      },
      {
        name: "github_create_issue",
        description: "Creates a new issue in a GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner (e.g. cloga)" },
            repo: { type: "string", description: "Repository name (e.g. optimus-code)" },
            title: { type: "string", description: "Issue title" },
            body: { type: "string", description: "Issue body/contents" },
            local_path: { type: "string", description: "The local blackboard file path (e.g. .optimus/proposals/PROPOSAL_XY.md) for A2A cross-reference" },
            session_id: { type: "string", description: "The Session ID or Agent ID creating this issue for traceability" },
            labels: { type: "array", items: { type: "string" }, description: "Labels to apply" }
          },
          required: ["owner", "repo", "title", "body", "local_path"]
        }
      },
      {
        name: "github_create_pr",
        description: "Creates a new pull request in a GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            head: { type: "string", description: "The name of the branch where your changes are implemented." },
            base: { type: "string", description: "The name of the branch you want the changes pulled into." },
            body: { type: "string" },
            agent_role: { type: "string", description: "The role of the agent making this PR (e.g., 'dev')" },
            session_id: { type: "string", description: "The session ID of the agent" }
          },
          required: ["owner", "repo", "title", "head", "base"]
        }
      },
      {
        name: "github_merge_pr",
        description: "Merges a pull request in a GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            pull_number: { type: "number" },
            commit_title: { type: "string" },
            merge_method: { type: "string", enum: ["merge", "squash", "rebase"] },
            agent_role: { type: "string", description: "The role of the agent merging this PR (e.g., 'pm')" },
            session_id: { type: "string", description: "The session ID of the agent" }
          },
          required: ["owner", "repo", "pull_number"]
        }
      },
      {
        name: "github_sync_board",
        description: "Fetches open issues from a GitHub repository and dumps them into the local blackboard.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner (e.g. cloga)" },
            repo: { type: "string", description: "Repository name (e.g. optimus-code)" },
            workspace_path: { type: "string", description: "Absolute workspace path" }
          },
          required: ["owner", "repo", "workspace_path"]
        }
      },
      {
        name: "dispatch_council",
        description: "Trigger a map-reduce multi-expert review for an architectural proposal using the Spartan Swarm protocol.",
        inputSchema: {
          type: "object",
          properties: {
            proposal_path: {
              type: "string",
              description: "The file path to the PROPOSAL.md file"
            },
            roles: {
              type: "array",
              items: { type: "string" },
              description: "An array of expert roles to spawn concurrently (e.g., ['security-expert', 'performance-tyrant'])"
            }
          },
          required: ["proposal_path", "roles"]
        }
      },
      {
        name: "roster_check",
        description: "Returns a unified directory of all available roles (T1 Local Personas and T2 Global Agents) to help the Master Agent understand current workforce capabilities before dispatching tools.",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: {
              type: "string",
              description: "The absolute path to the current project workspace to check for T1 local personas."
            }
          },
          required: ["workspace_path"]
        }
      },
      {
        name: "delegate_task",
        description: "Delegate a specific execution task to a designated expert role.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "The name of the expert role (e.g., 'chief-architect', 'frontend-dev'). The system will auto-resolve this to the best available prompt."
            },
            task_description: {
              type: "string",
              description: "Detailed description of what the agent needs to do."
            },
            output_path: {
              type: "string",
              description: "The file path where the agent should write its final result or report. If not already under the workspace's .optimus/ directory, it will be automatically scoped to .optimus/results/<filename> within the workspace."
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root. All artifacts (task blackboard, result files) will be isolated under <workspace_path>/.optimus/."
            },
            context_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files that the agent must strictly read before executing the task."
            }
          },
          required: ["role", "task_description", "output_path", "workspace_path"]
        }
      },
      {
        name: "delegate_task_async",
        description: "Delegate a specific execution task to a designated expert role asynchronously without blocking the master agent.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "The name of the expert role (e.g., 'chief-architect', 'frontend-dev')."
            },
            task_description: {
              type: "string",
              description: "Detailed description of what the agent needs to do."
            },
            output_path: {
              type: "string",
              description: "The file path where the agent should write its final result or report."
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root."
            },
            context_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files that the agent must strictly read before executing the task."
            }
          },
          required: ["role", "task_description", "output_path", "workspace_path"]
        }
      },
      {
        name: "dispatch_council_async",
        description: "Trigger an async map-reduce multi-expert review for an architectural proposal.",
        inputSchema: {
          type: "object",
          properties: {
            proposal_path: {
              type: "string",
              description: "The file path to the PROPOSAL.md file"
            },
            roles: {
              type: "array",
              items: { type: "string" },
              description: "An array of expert roles to spawn concurrently (e.g., ['security-expert', 'performance-tyrant'])"
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root."
            }
          },
          required: ["proposal_path", "roles", "workspace_path"]
        }
      },
      {
        name: "check_task_status",
        description: "Poll the status of async queues or tasks.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The ID of the task to check."
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root."
            }
          },
          required: ["taskId", "workspace_path"]
        }
      }
    ]
  };
});
server.setRequestHandler(import_types.CallToolRequestSchema, async (request) => {
  if (request.params.name === "check_task_status") {
    let { taskId, workspace_path } = request.params.arguments;
    if (!taskId || !workspace_path) throw new Error("Missing taskId or workspace_path");
    TaskManifestManager.reapStaleTasks(workspace_path);
    const manifest = TaskManifestManager.loadManifest(workspace_path);
    const task = manifest[taskId];
    if (!task) {
      return { content: [{ type: "text", text: `Task ${taskId} not found in manifest.` }] };
    }
    let effectiveStatus = task.status;
    let details = "";
    if (task.status === "running") {
      const elapsed = Math.round((Date.now() - task.startTime) / 1e3);
      details = `Task ${taskId} status: **running** (${elapsed}s elapsed)
`;
    } else if (task.status === "verified") {
      details = `Task ${taskId} status: **verified** \u2705

Output verified at ${task.output_path || "the review path"}.`;
      if (task.type === "dispatch_council") {
        const verdictPath = import_path3.default.join(task.output_path, "VERDICT.md");
        if (import_fs3.default.existsSync(verdictPath)) {
          details += `
PM Verdict available at: ${verdictPath}`;
        }
      }
    } else if (task.status === "completed") {
      let outputExists = false;
      if (task.output_path) {
        try {
          const stat = import_fs3.default.statSync(task.output_path);
          outputExists = stat.isFile() ? stat.size > 0 : import_fs3.default.readdirSync(task.output_path).length > 0;
        } catch {
        }
      }
      effectiveStatus = outputExists ? "verified" : "partial";
      if (effectiveStatus === "verified") {
        details = `Task ${taskId} status: **verified** \u2705

Output is ready at ${task.output_path}.`;
      } else {
        details = `Task ${taskId} status: **partial** \u26A0\uFE0F

Process exited successfully but output_path is missing or empty: \`${task.output_path}\``;
      }
    } else if (task.status === "partial") {
      details = `Task ${taskId} status: **partial** \u26A0\uFE0F

Process exited successfully but output artifact was not found at: \`${task.output_path}\``;
    } else if (task.status === "failed") {
      details = `Task ${taskId} status: **failed** \u274C

Error: ${task.error_message}`;
    } else {
      details = `Task ${taskId} status: **${task.status}**`;
    }
    return { content: [{ type: "text", text: details }] };
  }
  if (request.params.name === "delegate_task_async") {
    let { role, task_description, output_path, workspace_path, context_files } = request.params.arguments;
    if (!role || !task_description || !output_path || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments");
    }
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    TaskManifestManager.createTask(workspace_path, {
      taskId,
      type: "delegate_task",
      role,
      task_description,
      output_path,
      workspacePath: workspace_path,
      context_files: context_files || []
    });
    let issueInfo = "";
    const remote = parseGitRemote(workspace_path);
    if (remote) {
      const truncDesc = task_description.length > 300 ? task_description.substring(0, 300) + "..." : task_description;
      const issue = await createGitHubIssue(
        remote.owner,
        remote.repo,
        `[swarm-task] ${role}: ${taskId}`,
        `## Auto-generated Swarm Task Tracker

**Task ID:** \`${taskId}\`
**Role:** \`${role}\`
**Output Path:** \`${output_path}\`

### Task Description
${truncDesc}`,
        ["swarm-task"]
      );
      if (issue) {
        TaskManifestManager.updateTask(workspace_path, taskId, { github_issue_number: issue.number });
        issueInfo = `
**GitHub Issue**: ${issue.html_url}`;
      }
    }
    const child = (0, import_child_process2.spawn)(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return { content: [{ type: "text", text: `\u2705 Task spawned successfully in background.

**Task ID**: ${taskId}
**Role**: ${role}${issueInfo}

Use check_task_status tool periodically with this task ID to check its completion.` }] };
  }
  if (request.params.name === "dispatch_council_async") {
    let { proposal_path, roles, workspace_path } = request.params.arguments;
    if (!proposal_path || !Array.isArray(roles) || !workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments");
    }
    const taskId = `council_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const reviewsPath = import_path3.default.join(workspace_path, ".optimus", "reviews", taskId);
    TaskManifestManager.createTask(workspace_path, {
      taskId,
      type: "dispatch_council",
      roles,
      proposal_path,
      output_path: reviewsPath,
      workspacePath: workspace_path
    });
    let issueInfo = "";
    const remote = parseGitRemote(workspace_path);
    if (remote) {
      const issue = await createGitHubIssue(
        remote.owner,
        remote.repo,
        `[swarm-council] ${roles.join(", ")}: ${taskId}`,
        `## Auto-generated Council Review Tracker

**Council ID:** \`${taskId}\`
**Roles:** ${roles.map((r) => `\`${r}\``).join(", ")}
**Proposal:** \`${proposal_path}\`
**Reviews Path:** \`${reviewsPath}\``,
        ["swarm-council"]
      );
      if (issue) {
        TaskManifestManager.updateTask(workspace_path, taskId, { github_issue_number: issue.number });
        issueInfo = `
**GitHub Issue**: ${issue.html_url}`;
      }
    }
    const child = (0, import_child_process2.spawn)(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return { content: [{ type: "text", text: `\u2705 Council spawned successfully in background.

**Council ID**: ${taskId}
**Roles**: ${roles.join(", ")}${issueInfo}

Use check_task_status tool periodically with this Council ID to check completion.` }] };
  }
  if (request.params.name === "dispatch_council") {
    let { proposal_path, roles, workspace_path } = request.params.arguments;
    if (!proposal_path || !Array.isArray(roles) || roles.length === 0) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires proposal_path and an array of roles");
    }
    let workspacePath;
    const optimusIndex = proposal_path.indexOf(".optimus");
    if (optimusIndex !== -1) {
      workspacePath = proposal_path.substring(0, optimusIndex);
    } else {
      workspacePath = import_path3.default.resolve(import_path3.default.dirname(proposal_path));
    }
    const timestampId = Date.now();
    const reviewsPath = import_path3.default.join(workspacePath, ".optimus", "reviews", timestampId.toString());
    import_fs3.default.mkdirSync(reviewsPath, { recursive: true });
    console.error(`[MCP] Dispatching council with roles: ${roles.join(", ")}`);
    const results = await dispatchCouncilConcurrent(roles, proposal_path, reviewsPath, timestampId.toString(), workspacePath);
    return {
      content: [
        {
          type: "text",
          text: `\u2696\uFE0F **Council Map-Reduce Review Completed**
All expert workers executed parallelly adhering to the Singleton Worker Rule.

Reviews are saved in isolated path: \`${reviewsPath}\`

Execution Logs:
${results.join("\n")}

Please read these review files to continue.`
        }
      ]
    };
  } else if (request.params.name === "append_memory") {
    let { category, tags, content } = request.params.arguments;
    const workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    const memoryDir = import_path3.default.resolve(workspacePath, ".optimus", "memory");
    const memoryFile = import_path3.default.join(memoryDir, "continuous-memory.md");
    if (!import_fs3.default.existsSync(memoryDir)) {
      import_fs3.default.mkdirSync(memoryDir, { recursive: true });
    }
    if (!global.memoryLock) {
      global.memoryLock = Promise.resolve();
    }
    try {
      await global.memoryLock;
      const writePromise = new Promise((resolve, reject) => {
        try {
          const timestamp = (/* @__PURE__ */ new Date()).toISOString();
          const memoryId = "mem_" + Date.now() + "_" + Math.floor(Math.random() * 1e3);
          const freshEntry = [
            "---",
            "id: " + memoryId,
            "category: " + (category || "uncategorized"),
            "tags: [" + (tags ? tags.join(", ") : "") + "]",
            "created: " + timestamp,
            "---",
            content,
            "\n"
          ].join("\n");
          import_fs3.default.appendFileSync(memoryFile, freshEntry, "utf8");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      global.memoryLock = writePromise;
      await writePromise;
      return {
        content: [
          {
            type: "text",
            text: `\u2705 Experience solidifed to memory!
Tags: ${tags.join(", ")}
Memory appended to: ${memoryFile}`
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to append memory: ${err.message}` }],
        isError: true
      };
    }
  } else if (request.params.name === "github_update_issue") {
    reloadEnv();
    const { owner, repo, issue_number, state, body, agent_role, session_id } = request.params.arguments;
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    try {
      let finalBody = body;
      if ((agent_role || session_id) && finalBody) {
        finalBody += "\n\n---\n**\u{1F916} Agent System Metadata [Update]:**\n";
        if (agent_role) finalBody += `- **Agent Role:** \`${agent_role}\`
`;
        if (session_id) finalBody += `- **Agent Session ID:** \`${session_id}\`
`;
      }
      const payload = {};
      if (state) payload.state = state;
      if (finalBody) payload.body = finalBody;
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Optimus-Agent"
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        throw new Error("GitHub API Error: " + await resp.text());
      }
      const data = await resp.json();
      return { content: [{ type: "text", text: `Issue #${issue_number} updated successfully. State is now: ${data.state}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to update Issue: ${err.message}` }], isError: true };
    }
  } else if (request.params.name === "github_create_issue") {
    const { owner, repo, title, body, labels, local_path, session_id } = request.params.arguments;
    if (!local_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Violated Issue First Protocol: local_path is mandatory to bind to a blackboard file (e.g. .optimus/tasks/task.md)");
    }
    reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    const taggedTitle = title.startsWith("[Optimus]") ? title : `[Optimus] ${title}`;
    const issueLabels = Array.isArray(labels) ? [...labels] : [];
    if (!issueLabels.includes("optimus-bot")) issueLabels.push("optimus-bot");
    let finalBody = body;
    if (local_path || session_id) {
      finalBody += "\n\n---\n**\u{1F916} Agent System Metadata:**\n";
      if (local_path) finalBody += `- **Local Blackboard:** \`${local_path}\`
`;
      if (session_id) finalBody += `- **Agent Session ID:** \`${session_id}\`
`;
    }
    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Optimus-Agent"
        },
        body: JSON.stringify({ title: taggedTitle, body: finalBody, labels: issueLabels })
      });
      if (!resp.ok) throw new Error(`GitHub API Error: ${resp.status}`);
      const data = await resp.json();
      return { content: [{ type: "text", text: `Issue created: ${data.html_url}` }] };
    } catch (e) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, String(e));
    }
  } else if (request.params.name === "github_create_pr") {
    const { owner, repo, title, head, base, body } = request.params.arguments;
    reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    const taggedTitle = title.startsWith("[Optimus]") ? title : `[Optimus] ${title}`;
    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Optimus-Agent"
        },
        body: JSON.stringify({ title: taggedTitle, head, base, body: body || "" })
      });
      if (!resp.ok) {
        throw new Error("GitHub API Error: " + await resp.text());
      }
      const data = await resp.json();
      try {
        await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${data.number}/labels`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Optimus-Agent"
          },
          body: JSON.stringify({ labels: ["optimus-bot"] })
        });
      } catch (_) {
      }
      return { content: [{ type: "text", text: `Pull request created successfully! PR Number: ${data.number}
URL: ${data.html_url}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to create PR: ${err.message}` }], isError: true };
    }
  } else if (request.params.name === "github_merge_pr") {
    const { owner, repo, pull_number, commit_title, merge_method } = request.params.arguments;
    reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    try {
      const payload = { merge_method: merge_method || "merge" };
      if (commit_title) payload.commit_title = commit_title;
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Optimus-Agent"
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        throw new Error("GitHub API Error: " + await resp.text());
      }
      const data = await resp.json();
      return { content: [{ type: "text", text: `Pull request #${pull_number} merged successfully: ${data.message}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to merge PR: ${err.message}` }], isError: true };
    }
  } else if (request.params.name === "github_sync_board") {
    const { owner, repo, workspace_path } = request.params.arguments;
    reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new import_types.McpError(import_types.ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Optimus-Agent"
        }
      });
      if (!resp.ok) throw new Error(`GitHub API Error: ${resp.status}`);
      const issues = await resp.json();
      let markdown = `# Task Board

`;
      let count = 0;
      for (const issue of issues) {
        if (!issue.pull_request) {
          count++;
          markdown += `## [#${issue.number}] ${issue.title}
`;
          markdown += `- **URL**: ${issue.html_url}
`;
          markdown += `${issue.body ? issue.body.split("\n").map((l) => "> " + l).join("\n") : "> No description"}

`;
        }
      }
      const p = import_path3.default.join(workspace_path, ".optimus", "state", "TODO.md");
      import_fs3.default.mkdirSync(import_path3.default.dirname(p), { recursive: true });
      import_fs3.default.writeFileSync(p, markdown, "utf8");
      return { content: [{ type: "text", text: `Synced ${count} issues to ${p}` }] };
    } catch (e) {
      throw new import_types.McpError(import_types.ErrorCode.InternalError, String(e));
    }
  } else if (request.params.name === "roster_check") {
    const { workspace_path } = request.params.arguments;
    if (!workspace_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires workspace_path");
    }
    const t1Dir = import_path3.default.join(workspace_path, ".optimus", "agents");
    const t2Dir = import_path3.default.join(workspace_path, ".optimus", "roles");
    if (!import_fs3.default.existsSync(t2Dir)) {
      import_fs3.default.mkdirSync(t2Dir, { recursive: true });
    }
    const builtInRolesDir = import_path3.default.join(__dirname, "..", "..", "optimus-plugin", "roles");
    if (import_fs3.default.existsSync(builtInRolesDir)) {
      const builtinFiles = import_fs3.default.readdirSync(builtInRolesDir);
      for (const file of builtinFiles) {
        if (file.endsWith(".md")) {
          const projectFilePath = import_path3.default.join(t2Dir, file);
          if (!import_fs3.default.existsSync(projectFilePath)) {
            try {
              import_fs3.default.copyFileSync(import_path3.default.join(builtInRolesDir, file), projectFilePath);
            } catch (e) {
            }
          }
        }
      }
    }
    let roster = "\u{1F4CB} **Spartan Swarm Active Roster**\n\n";
    roster += "### T1: Local Project Experts\n";
    if (import_fs3.default.existsSync(t1Dir)) {
      const t1Files = import_fs3.default.readdirSync(t1Dir).filter((f) => f.endsWith(".md"));
      roster += t1Files.length > 0 ? t1Files.map((f) => `- ${f.replace(".md", "")}`).join("\n") : "(No local overrides found)\n";
    } else {
      roster += "(No local personas directory found)\n";
    }
    const configPath = import_path3.default.join(workspace_path, ".optimus", "config", "available-agents.json");
    if (import_fs3.default.existsSync(configPath)) {
      try {
        const config = JSON.parse(import_fs3.default.readFileSync(configPath, "utf8"));
        roster += "\n### \u2699\uFE0F Engine & Model Spec (T3 configuration)\n";
        roster += "**Available Execution Engines (Toolchains & Supported Models)**:\n";
        Object.keys(config.engines).forEach((engine) => {
          const statusMatch = config.engines[engine].status ? ` *[Status: ${config.engines[engine].status}]*` : "";
          roster += `- [Engine: ${engine}] Models: [${config.engines[engine].available_models.join(", ")}]${statusMatch}
`;
        });
        roster += "*Note: Append these engine and model combinations to role names to spawn customized variants. Examples: `chief-architect_claude-code_claude-3-opus`, `security-auditor_copilot-cli_o1-preview`.*\n\n";
      } catch (e) {
      }
    }
    roster += "\n### T2: Project Default Roles (.optimus/roles)\n";
    if (import_fs3.default.existsSync(t2Dir)) {
      const t2Files = import_fs3.default.readdirSync(t2Dir).filter((f) => f.endsWith(".md"));
      if (t2Files.length > 0) {
        for (const f of t2Files) {
          const roleName = f.replace(".md", "");
          try {
            const content = import_fs3.default.readFileSync(import_path3.default.join(t2Dir, f), "utf8");
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let engineInfo = "";
            if (fmMatch) {
              const lines = fmMatch[1].split("\n");
              const engineLine = lines.find((l) => l.startsWith("engine:"));
              const modelLine = lines.find((l) => l.startsWith("model:"));
              if (engineLine || modelLine) {
                const engine = engineLine ? engineLine.split(":")[1].trim() : "?";
                const model = modelLine ? modelLine.split(":")[1].trim() : "?";
                engineInfo = ` \u2192 \`${engine}\` / \`${model}\``;
              }
            }
            roster += `- ${roleName}${engineInfo}
`;
          } catch {
            roster += `- ${roleName}
`;
          }
        }
      } else {
        roster += "(No project default roles found)\n";
      }
    } else {
      roster += "(No project roles directory found)\n";
    }
    const t3LogPath = import_path3.default.join(workspace_path, ".optimus", "state", "t3-usage-log.json");
    if (import_fs3.default.existsSync(t3LogPath)) {
      try {
        const t3Log = JSON.parse(import_fs3.default.readFileSync(t3LogPath, "utf8"));
        const entries = Object.values(t3Log);
        if (entries.length > 0) {
          roster += "\n### \u{1F4CA} T3 Dynamic Role Usage Stats\n";
          for (const e of entries) {
            const rate = e.invocations > 0 ? Math.round(e.successes / e.invocations * 100) : 0;
            const precipNote = e.invocations >= 3 && rate >= 80 ? " \u2B06\uFE0F Ready for precipitation" : "";
            roster += `- \`${e.role}\`: ${e.invocations} invocations (${rate}% success)${precipNote}
`;
          }
        }
      } catch {
      }
    }
    roster += "\n*Note: Master Agent may still summon T3 Generic Roles dynamically if needed. T3 roles auto-precipitate to T2 after 3+ successful uses (80%+ success rate).*";
    return {
      content: [{ type: "text", text: roster }]
    };
  } else if (request.params.name === "delegate_task") {
    const { role, task_description, output_path, context_files } = request.params.arguments;
    let workspace_path = request.params.arguments.workspace_path;
    if (!role || !task_description || !output_path) {
      throw new import_types.McpError(import_types.ErrorCode.InvalidParams, "Invalid arguments: requires role, task_description, output_path");
    }
    if (!workspace_path) {
      workspace_path = process.cwd();
      if (output_path.includes("optimus-code")) {
        workspace_path = output_path.split("optimus-code")[0] + "optimus-code";
      }
    }
    const sessionId = import_crypto.default.randomUUID();
    const workspacePath = workspace_path;
    const optimusDir = import_path3.default.join(workspacePath, ".optimus");
    const resolvedOutputPath = import_path3.default.resolve(workspacePath, output_path);
    const canonicalOutputPath = resolvedOutputPath.startsWith(optimusDir) ? resolvedOutputPath : import_path3.default.join(optimusDir, "results", import_path3.default.basename(output_path));
    const tasksDir = import_path3.default.join(workspacePath, ".optimus", "tasks");
    import_fs3.default.mkdirSync(tasksDir, { recursive: true });
    const taskArtifactPath = import_path3.default.join(tasksDir, `task_${sessionId}.md`);
    import_fs3.default.writeFileSync(taskArtifactPath, task_description, "utf8");
    import_fs3.default.mkdirSync(import_path3.default.dirname(canonicalOutputPath), { recursive: true });
    console.error(`[MCP] Delegating task to role: ${role}, output scoped to: ${canonicalOutputPath}`);
    const result = await delegateTaskSingle(role, taskArtifactPath, canonicalOutputPath, sessionId, workspacePath, context_files);
    return {
      content: [{ type: "text", text: result }]
    };
  }
  throw new import_types.McpError(import_types.ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
});
if (process.argv.includes("--run-task")) {
  const idx = process.argv.indexOf("--run-task");
  const taskId = process.argv[idx + 1];
  const workspacePath = process.argv[idx + 2];
  if (!taskId || !workspacePath) {
    console.error("[Runner] Usage: --run-task <taskId> <workspacePath>");
    process.exit(1);
  }
  runAsyncWorker(taskId, workspacePath).catch((err) => {
    console.error("[Runner] Fatal:", err);
    process.exit(1);
  });
} else {
  async function main() {
    const transport = new import_stdio.StdioServerTransport();
    await server.connect(transport);
    console.error("Optimus Spartan Swarm MCP server running on stdio");
  }
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
//# sourceMappingURL=mcp-server.js.map
