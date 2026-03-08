const vscode = acquireVsCodeApi();
const chatView = document.getElementById('chat-view');
const sessionsView = document.getElementById('sessions-view');
const askBtn = document.getElementById('ask-btn');
const stopBtn = document.getElementById('stop-btn');
const compactBtn = document.getElementById('compact-btn');
const promptInput = document.getElementById('prompt-input');
const chatHistory = document.getElementById('chat-history');
const sessionsPanel = document.getElementById('sessions-panel');
const toggleBtn = document.getElementById('toggle-sessions-btn');
const backToChatBtn = document.getElementById('back-to-chat-btn');
const workspaceToggleBtn = document.getElementById('toggle-workspace-btn');
const configBtn = document.getElementById('config-btn');
const agentSelector = document.getElementById('agent-selector');
const executorSelector = document.getElementById('executor-selector');
const queueBtn = document.getElementById('queue-btn');
const queueBadge = document.getElementById('queue-badge');
const taskStateStrip = document.getElementById('task-state-strip');
const taskTitle = document.getElementById('task-title');
const taskStatusBadge = document.getElementById('task-status-badge');
const taskTurnCount = document.getElementById('task-turn-count');

const contextBadge = document.getElementById('context-badge');
const contextBadgeLabel = document.getElementById('context-badge-label');
const imagePreviewBar = document.getElementById('image-preview-bar');

let debugMode = document.body.dataset.debugMode === 'true';
let currentCouncilHeader = null;
let currentCouncilDoneTitle = 'Council Verdict';
let currentCouncilAgentDomIds = new Map();
let pendingImages = []; // { dataUrl: string, mimeType: string }[]
let pendingQueue = []; // { text: string, agents: string[], executor: string, images?: object[] }[]
let queuePanelOpen = false; // user-controlled: panel only shows when toggled open
let queuePaused = false;    // when true, auto-dequeue is suspended
let referencedTurns = []; // { sequence: number, prompt: string, status?: string }[]
let submitMode = 'auto'; // 'plan' | 'auto' | 'direct'
let currentTaskTurnHistory = []; // { sequence: number, prompt: string, status: string }[]
let historyListLoading = false;
let historyRestoreLoading = false;

function getPhasePresentation(phaseKind, state, restored) {
    const normalizedKind = phaseKind === 'executor' ? 'executor' : phaseKind === 'synthesizer' ? 'synthesizer' : 'planner';
    if (normalizedKind === 'synthesizer') {
        if (restored) {
            return { icon: '✅', title: 'Synthesis Complete (Restored)' };
        }
        return state === 'done'
            ? { icon: '✅', title: 'Synthesis Complete' }
            : { icon: '⏳', title: 'Synthesizing Planner Results' };
    }
    if (normalizedKind === 'executor') {
        if (restored) {
            return { icon: '✅', title: 'Execution Complete (Restored)' };
        }
        return state === 'done'
            ? { icon: '✅', title: 'Execution Complete' }
            : { icon: '⏳', title: 'Executor Synthesis' };
    }

    if (restored) {
        return { icon: '✅', title: 'Planning Complete (Restored)' };
    }
    return state === 'done'
        ? { icon: '✅', title: 'Planning Complete' }
        : { icon: '⏳', title: 'Council Planning' };
}

function fallbackAgentDomId(agentName) {
    return agentName.replace(/[^a-zA-Z0-9]/g, '');
}

function resolveAgentDomId(agentName) {
    return currentCouncilAgentDomIds.get(agentName) || fallbackAgentDomId(agentName);
}

function renderAgentLabel(name, agentId, role) {
    const safeName = escapeHtmlText(name || 'Unknown Agent');
    const roleBadge = role
        ? '<span style="margin-left:8px; font-size:10px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 6px; text-transform: uppercase; letter-spacing: 0.03em;">' + escapeHtmlText(role) + '</span>'
        : '';
    if (!agentId) {
        return '<strong class="task-name">' + safeName + '</strong>' + roleBadge;
    }

    return '<strong class="task-name">' + safeName + '</strong>'
        + roleBadge
        + '<span style="margin-left:8px; font-size:11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);">[' + escapeHtmlText(agentId) + ']</span>';
}

function isExecutorResponse(response) {
    if (response && (response.role === 'executor' || response.role === 'synthesizer')) {
        return true;
    }
    return !!(response && typeof response.agent === 'string' && /\s\(Executor\)$/.test(response.agent));
}

function renderContextBadge(message) {
    if (!contextBadge || !contextBadgeLabel) {
        return;
    }

    if (message.hasContext && message.label) {
        contextBadgeLabel.textContent = message.label;
        contextBadge.classList.add('visible');
        contextBadge.title = 'Injecting: ' + message.label;
    } else {
        contextBadge.classList.remove('visible');
        contextBadgeLabel.textContent = '';
    }
}

function escapeHtmlText(value) {
    if (!value) {
        return '';
    }
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderSessionAttachmentsHtml(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return '';
    }

    return '<div class="restored-image-strip">'
        + attachments
            .filter(attachment => attachment && attachment.src)
            .map(attachment => '<img class="chat-image" src="' + escapeHtmlText(attachment.src) + '" alt="Attached image">')
            .join('')
        + '</div>';
}

function getRestoredAgentStatusMeta(status, failureReason) {
    if (status === 'running') {
        const normalizedReason = String(failureReason || '').trim();
        if (/^stopped by user:/i.test(normalizedReason)) {
            return {
                label: 'Stopped',
                badgeClass: 'restored-agent-status restored-agent-status-running',
                note: 'This partial snapshot was captured when the user manually stopped the council run.'
            };
        }
        if (/vs code was closed before this turn completed/i.test(normalizedReason)) {
            return {
                label: 'VS Code Closed',
                badgeClass: 'restored-agent-status restored-agent-status-running',
                note: 'This partial snapshot was recovered after VS Code closed before the turn finished.'
            };
        }
        if (/^blocked:/i.test(normalizedReason)) {
            return {
                label: 'Blocked',
                badgeClass: 'restored-agent-status restored-agent-status-running',
                note: normalizedReason
            };
        }
        return {
            label: 'Interrupted',
            badgeClass: 'restored-agent-status restored-agent-status-running',
            note: normalizedReason || 'This is a partial snapshot captured before the agent finished. The turn was interrupted or not fully persisted yet.'
        };
    }
    if (status === 'error') {
        return {
            label: 'Failed',
            badgeClass: 'restored-agent-status restored-agent-status-error',
            note: ''
        };
    }
    return {
        label: 'Completed',
        badgeClass: 'restored-agent-status restored-agent-status-success',
        note: ''
    };
}

function setSessionsLoading(loading, message) {
    historyListLoading = loading;
    if (!sessionsPanel) {
        return;
    }
    if (loading) {
        sessionsPanel.innerHTML = '<div class="history-loading-card"><div class="history-loading-spinner"></div><div>' + escapeHtmlText(message || 'Loading history...') + '</div></div>';
    }
}

function setHistoryRestoreLoading(loading, message) {
    historyRestoreLoading = loading;
    if (!chatHistory) {
        return;
    }
    if (loading) {
        chatHistory.innerHTML = '<div class="history-loading-card history-loading-card-chat"><div class="history-loading-spinner"></div><div>' + escapeHtmlText(message || 'Loading conversation...') + '</div></div>';
    }
}

function renderUsageLogHtml(usageLog) {
    if (!usageLog) {
        return '';
    }

    const lines = String(usageLog)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const kvPairs = [];
    for (const line of lines) {
        const match = /^([^:]+):\s*(.+)$/.exec(line);
        if (!match) {
            continue;
        }
        kvPairs.push({ key: match[1].trim(), value: match[2].trim() });
    }

    if (kvPairs.length === 0) {
        return '';
    }

    const badgePairs = kvPairs.filter(pair => /tokens|cost|duration|requests/i.test(pair.key)).slice(0, 4);
    const detailPairs = kvPairs.filter(pair => !badgePairs.includes(pair));

    let html = '<div class="usage-log-card">';
    if (badgePairs.length > 0) {
        html += '<div class="usage-log-badges">';
        badgePairs.forEach(pair => {
            html += '<span class="usage-log-badge">' + escapeHtmlText(pair.key) + ': ' + escapeHtmlText(pair.value) + '</span>';
        });
        html += '</div>';
    }
    if (detailPairs.length > 0) {
        html += '<div class="usage-log-grid">';
        detailPairs.forEach(pair => {
            html += '<div class="usage-log-key">' + escapeHtmlText(pair.key) + '</div>';
            html += '<div class="usage-log-value">' + escapeHtmlText(pair.value) + '</div>';
        });
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function normalizeProcessLines(thinkingText) {
    if (!thinkingText) {
        return [];
    }

    return String(thinkingText)
        .replace(/```text\s*/gi, '')
        .replace(/```/g, '')
        .split(/\r?\n/)
        .flatMap(line => {
            line = line.trim();
            if (!line || line === '---') return [];
            // Split inline ↳ detail onto its own line.
            // "• Read ↳ file_path=..." → ["• Read", "↳ file_path=..."]
            // "✓ Read ↳ result=..."   → ["✓ Read", "↳ result=..."]
            // "✗ Read ↳ result=..."   → ["✗ Read", "↳ result=..."]
            var inlineDetail = /^([•●⏺▶→✓✗][^↳]+?)\s+(↳\s*.+)$/.exec(line);
            if (inlineDetail) {
                return [inlineDetail[1].trim(), inlineDetail[2].trim()];
            }
            return [line];
        });
}

function extractProcessNotes(thinkingText) {
    return normalizeProcessLines(thinkingText).filter(line => !/^([•●⏺▶→]|↳|>\s*\[LOG\])/i.test(line));
}

function splitMetaParts(metaText) {
    if (!metaText) {
        return [];
    }

    return String(metaText)
        .split(/,\s+/)
        .map(part => part.trim())
        .filter(Boolean);
}

function getProcessBadgeVariant(part, area) {
    const text = String(part || '').toLowerCase();
    if (/file_path=|filepath=|path=|relative_workspace_path=/.test(text)) {
        return 'path';
    }
    if (/start_line=|end_line=|startline=|endline=|insert_line=|line=/.test(text)) {
        return 'count';
    }
    if (/\b\d+\s+(items|matches|lines)\b|stdout=|stderr=|result=\d+/.test(text)) {
        return 'count';
    }
    if (/command=|query=|pattern=|symbol=|description=|first=|result=/.test(text)) {
        return area === 'result' ? 'result-preview' : 'preview';
    }
    return area === 'result' ? 'result-neutral' : 'neutral';
}

function renderProcessBadge(part, area) {
    const baseClass = area === 'result' ? 'process-step-result-badge' : 'process-step-badge';
    const variant = getProcessBadgeVariant(part, area);
    return '<span class="' + baseClass + ' ' + baseClass + '-' + variant + '">' + escapeHtmlText(part) + '</span>';
}

function getDebugRows(message) {
    return [
        { key: 'Command', value: message.command },
        { key: 'CWD', value: message.cwd },
        { key: 'PID', value: message.pid },
        { key: 'Original prompt', value: typeof message.originalPromptLength === 'number' ? message.originalPromptLength + ' chars' : '' },
        { key: 'Sent prompt', value: typeof message.sentPromptLength === 'number' ? message.sentPromptLength + ' chars' : '' },
        { key: 'Threshold', value: typeof message.promptFileThreshold === 'number' ? message.promptFileThreshold + ' chars' : '' },
        { key: 'Prompt file', value: message.promptFilePath }
    ].filter(row => row.value !== undefined && row.value !== null && row.value !== '');
}

function renderDebugCardHtml(message) {
    const statBadges = [];
    if (message.role) {
        statBadges.push('<span class="debug-stat-badge debug-stat-badge-role">' + escapeHtmlText(message.role) + '</span>');
    }
    if (message.promptTransport) {
        statBadges.push('<span class="debug-stat-badge debug-stat-badge-transport">transport=' + escapeHtmlText(message.promptTransport) + '</span>');
    }
    if (typeof message.duration === 'number') {
        statBadges.push('<span class="debug-stat-badge debug-stat-badge-duration">' + escapeHtmlText(String(message.duration)) + 'ms</span>');
    }

    const rows = getDebugRows(message);
    let html = '<div class="debug-card">';
    if (statBadges.length > 0) {
        html += '<div class="debug-stat-badges">' + statBadges.join('') + '</div>';
    }
    if (rows.length > 0) {
        html += '<div class="debug-grid">';
        rows.forEach(row => {
            html += '<div class="debug-key">' + escapeHtmlText(row.key) + '</div>';
            html += '<div class="debug-value">' + escapeHtmlText(String(row.value)) + '</div>';
        });
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function renderDebugDetailsHtml(message) {
    return '<details class="debug-details">'
        + '<summary>🛠 Runtime Details</summary>'
        + renderDebugCardHtml(message)
        + '</details>';
}

function extractProcessEntries(thinkingText) {
    const lines = normalizeProcessLines(thinkingText);
    const entries = [];
    let currentTool = null;
    let detailTarget = 'meta';
    var pendingTools = new Map(); // Map<string, entry[]> — queue per tool name

    lines.forEach(line => {
        const logMatch = /^>\s*\[LOG\]\s*(.*)$/i.exec(line);
        if (logMatch) {
            currentTool = null;
            detailTarget = 'meta';
            entries.push({ kind: 'log', text: (logMatch[1] || '').trim() });
            return;
        }

        const toolMatch = /^[•●⏺▶→]\s*(.+)$/.exec(line);
        if (toolMatch) {
            const rawBody = toolMatch[1].trim();
            const legacyMatch = /^([^()]+?)(?:\s*\((.*)\))?$/.exec(rawBody);
            const title = legacyMatch ? legacyMatch[1].trim() : rawBody;
            const inlineMeta = legacyMatch && legacyMatch[2] ? legacyMatch[2].trim() : '';
            currentTool = {
                kind: 'tool',
                title,
                metaParts: inlineMeta ? splitMetaParts(inlineMeta) : [],
                resultParts: [],
                status: 'running'
            };
            entries.push(currentTool);
            var queue = pendingTools.get(title) || [];
            queue.push(currentTool);
            pendingTools.set(title, queue);
            detailTarget = 'meta';
            return;
        }

        const completionMatch = /^([✓✗])\s*(.+)$/.exec(line);
        if (completionMatch) {
            const status = completionMatch[1] === '✓' ? 'success' : 'error';
            const title = completionMatch[2].trim() || 'Tool';

            // Try currentTool first, then look up in pendingTools queue (FIFO)
            var targetTool = (currentTool && currentTool.title === title)
                ? currentTool
                : null;

            if (!targetTool) {
                var queue = pendingTools.get(title);
                if (queue && queue.length > 0) {
                    targetTool = queue.shift();
                    if (queue.length === 0) {
                        pendingTools.delete(title);
                    }
                }
            } else {
                // Remove from queue if matched via currentTool
                var queue = pendingTools.get(title);
                if (queue) {
                    var idx = queue.indexOf(targetTool);
                    if (idx !== -1) { queue.splice(idx, 1); }
                    if (queue.length === 0) { pendingTools.delete(title); }
                }
            }

            if (targetTool) {
                targetTool.status = status;
                currentTool = targetTool;
                detailTarget = 'result';
                return;
            }

            // Orphan completion: no matching • line found
            currentTool = {
                kind: 'tool',
                title,
                metaParts: [],
                resultParts: [],
                status
            };
            entries.push(currentTool);
            detailTarget = 'result';
            return;
        }

        const detailMatch = /^↳\s*(.+)$/.exec(line);
        if (detailMatch && currentTool) {
            const parts = splitMetaParts(detailMatch[1]);
            if (detailTarget === 'result') {
                currentTool.resultParts.push(...parts);
            } else {
                currentTool.metaParts.push(...parts);
            }
            return;
        }

        currentTool = null;
        detailTarget = 'meta';
    });

    return entries;
}

function getToolIcon(toolName) {
    const name = (toolName || '').toLowerCase();
    if (/read|view|cat|open|get_file|file_content/.test(name)) return '📖';
    if (/write|edit|create|update|patch|save|insert/.test(name)) return '✏️';
    if (/bash|run|exec|shell|command|spawn/.test(name)) return '⚡';
    if (/search|grep|find|glob|ripgrep/.test(name)) return '🔍';
    if (/list|ls|dir/.test(name)) return '📁';
    if (/delete|remove|rm/.test(name)) return '🗑️';
    if (/web|fetch|http|url/.test(name)) return '🌐';
    if (/git/.test(name)) return '🔀';
    if (/todo/.test(name)) return '📋';
    if (/agent/.test(name)) return '🤖';
    if (/notebook/.test(name)) return '📓';
    return '🔧';
}

function renderProcessStepHtml(step, index) {
    if (step.kind === 'log') {
        return '<div class="process-step process-step-log">'
            + '<div class="process-step-index">' + String(index + 1) + '</div>'
            + '<div class="process-step-body">'
            + '<div class="process-step-title">Log</div>'
            + '<div class="process-step-meta">' + escapeHtmlText(step.text || '') + '</div>'
            + '</div></div>';
    }

    const toolName = step.title || 'Tool';
    const icon = getToolIcon(toolName);
    const metaParts = Array.isArray(step.metaParts) ? step.metaParts : [];
    const resultParts = Array.isArray(step.resultParts) ? step.resultParts : [];
    const status = step.status || 'running';

    return '<div class="process-step">'
        + '<div class="process-step-index">' + icon + '</div>'
        + '<div class="process-step-body">'
        + '<div class="process-step-header">'
            + '<div class="process-step-title">' + escapeHtmlText(toolName || 'Tool') + '</div>'
            + '<span class="process-step-status process-step-status-' + escapeHtmlText(status) + '">' + escapeHtmlText(status) + '</span>'
        + '</div>'
        + (metaParts.length > 0
            ? '<div class="process-step-badges">'
                + metaParts.map(part => renderProcessBadge(part, 'meta')).join('')
                + '</div>'
            : '<div class="process-step-meta process-step-meta-muted">No structured args</div>')
        + (resultParts.length > 0
            ? '<div class="process-step-result">'
                + '<div class="process-step-result-label">Completed</div>'
                + '<div class="process-step-result-badges">'
                + resultParts.map(part => renderProcessBadge(part, 'result')).join('')
                + '</div>'
            + '</div>'
            : '')
        + '</div></div>';
}

function renderProcessHtml(thinkingHtml, thinkingText, agentDone) {
    if (!thinkingHtml && !thinkingText) {
        return '';
    }

    const steps = extractProcessEntries(thinkingText);
    const notes = extractProcessNotes(thinkingText);

    if (agentDone) {
        steps.forEach(function(step) {
            if (step.kind === 'tool' && step.status === 'running') {
                step.status = 'interrupted';
            }
        });
    }

    if (steps.length === 0) {
        return '<div class="markdown-body process-markdown-fallback">' + (thinkingHtml || '') + '</div>';
    }

    // Find the boundary where trailing interrupted steps begin
    var trailingInterruptedStart = steps.length;
    if (agentDone) {
        for (var i = steps.length - 1; i >= 0; i--) {
            if (steps[i].kind === 'tool' && steps[i].status === 'interrupted') {
                trailingInterruptedStart = i;
            } else {
                break;
            }
        }
    }
    var trailingCount = steps.length - trailingInterruptedStart;

    let html = '<div class="process-timeline">';
    steps.forEach((step, index) => {
        if (trailingCount >= 3 && index >= trailingInterruptedStart) {
            // Skip individual rendering; handled by collapsed summary below
            return;
        }
        html += renderProcessStepHtml(step, index);
    });

    // Render collapsed summary for trailing interrupted steps (3+)
    if (trailingCount >= 3) {
        var toolNames = {};
        for (var j = trailingInterruptedStart; j < steps.length; j++) {
            var name = steps[j].title || 'tool';
            toolNames[name] = (toolNames[name] || 0) + 1;
        }
        var toolSummary = Object.keys(toolNames).map(function(n) {
            return toolNames[n] > 1 ? n + ' \u00d7' + toolNames[n] : n;
        }).join(', ');

        html += '<details class="process-interrupted-group">'
            + '<summary class="process-interrupted-summary">'
            + '<span class="process-interrupted-icon">\u26a0</span> '
            + escapeHtmlText(String(trailingCount)) + ' tool calls interrupted'
            + '<span class="process-interrupted-tools">' + escapeHtmlText(toolSummary) + '</span>'
            + '</summary>'
            + '<div class="process-interrupted-details">';
        for (var k = trailingInterruptedStart; k < steps.length; k++) {
            html += renderProcessStepHtml(steps[k], k);
        }
        html += '</div></details>';
    }

    html += '</div>';

    if (notes.length > 0) {
        html += '<details class="process-reasoning">'
            + '<summary>🧠 Reasoning (' + notes.length + ' notes)</summary>'
            + '<div class="process-reasoning-body">' + escapeHtmlText(notes.join('\n')) + '</div>'
            + '</details>';
    }

    return html;
}

function renderTaskState(message) {
    if (!taskStateStrip) {
        return;
    }
    // UX Decision: Task state strip is redundant in a standard chat flow.
    // Kept DOM bindings but forcing it to remain hidden.
    // In the future, this might only appear if 'autonomous mode' starts taking >1 loop without user input.
    taskStateStrip.style.display = 'none';
}

function updateTokenCounter(task) {
    const counter = document.getElementById('context-token-counter');
    if (!counter) { return; }
    if (!task || task.contextTokens === undefined) {
        counter.style.display = 'none';
        return;
    }
    const tokens = task.contextTokens;
    const label = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
    counter.textContent = '\uD83D\uDCCA ' + label + ' tokens';
    counter.style.display = '';
    if (task.needsCompaction) {
        counter.style.color = 'var(--vscode-errorForeground)';
        counter.title = 'Context is large \u2014 consider compacting';
    } else {
        counter.style.color = 'var(--vscode-descriptionForeground)';
        counter.title = 'Estimated context token count';
    }
}

function applyDebugMode(enabled) {
    debugMode = enabled;


    const panels = document.querySelectorAll('.debug-panel');
    panels.forEach(panel => {
        if (enabled) {
            panel.classList.add('visible');
        } else {
            panel.classList.remove('visible');
        }
    });
}

function sendToHost(payload, reason) {
    vscode.postMessage(payload);
}

function showView(viewId) {
    chatView.classList.remove('active');
    sessionsView.classList.remove('active');
    document.getElementById(viewId).classList.add('active');
    if (viewId === 'sessions-view' && !historyListLoading) {
        setSessionsLoading(true, 'Loading history...');
    }
}

function bindAgentSelectionLimit() {
    const maxAgents = 3;
    const checkboxes = document.querySelectorAll('.agent-checkbox');
    checkboxes.forEach(input => {
        input.addEventListener('change', function () {
            const checked = document.querySelectorAll('.agent-checkbox:checked');
            if (checked.length > maxAgents) {
                this.checked = false;
            }
        });
    });
}

var _scrollRafScheduled = false;
function scrollChat() {
    if (_scrollRafScheduled) { return; }
    _scrollRafScheduled = true;
    requestAnimationFrame(function () {
        _scrollRafScheduled = false;
        var threshold = 150;
        var gap = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight;
        // Only auto-scroll if user is near the bottom (avoids forcing scroll when reading history)
        if (gap < threshold) {
            chatHistory.scrollTop = chatHistory.scrollHeight;
        }
    });
}

function bindPromptKeyboardShortcut() {
    if (!promptInput) {
        return;
    }

    promptInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
            return;
        }

        event.preventDefault();
        const isQueueVisible = queueBtn && queueBtn.style.display !== 'none';
        if (isQueueVisible) {
            addToQueue();
        } else {
            submitPrompt();
        }
    });

    promptInput.addEventListener('input', function() {
        var text = promptInput.value;
        var match = text.match(/(^|\s)@(\d+)(\s|$)/);
        if (!match) { return; }
        var seq = parseInt(match[2], 10);
        var turn = currentTaskTurnHistory.find(function(t) { return t.sequence === seq; });
        if (!turn) { return; }
        promptInput.value = text.replace(match[0], match[1] + match[3]);
        addTurnReference(seq, turn.prompt);
        promptInput.focus();
    });
}

function addPendingImage(dataUrl, mimeType) {
    pendingImages.push({ dataUrl, mimeType });
    renderImagePreviews();
}

function removePendingImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreviews();
}

function clearPendingImages() {
    pendingImages = [];
    renderImagePreviews();
}

function renderImagePreviews() {
    if (!imagePreviewBar) { return; }
    imagePreviewBar.innerHTML = '';
    pendingImages.forEach((img, index) => {
        const item = document.createElement('div');
        item.className = 'image-preview-item';

        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.alt = 'Pasted image ' + (index + 1);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'image-preview-remove';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove image';
        removeBtn.addEventListener('click', () => removePendingImage(index));

        item.appendChild(imgEl);
        item.appendChild(removeBtn);
        imagePreviewBar.appendChild(item);
    });
}

function addTurnReference(sequence, promptExcerpt) {
    if (referencedTurns.some(r => r.sequence === sequence)) { return; }
    var turnInfo = currentTaskTurnHistory.find(function(t) { return t.sequence === sequence; });
    var status = turnInfo ? turnInfo.status : undefined;
    referencedTurns.push({ sequence, prompt: promptExcerpt, status: status });
    var el = document.querySelector('.message.user[data-sequence="' + sequence + '"]');
    if (el) { el.classList.add('referenced'); }
    renderReferenceChips();
}

function removeTurnReference(sequence) {
    referencedTurns = referencedTurns.filter(r => r.sequence !== sequence);
    var el = document.querySelector('.message.user[data-sequence="' + sequence + '"]');
    if (el) { el.classList.remove('referenced'); }
    renderReferenceChips();
}

function clearTurnReferences() {
    referencedTurns = [];
    document.querySelectorAll('.message.user.referenced').forEach(function(el) { el.classList.remove('referenced'); });
    renderReferenceChips();
}

function renderReferenceChips() {
    var container = document.getElementById('reference-chips');
    if (!container) { return; }
    container.innerHTML = '';
    if (referencedTurns.length === 0) {
        container.style.display = 'none';
        return;
    }
    container.style.display = '';
    referencedTurns.forEach(function(ref) {
        var chip = document.createElement('span');
        chip.className = 'ref-chip';
        var statusIcon = ref.status === 'completed' ? '\u2705' : ref.status === 'failed' ? '\u274C' : '\u23F3';
        var label = '#' + ref.sequence + ' ' + statusIcon + ' ' + (ref.prompt.length > 30 ? ref.prompt.substring(0, 27) + '...' : ref.prompt);
        chip.textContent = label;
        chip.title = 'Turn ' + ref.sequence + ' \u2014 ' + ref.prompt;
        var removeBtn = document.createElement('span');
        removeBtn.className = 'ref-chip-remove';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = 'Remove reference';
        removeBtn.addEventListener('click', function() { removeTurnReference(ref.sequence); });
        chip.appendChild(removeBtn);
        container.appendChild(chip);
    });
}

function attachRefButton(userMsgEl, sequence, promptExcerpt) {
    var btn = document.createElement('button');
    btn.className = 'ref-turn-btn';
    btn.textContent = '@';
    btn.title = 'Add this as context for your next message';
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        addTurnReference(sequence, promptExcerpt);
        promptInput.focus();
    });
    userMsgEl.appendChild(btn);
}

function attachReferencedTurnsIndicator(msgEl, refSeqs) {
    if (!refSeqs || refSeqs.length === 0) { return; }
    var container = document.createElement('div');
    container.className = 'message-ref-cards';
    refSeqs.forEach(function(seq) {
        var turn = currentTaskTurnHistory.find(function(t) { return t.sequence === seq; });
        var card = document.createElement('div');
        card.className = 'message-ref-card';
        card.title = 'Click to jump to Turn #' + seq;

        var header = document.createElement('div');
        header.className = 'message-ref-card-header';
        var seqEl = document.createElement('span');
        seqEl.className = 'message-ref-card-seq';
        seqEl.textContent = '\u2197 #' + seq;
        header.appendChild(seqEl);

        var promptText = turn ? turn.prompt : '';
        if (promptText) {
            var promptEl = document.createElement('span');
            promptEl.className = 'message-ref-card-prompt';
            promptEl.textContent = promptText.length > 50
                ? promptText.substring(0, 47) + '\u2026'
                : promptText;
            header.appendChild(promptEl);
        }
        card.appendChild(header);

        var summary = turn && turn.executorOutcome && turn.executorOutcome.summary
            ? turn.executorOutcome.summary : '';
        if (summary) {
            var summaryEl = document.createElement('div');
            summaryEl.className = 'message-ref-card-summary';
            summaryEl.textContent = summary.length > 100
                ? summary.substring(0, 97) + '\u2026'
                : summary;
            card.appendChild(summaryEl);
        }

        card.addEventListener('click', function() {
            var target = document.querySelector('.message.user[data-sequence="' + seq + '"]');
            if (!target) { return; }
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('ref-highlight-flash');
            setTimeout(function() { target.classList.remove('ref-highlight-flash'); }, 1500);
        });

        container.appendChild(card);
    });
    msgEl.appendChild(container);
}

function bindPasteHandler() {
    if (!promptInput) { return; }
    promptInput.addEventListener('paste', event => {
        const items = event.clipboardData && event.clipboardData.items;
        if (!items) { return; }
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.type.startsWith('image/')) { continue; }
            event.preventDefault();
            const file = item.getAsFile();
            if (!file) { continue; }
            const reader = new FileReader();
            reader.onload = e => {
                addPendingImage(e.target.result, item.type);
            };
            reader.readAsDataURL(file);
        }
    });
}

function getSelectedAgents() {
    const checkboxes = document.querySelectorAll('.agent-checkbox');
    return Array.from(checkboxes).filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
}

function submitPrompt() {
    let text = promptInput.value;
    if (!text.trim() && pendingImages.length === 0) {
        return;
    }

    // Parse /plan and /exec prompt prefix shortcuts
    let effectiveMode = submitMode;
    const prefixMatch = text.match(/^\/(\w+)\s+/);
    if (prefixMatch) {
        const prefix = prefixMatch[1].toLowerCase();
        if (prefix === 'plan') {
            effectiveMode = 'plan';
            text = text.slice(prefixMatch[0].length);
        } else if (prefix === 'exec' || prefix === 'direct') {
            effectiveMode = 'direct';
            text = text.slice(prefixMatch[0].length);
        }
    }

    const selectedAgents = getSelectedAgents();
    if (selectedAgents.length === 0) {
        return;
    }

    const turnSeq = currentTaskTurnHistory.length + 1;
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.dataset.sequence = String(turnSeq);
    if (text.trim()) {
        const textNode = document.createTextNode(text);
        userMsg.appendChild(textNode);
    }
    pendingImages.forEach(img => {
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.className = 'chat-image';
        imgEl.alt = 'Attached image';
        userMsg.appendChild(imgEl);
    });
    chatHistory.appendChild(userMsg);
    if (text.trim()) {
        attachRefButton(userMsg, turnSeq, text.trim());
    }
    scrollChat();

    const executor = executorSelector.value;
    const images = pendingImages.length > 0 ? pendingImages.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType })) : undefined;
    const refSeqs = referencedTurns.length > 0 ? referencedTurns.map(r => r.sequence) : undefined;
    attachReferencedTurnsIndicator(userMsg, refSeqs);
    sendToHost({ type: 'askCouncil', value: text, agents: selectedAgents, mode: effectiveMode, executor: executor, images, referencedTurnSequences: refSeqs }, 'submitPrompt');
    promptInput.value = '';
    clearPendingImages();
    clearTurnReferences();
}

function submitCompact() {

    const compactMsg = document.createElement('div');
    compactMsg.className = 'message user';
    compactMsg.style.cssText = 'text-align: center; background: none; color: var(--vscode-descriptionForeground); font-size: 11px;';
    compactMsg.textContent = '⚡ Compacting Context...';
    chatHistory.appendChild(compactMsg);
    scrollChat();

    sendToHost({ type: 'compactContext' }, 'submitCompact');
}

function updateQueueBadge() {
    if (queueBadge) {
        queueBadge.textContent = pendingQueue.length > 0 ? '(' + pendingQueue.length + ')' : '';
    }
    // Sync the standalone toggle button visibility and count
    var viewBtn = document.getElementById('queue-view-btn');
    var viewCount = document.getElementById('queue-view-count');
    var isQueueVisible = queueBtn && queueBtn.style.display !== 'none';
    if (viewBtn) {
        viewBtn.style.display = (isQueueVisible && pendingQueue.length > 0) ? '' : 'none';
    }
    if (viewCount) {
        viewCount.textContent = pendingQueue.length > 0 ? '(' + pendingQueue.length + ')' : '';
    }
    renderQueuePanel();
}

function renderQueuePanel() {
    var panel = document.getElementById('queue-panel');
    var list = document.getElementById('queue-list');
    if (!panel || !list) { return; }
    if (pendingQueue.length === 0) {
        queuePanelOpen = false;
        panel.style.display = 'none';
        return;
    }
    // Only show panel when user explicitly toggled it open
    var isQueueVisible = queueBtn && queueBtn.style.display !== 'none';
    panel.style.display = (isQueueVisible && queuePanelOpen) ? '' : 'none';
    if (!queuePanelOpen) { return; }
    list.innerHTML = '';

    // Render header action buttons (Run/Pause + Clear All)
    var headerActions = document.getElementById('queue-panel-actions');
    if (headerActions) {
        headerActions.innerHTML = '';
        // Run / Pause toggle
        var toggleBtn = document.createElement('span');
        toggleBtn.className = 'queue-header-action';
        if (queuePaused) {
            toggleBtn.textContent = '\u25B6 Run';
            toggleBtn.title = 'Resume auto-dequeue';
        } else {
            toggleBtn.textContent = '\u23F8 Pause';
            toggleBtn.title = 'Pause auto-dequeue';
        }
        toggleBtn.addEventListener('click', function() {
            queuePaused = !queuePaused;
            renderQueuePanel();
            // If resuming and not running, trigger immediate dequeue
            if (!queuePaused && pendingQueue.length > 0 && stopBtn.style.display === 'none') {
                var next = pendingQueue.shift();
                updateQueueBadge();
                setTimeout(function() { submitFromQueue(next); }, 300);
            }
        });
        headerActions.appendChild(toggleBtn);
        // Clear All
        var clearBtn = document.createElement('span');
        clearBtn.className = 'queue-header-action queue-header-danger';
        clearBtn.textContent = 'Clear All';
        clearBtn.title = 'Remove all queued prompts';
        clearBtn.addEventListener('click', function() {
            pendingQueue = [];
            updateQueueBadge();
        });
        headerActions.appendChild(clearBtn);
    }

    pendingQueue.forEach(function(item, idx) {
        var row = document.createElement('div');
        row.className = 'queue-item';
        var indexSpan = document.createElement('span');
        indexSpan.className = 'queue-item-index';
        indexSpan.textContent = (idx + 1) + '.';
        // Mode badge
        var modeBadge = document.createElement('span');
        modeBadge.className = 'queue-item-mode';
        var modeLabel = { plan: 'Plan', auto: 'Auto', direct: 'Exec' };
        modeBadge.textContent = modeLabel[item.mode] || 'Auto';
        var textSpan = document.createElement('span');
        textSpan.className = 'queue-item-text';
        textSpan.textContent = item.text.length > 60 ? item.text.substring(0, 60) + '...' : item.text;
        textSpan.title = item.text;
        var removeBtn = document.createElement('span');
        removeBtn.className = 'queue-item-remove';
        removeBtn.textContent = '\u2715';
        removeBtn.title = 'Remove from queue';
        removeBtn.dataset.idx = String(idx);
        removeBtn.addEventListener('click', function() {
            var i = parseInt(removeBtn.dataset.idx, 10);
            if (i >= 0 && i < pendingQueue.length) {
                pendingQueue.splice(i, 1);
                updateQueueBadge();
            }
        });
        row.appendChild(indexSpan);
        row.appendChild(modeBadge);
        row.appendChild(textSpan);
        row.appendChild(removeBtn);
        list.appendChild(row);
    });
}

function addToQueue() {
    const text = promptInput.value;
    if (!text.trim() && pendingImages.length === 0) {
        return;
    }

    const selectedAgents = getSelectedAgents();
    if (selectedAgents.length === 0) {
        return;
    }

    const executor = executorSelector.value;
    const images = pendingImages.length > 0 ? pendingImages.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType })) : undefined;
    const refSeqs = referencedTurns.length > 0 ? referencedTurns.map(r => r.sequence) : undefined;
    pendingQueue.push({ text: text, agents: selectedAgents, executor: executor, mode: submitMode, images: images, referencedTurnSequences: refSeqs });
    promptInput.value = '';
    clearPendingImages();
    clearTurnReferences();
    updateQueueBadge();
}

function submitFromQueue(item) {

    const turnSeq = currentTaskTurnHistory.length + 1;
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.dataset.sequence = String(turnSeq);
    if (item.text.trim()) {
        const textNode = document.createTextNode(item.text);
        userMsg.appendChild(textNode);
    }
    if (item.images) {
        item.images.forEach(img => {
            const imgEl = document.createElement('img');
            imgEl.src = img.dataUrl;
            imgEl.className = 'chat-image';
            imgEl.alt = 'Attached image';
            userMsg.appendChild(imgEl);
        });
    }
    chatHistory.appendChild(userMsg);
    if (item.text.trim()) {
        attachRefButton(userMsg, turnSeq, item.text.trim());
    }
    scrollChat();

    attachReferencedTurnsIndicator(userMsg, item.referencedTurnSequences);
    sendToHost({ type: 'askCouncil', value: item.text, agents: item.agents, mode: item.mode || 'auto', executor: item.executor, images: item.images, referencedTurnSequences: item.referencedTurnSequences }, 'submitFromQueue');
}

function handleButtonAction(actionId) {
    switch (actionId) {
        case 'new-chat-btn':
            chatHistory.innerHTML = '<div class="message agent"><div class="agent-name">Optimus Council</div><p>Welcome! Describe your architecture problem, and I will summon the agents concurrently.</p></div>';
            pendingQueue = [];
            queuePaused = false;
            clearTurnReferences();
            currentTaskTurnHistory = [];
            currentCouncilHeader = null;
            currentCouncilDoneTitle = 'Council Verdict';
            currentCouncilAutoCollapse = false;
            currentCouncilAgentDomIds = new Map();
            setRunningState(false);
            updateQueueBadge();
            sendToHost({ type: 'newChat' }, 'new chat');
            break;
        case 'config-btn':
            sendToHost({ type: 'openSettings' }, 'button');
            break;
        case 'toggle-sessions-btn':
            showView('sessions-view');
            sendToHost({ type: 'requestSessions' }, 'button');
            break;
        case 'back-to-chat-btn':
            showView('chat-view');
            break;
        case 'stop-btn':
            sendToHost({ type: 'stopCouncil' }, 'button');
            break;
        case 'compact-btn':
            submitCompact();
            break;
        case 'queue-btn':
            addToQueue();
            break;
        case 'ask-btn':
            submitPrompt();
            break;
    }
}

function bindButtonAction(element, actionId) {
    if (!element) {
        return;
    }

    const handler = event => {
        event.preventDefault();
        event.stopPropagation();
        handleButtonAction(actionId);
    };

    element.addEventListener('click', handler);
    element.addEventListener('pointerup', handler);
}

function getActionIdFromEvent(event) {
    const target = event.composedPath().find(node => node && node.id && [
        'config-btn',
        'new-chat-btn',
        'toggle-sessions-btn',
        'back-to-chat-btn',
        'stop-btn',
        'compact-btn',
        'queue-btn',
        'ask-btn'
    ].includes(node.id));

    return target ? target.id : null;
}

function renderSessionHistory(message) {
    historyListLoading = false;

    // Update workspace toggle button state
    if (workspaceToggleBtn) {
        workspaceToggleBtn.textContent = message.showAllWorkspaces ? 'All workspaces' : 'This workspace';
        workspaceToggleBtn.title = message.showAllWorkspaces
            ? 'Showing all workspaces \u2014 click to filter to current workspace'
            : 'Showing current workspace only \u2014 click to show all';
    }

    sessionsPanel.innerHTML = message.sessions.length ? '' : '<i>No history yet.</i>';
    message.sessions.forEach(session => {
        const div = document.createElement('div');
        div.className = 'session-item' + (session.pinned ? ' session-pinned' : '');
        div.title = (session.taskTitle || session.prompt) + (session.latestSummary ? '\n' + session.latestSummary : '');
        const dateStr = new Date(session.timestamp).toLocaleTimeString();

        const titleRow = document.createElement('div');
        titleRow.className = 'session-title-row';

        const titleText = document.createElement('span');
        titleText.className = 'session-title-text';
        titleText.textContent = dateStr + ' - ' + (session.taskTitle || session.prompt);
        titleRow.appendChild(titleText);

        if (session.pinned) {
            const pinIndicator = document.createElement('span');
            pinIndicator.className = 'session-pin-indicator';
            pinIndicator.textContent = '📌';
            titleRow.appendChild(pinIndicator);
        }

        if (session.isRunning) {
            const runningBadge = document.createElement('span');
            runningBadge.className = 'session-running-badge';
            const dot = document.createElement('span');
            dot.className = 'running-dot';
            runningBadge.appendChild(dot);
            runningBadge.appendChild(document.createTextNode('Running'));
            titleRow.appendChild(runningBadge);
        }

        div.appendChild(titleRow);

        if (Array.isArray(session.attachments) && session.attachments.length > 0) {
            const thumbStrip = document.createElement('div');
            thumbStrip.className = 'session-image-strip';
            session.attachments.forEach(function (att) {
                if (!att || !att.src) { return; }
                var thumb = document.createElement('img');
                thumb.className = 'session-image-thumb';
                thumb.src = att.src;
                thumb.alt = 'Attached image';
                thumbStrip.appendChild(thumb);
            });
            if (thumbStrip.childElementCount > 0) {
                div.appendChild(thumbStrip);
            }
        }

        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = [
            session.taskStatus ? 'Status: ' + session.taskStatus : null,
            typeof session.turnCount === 'number' ? 'Turns: ' + session.turnCount : null,
            session.latestSummary || null,
        ].filter(Boolean).join(' | ');
        if (meta.textContent) {
            div.appendChild(meta);
        }

        const actions = document.createElement('div');
        actions.className = 'session-actions';

        const viewButton = document.createElement('button');
        viewButton.type = 'button';
        viewButton.className = 'session-action-button';
        viewButton.textContent = 'View';
        viewButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            setHistoryRestoreLoading(true, 'Loading saved turn...');
            sendToHost({ type: 'loadSession', sessionId: session.id }, 'session item');
            showView('chat-view');
        });

        const resumeButton = document.createElement('button');
        resumeButton.type = 'button';
        resumeButton.className = 'session-action-button';
        resumeButton.textContent = 'Resume';
        resumeButton.disabled = !session.taskId;
        resumeButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!session.taskId) {
                return;
            }
            setHistoryRestoreLoading(true, 'Restoring task context...');
            sendToHost({ type: 'resumeTask', taskId: session.taskId, sessionId: session.id }, 'resume task');
            showView('chat-view');
        });

        const renameButton = document.createElement('button');
        renameButton.type = 'button';
        renameButton.className = 'session-action-button session-action-icon';
        renameButton.title = 'Rename';
        renameButton.textContent = '✏️';
        renameButton.disabled = !session.taskId;
        renameButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!session.taskId) { return; }
            const currentTitle = session.taskTitle || session.prompt || '';
            const newTitle = prompt('Rename task:', currentTitle);
            if (newTitle !== null && newTitle.trim()) {
                sendToHost({ type: 'renameTask', taskId: session.taskId, newTitle: newTitle.trim() }, 'rename task');
            }
        });

        const pinButton = document.createElement('button');
        pinButton.type = 'button';
        pinButton.className = 'session-action-button session-action-icon';
        pinButton.title = session.pinned ? 'Unpin' : 'Pin';
        pinButton.textContent = '📌';
        pinButton.disabled = !session.taskId;
        pinButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!session.taskId) { return; }
            sendToHost({ type: 'pinTask', taskId: session.taskId }, 'pin task');
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'session-action-button session-action-icon session-action-danger';
        deleteButton.title = 'Delete';
        deleteButton.textContent = '🗑️';
        deleteButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            sendToHost({ type: 'deleteTask', taskId: session.taskId, sessionId: session.id }, 'delete task');
        });

        actions.appendChild(viewButton);
        actions.appendChild(resumeButton);
        actions.appendChild(renameButton);
        actions.appendChild(pinButton);
        actions.appendChild(deleteButton);

        // Show workspace badge if session is from a different workspace
        if (message.showAllWorkspaces && session.workspacePath && session.workspacePath !== message.currentWorkspacePath) {
            const wsLabel = document.createElement('div');
            wsLabel.className = 'session-workspace-label';
            const workspaceName = session.workspacePath.split(/[\\/]/).pop() || session.workspacePath;
            wsLabel.textContent = workspaceName;
            wsLabel.title = session.workspacePath;
            div.appendChild(wsLabel);
        }

        div.appendChild(actions);

        div.addEventListener('dblclick', () => {
            setHistoryRestoreLoading(true, 'Loading saved turn...');
            sendToHost({ type: 'loadSession', sessionId: session.id }, 'session item dblclick');
            showView('chat-view');
        });
        sessionsPanel.appendChild(div);
    });
}

function renderRestoredSession(session) {
    const userDiv = document.createElement('div');
    userDiv.className = 'message user';
    if (session.turnSequence) {
        userDiv.dataset.sequence = String(session.turnSequence);
    }
    if (session.prompt) {
        const promptNode = document.createElement('div');
        promptNode.textContent = session.prompt;
        userDiv.appendChild(promptNode);
    }
    if (Array.isArray(session.attachments) && session.attachments.length > 0) {
        const attachmentsWrap = document.createElement('div');
        attachmentsWrap.innerHTML = renderSessionAttachmentsHtml(session.attachments);
        if (attachmentsWrap.firstElementChild) {
            userDiv.appendChild(attachmentsWrap.firstElementChild);
        }
    }
    if (session.turnSequence && session.prompt) {
        attachRefButton(userDiv, session.turnSequence, session.prompt);
    }
    attachReferencedTurnsIndicator(userDiv, session.referencedTurnSequences);
    chatHistory.appendChild(userDiv);

    const msgDiv = document.createElement('div');
    msgDiv.className = 'message agent';
    msgDiv.style.background = 'transparent';
    msgDiv.style.border = 'none';
    msgDiv.style.padding = '0';

    const planners = [];
    const executors = [];

    session.responses.forEach(response => {
        if (isExecutorResponse(response)) {
            executors.push(response);
        } else {
            planners.push(response);
        }
    });

    let html = '';

    function buildGroupHtml(phaseKind, items, isOpen) {
        if (items.length === 0) return '';
        const phase = getPhasePresentation(phaseKind, 'done', true);
        let groupHtml = '<details class="council-details"' + (isOpen ? ' open' : '') + '>';
        groupHtml += '<summary class="council-summary">' + phase.icon + ' ' + phase.title + '</summary>';
        groupHtml += '<div class="council-container">';

        items.forEach(response => {
            const isError = response.status === 'error';
            const isRunning = response.status === 'running';
            const icon = response.status === 'success' ? '✅' : response.status === 'error' ? '❌' : '⏳';
            const statusMeta = getRestoredAgentStatusMeta(response.status, session.failureReason);
            const cleanName = response.agent;
            
            // Helper to escape prompt to put in quotes if needed, or we just render DOM nodes instead of a giant string?
            // Actually it's easier to just build it as a string but we need to escape HTML in the prompt.
            const escapeHtml = (unsafe) => escapeHtmlText(unsafe);

            let content = '';
            if (response.prompt) {
                content += '<div class="agent-child-stack" style="margin-bottom: 8px;">';
                if (statusMeta.note) {
                    content += '<div class="restored-agent-note">' + escapeHtml(statusMeta.note) + '</div>';
                }
                content += '<details style="margin-bottom: 8px;"><summary style="cursor: pointer; outline: none; font-weight: bold;">📥 Input Prompt & Setup</summary>';
                if (response.debug) {
                    const debugText = `Command: ${response.debug.command || 'N/A'}\nCWD: ${response.debug.cwd || 'N/A'}\nPID: ${response.debug.pid || 'N/A'}`;
                    content += '<pre style="white-space: pre-wrap; word-break: break-all; overflow-x: auto; max-width: 100%; box-sizing: border-box; background-color: var(--vscode-editor-background); padding: 8px; border-radius: 4px; margin-bottom: 8px; font-size: 0.9em; opacity: 0.8;">' + escapeHtml(debugText) + '</pre>';
                }
                content += '<pre style="white-space: pre-wrap; word-break: break-all; overflow-x: auto; max-width: 100%; box-sizing: border-box; background-color: var(--vscode-editor-background); padding: 8px; border-radius: 4px;">' + escapeHtml(response.prompt) + '</pre>';
                content += '</details>';
                
                if (response.thinkingHtml) {
                    var stepCount = extractProcessEntries(response.thinking || '').length;
                    content += '<details style="margin-bottom: 8px;"><summary style="cursor: pointer; outline: none; font-weight: bold;">⚙️ Execution Trace' + (stepCount > 0 ? ' (' + stepCount + ' steps)' : '') + '</summary>';
                    content += renderProcessHtml(response.thinkingHtml, response.thinking || '', true);
                    content += '</details>';
                }

                if (response.usageLog) {
                    content += '<details style="margin-bottom: 8px;"><summary style="cursor: pointer; outline: none; font-weight: bold;">📊 Usage Log</summary>';
                    content += renderUsageLogHtml(response.usageLog);
                    content += '</details>';
                }
                
                content += '<details open><summary style="cursor: pointer; outline: none; font-weight: bold;">📤 Output' + (isRunning ? ' (Partial)' : '') + '</summary>';
                content += response.raw
                    ? '<pre class="' + (isError ? 'error-text' : '') + '">' + response.parsedText + '</pre>'
                    : '<div class="markdown-body">' + response.parsedText + '</div>';
                content += '</details>';
                content += '</div>';
            } else {
                content = (statusMeta.note
                    ? '<div class="restored-agent-note">' + escapeHtml(statusMeta.note) + '</div>'
                    : '')
                    + (response.raw
                        ? '<pre class="' + (isError ? 'error-text' : '') + '">' + response.parsedText + '</pre>'
                        : '<div class="markdown-body">' + response.parsedText + '</div>');
            }

            groupHtml += '<details open class="agent-row' + (isRunning ? ' thinking' : '') + '"' + (isError ? ' data-has-error="true"' : '') + '>';
            groupHtml += '<summary class="task-item" style="cursor: pointer; outline: none; user-select: none;">';
            groupHtml += '<span class="task-icon">' + icon + '</span> ' + renderAgentLabel(cleanName, response.agentId, response.role);
            groupHtml += '<span class="' + statusMeta.badgeClass + '">' + escapeHtml(statusMeta.label) + '</span>';
            groupHtml += '</summary>';
            groupHtml += '<div class="agent-content" style="display:block;">' + content + '</div>';
            groupHtml += '</details>';
        });

        groupHtml += '</div></details>';
        return groupHtml;
    }

    html += buildGroupHtml('planner', planners, false);
    html += buildGroupHtml('executor', executors, true);

    msgDiv.innerHTML = html;
    chatHistory.appendChild(msgDiv);
    scrollChat();
}

let currentCouncilAutoCollapse = false;

function setRunningState(running) {
    if (running) {
        askBtn.style.display = 'none';
        compactBtn.style.display = 'none';
        stopBtn.style.display = '';
        if (queueBtn) { queueBtn.style.display = ''; }
        updateQueueBadge();
    } else {
        stopBtn.style.display = 'none';
        // If queue still has items and auto-dequeue is active, keep queue button visible
        // to prevent the send button from appearing during the auto-dequeue gap.
        if (pendingQueue.length > 0 && !queuePaused) {
            if (queueBtn) { queueBtn.style.display = ''; }
            askBtn.style.display = 'none';
            compactBtn.style.display = 'none';
            updateQueueBadge();
        } else {
            if (queueBtn) { queueBtn.style.display = 'none'; }
            compactBtn.style.display = '';
            askBtn.style.display = '';
            queuePanelOpen = false;
            var panel = document.getElementById('queue-panel');
            if (panel) { panel.style.display = 'none'; }
            var viewBtn = document.getElementById('queue-view-btn');
            if (viewBtn) { viewBtn.style.display = 'none'; }
        }
    }
}

function renderCouncilStart(message) {
    setRunningState(true);
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message agent';
    msgDiv.style.background = 'transparent';
    msgDiv.style.border = 'none';
    msgDiv.style.padding = '0';

    const ts = Date.now();
    const phase = getPhasePresentation(message.phaseKind, 'running', false);
    const donePhase = getPhasePresentation(message.phaseKind, 'done', false);
    const startLabel = phase.title;
    currentCouncilHeader = 'council-status-' + ts;
    currentCouncilDoneTitle = donePhase.title;
    currentCouncilAutoCollapse = message.autoCollapseOnSuccess === true;
    currentCouncilAgentDomIds = new Map();
    
    let html = '<details class="council-details">';
    html += '<summary class="council-summary" id="' + currentCouncilHeader + '">⏳ ' + startLabel + '</summary>';
    html += '<div class="council-container">';

    message.agents.forEach((agentEntry, index) => {
        const agentName = typeof agentEntry === 'string' ? agentEntry : agentEntry.name;
        const agentId = typeof agentEntry === 'string' ? '' : agentEntry.id;
        const agentRole = typeof agentEntry === 'string' ? '' : (agentEntry.role || '');
        const safeId = 'council-' + ts + '-' + index + '-' + fallbackAgentDomId(agentName);
        currentCouncilAgentDomIds.set(agentName, safeId);
        const escapeHtml = (s) => s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
        let promptHtml = '<div class="agent-child-stack">';
        if (message.prompt) {
            promptHtml += '<details style="margin-bottom:8px;"><summary style="cursor:pointer;outline:none;font-weight:bold;">📥 Input Prompt & Setup</summary>'
                + '<pre style="white-space:pre-wrap;word-break:break-all;overflow-x:auto;max-width:100%;box-sizing:border-box;background-color:var(--vscode-editor-background);padding:8px;border-radius:4px;">' + escapeHtml(message.prompt) + '</pre>'
                + '</details>';
        }
        promptHtml += '<details open style="margin-bottom:8px;"><summary style="cursor:pointer;outline:none;font-weight:bold;">📤 Output</summary>'
            + '<div id="stream-output-' + safeId + '" class="markdown-body"></div>'
            + '</details>'
            + '<details style="margin-bottom:8px;"><summary style="cursor:pointer;outline:none;font-weight:bold;">⚙️ Execution Trace</summary>'
            + '<div id="stream-thinking-wrap-' + safeId + '" class="markdown-body" style="opacity:0.9;border-left:3px solid var(--vscode-editorBracketHighlight-foreground1, #ccc);padding-left:8px;min-height:20px;">'
            + '<div id="stream-thinking-' + safeId + '"></div>'
            + '</div>'
            + '</details>'
            + '</div>';
        html += '<details open class="agent-row"><summary id="task-' + safeId + '" class="task-item thinking" data-agent-meta-rendered="true" style="cursor: pointer; outline: none; user-select: none;"><span class="task-icon">⏳</span> ' + renderAgentLabel(agentName, agentId, agentRole) + '</summary>'
            + '<div id="debug-' + safeId + '" class="debug-panel' + (debugMode ? ' visible' : '') + '"></div>'
            + '<div id="content-' + safeId + '" class="agent-content" style="display:' + (promptHtml ? 'block' : 'none') + ';">' + promptHtml + '</div>'
            + '</details>';
    });

    html += '</div></details>';
    msgDiv.innerHTML = html;
    chatHistory.appendChild(msgDiv);
    scrollChat();
}

function renderAgentUpdate(message) {
    const safeId = resolveAgentDomId(message.agent);
    const contentEl = document.getElementById('content-' + safeId);
    if (!contentEl) {
        return;
    }

    contentEl.style.display = 'block';

    const thinkingSlot = document.getElementById('stream-thinking-' + safeId);
    const outputSlot = document.getElementById('stream-output-' + safeId);

    if (thinkingSlot) {
        thinkingSlot.innerHTML = renderProcessHtml(message.thinkingHtml || '', message.thinkingText || '');
    }
    if (outputSlot) {
        outputSlot.innerHTML = message.outputHtml || '';
        // Auto-collapse Execution Trace when output content arrives
        if (message.outputHtml) {
            const thinkingWrap = document.getElementById('stream-thinking-wrap-' + safeId);
            if (thinkingWrap) {
                const processDetails = thinkingWrap.closest('details');
                if (processDetails && processDetails.open) {
                    processDetails.open = false;
                }
            }
        }
    }

    if (!thinkingSlot && !outputSlot) {
        contentEl.innerHTML = message.outputHtml || message.thinkingHtml || message.text || '';
    }
    contentEl.scrollTop = contentEl.scrollHeight;
}

function extractCodeBlocks(rawText) {
    // Match fenced code blocks with an optional filename in the info string
    // e.g. ```typescript src/foo/bar.ts or ```python path/to/file.py
    const blocks = [];
    const fence = /^```[^\n]*?([^\s`]+\.[a-zA-Z0-9]+)[^\n]*\n([\s\S]*?)^```/gm;
    let match;
    while ((match = fence.exec(rawText)) !== null) {
        blocks.push({ filePath: match[1], code: match[2] });
    }
    return blocks;
}

function injectApplyButtons(contentEl, rawText) {
    if (!rawText) { return; }
    const blocks = extractCodeBlocks(rawText);
    if (blocks.length === 0) { return; }

    const preEls = contentEl.querySelectorAll('pre');
    blocks.forEach((block, i) => {
        const pre = preEls[i];
        if (!pre) { return; }

        const btn = document.createElement('button');
        btn.className = 'apply-btn';
        btn.textContent = 'Apply to ' + block.filePath;
        btn.dataset.filePath = block.filePath;
        btn.dataset.code = block.code;
        btn.addEventListener('click', () => {
            btn.disabled = true;
            btn.textContent = 'Applying…';
            sendToHost({ type: 'applyCodeBlock', filePath: block.filePath, code: block.code }, 'apply-code-block');
        });
        pre.parentNode.insertBefore(btn, pre);
    });
}

function renderAgentDone(message) {
    const safeId = resolveAgentDomId(message.agent);
    const taskEl = document.getElementById('task-' + safeId);
    const contentEl = document.getElementById('content-' + safeId);

    if (!taskEl || !contentEl) {
        if (message.raw) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'message agent';
            msgDiv.innerHTML = '<div class="agent-name">' + message.agent + '</div><p style="color: var(--vscode-errorForeground)">' + message.text + '</p>';
            chatHistory.appendChild(msgDiv);
            scrollChat();
        }
        return;
    }
        taskEl.classList.remove('thinking');
        taskEl.querySelector('.task-icon').textContent = message.status === 'success' ? '✅' : '❌';
        const taskNameEl = taskEl.querySelector('.task-name');
        if (taskNameEl && !taskEl.dataset.agentMetaRendered) {
            const roleBadge = message.role
                ? '<span style="margin-left:8px; font-size:10px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 6px; text-transform: uppercase; letter-spacing: 0.03em;">' + escapeHtmlText(message.role) + '</span>'
                : '';
            const idBadge = message.agentId
                ? '<span style="margin-left:8px; font-size:11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);">[' + escapeHtmlText(message.agentId) + ']</span>'
                : '';
            taskNameEl.insertAdjacentHTML('afterend', roleBadge + idBadge);
            taskEl.dataset.agentMetaRendered = 'true';
        }
        
        if (message.status === 'error') {
            taskEl.closest('details').dataset.hasError = 'true';
        }

        if (message.prompt) {
            const wrapper = document.createElement('div');
            wrapper.className = 'agent-child-stack';
            
            const promptDetails = document.createElement('details');
            promptDetails.style.marginBottom = '8px';
            const promptSummary = document.createElement('summary');
            promptSummary.textContent = '📥 Input Prompt & Setup';
            promptSummary.style.cursor = 'pointer';
            promptSummary.style.outline = 'none';
            promptSummary.style.fontWeight = 'bold';
            promptDetails.appendChild(promptSummary);

            if (message.debug) {
                const debugWrap = document.createElement('div');
                debugWrap.innerHTML = renderDebugDetailsHtml({ ...(message.debug || {}), role: message.role });
                promptDetails.appendChild(debugWrap.firstElementChild);
            }

            const promptPre = document.createElement('pre');
            promptPre.textContent = message.prompt;
            promptPre.style.whiteSpace = 'pre-wrap';
            promptPre.style.wordBreak = 'break-all';
            promptPre.style.overflowX = 'auto';
            promptPre.style.maxWidth = '100%';
            promptPre.style.boxSizing = 'border-box';
            promptPre.style.backgroundColor = 'var(--vscode-editor-background)';
            promptPre.style.padding = '8px';
            promptPre.style.borderRadius = '4px';
            promptDetails.appendChild(promptPre);

            wrapper.appendChild(promptDetails);

            // Output section FIRST (always visible, expanded by default)
            const outputDetails = document.createElement('details');
            outputDetails.open = true;
            const outputSummary = document.createElement('summary');
            outputSummary.textContent = '📤 Output';
            outputSummary.style.cursor = 'pointer';
            outputSummary.style.outline = 'none';
            outputSummary.style.fontWeight = 'bold';
            outputDetails.appendChild(outputSummary);

            if (message.raw) {
                const pre = document.createElement('pre');
                if (message.status === 'error') {
                    pre.className = 'error-text';
                }
                pre.textContent = message.text || message.rawText;
                outputDetails.appendChild(pre);
            } else {
                const mdDiv = document.createElement('div');
                mdDiv.className = 'markdown-body';
                mdDiv.innerHTML = message.text;
                outputDetails.appendChild(mdDiv);
                if (message.rawText) {
                    injectApplyButtons(mdDiv, message.rawText);
                }
            }

            wrapper.appendChild(outputDetails);

            // Execution Trace section (collapsed by default, below output)
            if (message.thinkingHtml) {
                const processDetails = document.createElement('details');
                processDetails.style.marginBottom = '8px';
                const processSummary = document.createElement('summary');
                const stepCount = extractProcessEntries(message.thinking || '').length;
                processSummary.textContent = stepCount > 0
                    ? '⚙️ Execution Trace (' + stepCount + ' steps)'
                    : '⚙️ Execution Trace';
                processSummary.style.cursor = 'pointer';
                processSummary.style.outline = 'none';
                processSummary.style.fontWeight = 'bold';
                processDetails.appendChild(processSummary);

                const thinkingDiv = document.createElement('div');
                thinkingDiv.innerHTML = renderProcessHtml(message.thinkingHtml || '', message.thinking || '', true);
                processDetails.appendChild(thinkingDiv);

                wrapper.appendChild(processDetails);
            }

            if (message.usageLog) {
                const logDetails = document.createElement('details');
                logDetails.style.marginBottom = '8px';
                const logSummary = document.createElement('summary');
                logSummary.textContent = '📊 Usage Log';
                logSummary.style.cursor = 'pointer';
                logSummary.style.outline = 'none';
                logSummary.style.fontWeight = 'bold';
                logDetails.appendChild(logSummary);

                const logContainer = document.createElement('div');
                logContainer.innerHTML = renderUsageLogHtml(message.usageLog);
                logDetails.appendChild(logContainer);

                wrapper.appendChild(logDetails);
            }

            contentEl.replaceChildren(wrapper);
            
        } else {
            if (message.raw) {
                const pre = document.createElement('pre');
                if (message.status === 'error') {
                    pre.className = 'error-text';
                }
                pre.textContent = message.text || message.rawText;
                contentEl.replaceChildren(pre);
            } else {
                const mdDiv = document.createElement('div');
                mdDiv.className = 'markdown-body';
                mdDiv.innerHTML = message.text;
                contentEl.replaceChildren(mdDiv);
                if (message.rawText) {
                    injectApplyButtons(mdDiv, message.rawText);
                }
            }
        }

        contentEl.style.display = 'block';

    scrollChat();
}

function renderAgentDebug(message) {
    const safeId = resolveAgentDomId(message.agent);
    const debugEl = document.getElementById('debug-' + safeId);
    if (!debugEl) {
        return;
    }
    debugEl.innerHTML = renderDebugDetailsHtml(message);
}

function renderCouncilComplete() {
    setRunningState(false);
    if (!currentCouncilHeader) {
        return;
    }

    const headerEl = document.getElementById(currentCouncilHeader);
    if (headerEl) {
        headerEl.textContent = '✅ ' + currentCouncilDoneTitle;
        const detailsEl = headerEl.closest('details');
        if (detailsEl && detailsEl.dataset.hasError !== 'true' && currentCouncilAutoCollapse) {
            detailsEl.open = false;
        }
    }
}

try {
    applyDebugMode(debugMode);

    bindAgentSelectionLimit();
    bindPromptKeyboardShortcut();
    bindPasteHandler();
    bindButtonAction(configBtn, 'config-btn');
    bindButtonAction(document.getElementById('new-chat-btn'), 'new-chat-btn');
    bindButtonAction(toggleBtn, 'toggle-sessions-btn');
    bindButtonAction(backToChatBtn, 'back-to-chat-btn');
    if (workspaceToggleBtn) {
        workspaceToggleBtn.addEventListener('click', () => {
            sendToHost({ type: 'toggleShowAllWorkspaces' }, 'toggle workspace filter');
        });
    }
    bindButtonAction(document.getElementById('stop-btn'), 'stop-btn');
    bindButtonAction(document.getElementById('compact-btn'), 'compact-btn');
    bindButtonAction(document.getElementById('queue-btn'), 'queue-btn');
    bindButtonAction(askBtn, 'ask-btn');

    // Queue panel: toggle via dedicated view button, close on X
    var queueViewBtn = document.getElementById('queue-view-btn');
    if (queueViewBtn) {
        queueViewBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            queuePanelOpen = !queuePanelOpen;
            renderQueuePanel();
        });
    }
    var queuePanelClose = document.getElementById('queue-panel-close');
    if (queuePanelClose) {
        queuePanelClose.addEventListener('click', function() {
            queuePanelOpen = false;
            var panel = document.getElementById('queue-panel');
            if (panel) { panel.style.display = 'none'; }
        });
    }

    document.addEventListener('click', event => {
        const actionId = getActionIdFromEvent(event);
        if (!actionId) {
            return;
        }

        event.preventDefault();
        handleButtonAction(actionId);
    }, true);

    document.addEventListener('pointerup', event => {
        const actionId = getActionIdFromEvent(event);
        if (!actionId) {
            return;
        }

        event.preventDefault();
        handleButtonAction(actionId);
    }, true);

    // --- Floating collapse button for off-screen expanded sections ---
    const floatingBar = document.createElement('div');
    floatingBar.id = 'floating-collapse-bar';
    floatingBar.style.display = 'none';
    chatView.insertBefore(floatingBar, chatHistory);

    function updateFloatingCollapseBar() {
        const openSections = chatHistory.querySelectorAll('.agent-child-stack > details[open]');
        const items = [];
        openSections.forEach(details => {
            const summary = details.querySelector(':scope > summary');
            if (!summary) return;
            const rect = summary.getBoundingClientRect();
            // Summary scrolled above viewport
            if (rect.bottom < 0) {
                items.push({ details, text: summary.textContent.trim() });
            }
        });
        if (items.length === 0) {
            floatingBar.style.display = 'none';
            return;
        }
        floatingBar.style.display = 'flex';
        floatingBar.innerHTML = '';
        // Only show the last (most recently scrolled off-screen) section
        const item = items[items.length - 1];
        const btn = document.createElement('button');
        btn.className = 'floating-collapse-btn';
        btn.textContent = '▲ ' + item.text;
        btn.addEventListener('click', () => {
            item.details.open = false;
            updateFloatingCollapseBar();
        });
        floatingBar.appendChild(btn);
    }

    var _floatingBarRafScheduled = false;
    function throttledUpdateFloatingCollapseBar() {
        if (_floatingBarRafScheduled) { return; }
        _floatingBarRafScheduled = true;
        requestAnimationFrame(function () {
            _floatingBarRafScheduled = false;
            updateFloatingCollapseBar();
        });
    }
    chatHistory.addEventListener('scroll', throttledUpdateFloatingCollapseBar, { passive: true });
    // Also update when details toggle
    chatHistory.addEventListener('toggle', e => {
        if (e.target && e.target.tagName === 'DETAILS') {
            updateFloatingCollapseBar();
        }
    }, true);

    window.addEventListener('message', event => {
        const message = event.data;

        if (message.type === 'updateContextBadge') {
            renderContextBadge(message);
            return;
        }

        if (message.type === 'updateAgentSelector') {
            agentSelector.innerHTML = '';
            executorSelector.innerHTML = '';
            let idx = 0;
            message.agents.forEach(agent => {
                if (agent.modes && agent.modes.indexOf('plan') !== -1) {
                    const label = document.createElement('label');
                    label.className = 'agent-pill';

                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.className = 'agent-checkbox';
                    input.value = agent.id;
                    input.checked = idx < 3;
                    idx += 1;

                    const text = document.createElement('span');
                    text.textContent = agent.name;

                    label.appendChild(input);
                    label.appendChild(text);
                    agentSelector.appendChild(label);
                }

                if (agent.modes && agent.modes.indexOf('agent') !== -1) {
                    const option = document.createElement('option');
                    option.value = agent.id;
                    option.textContent = agent.name;
                    executorSelector.appendChild(option);
                }
            });
            bindAgentSelectionLimit();
            return;
        }

        if (message.type === 'updateUiState') {
            applyDebugMode(!!message.debugMode);
            return;
        }

        if (message.type === 'updateTaskState') {
            if (message.task && Array.isArray(message.task.turnHistory)) {
                currentTaskTurnHistory = message.task.turnHistory;
            } else {
                currentTaskTurnHistory = [];
            }
            renderTaskState(message);
            updateTokenCounter(message.task);
            return;
        }

        if (message.type === 'compactResult') {
            var freedTokens = message.tokensFreed || 0;
            var freedLabel = freedTokens >= 1000 ? Math.round(freedTokens / 1000) + 'k' : String(freedTokens);
            var afterLabel = (message.tokensAfter || 0) >= 1000 ? Math.round((message.tokensAfter || 0) / 1000) + 'k' : String(message.tokensAfter || 0);
            var triggerLabel = message.trigger === 'auto' ? 'auto' : 'manual';

            var compactDiv = document.createElement('div');
            compactDiv.style.cssText = 'margin: 12px 0; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-inactiveSelectionBackground);';

            var headerLine = document.createElement('div');
            headerLine.style.cssText = 'font-size: 12px; color: var(--vscode-descriptionForeground); font-style: italic;';
            headerLine.textContent = 'Compacted chat \xB7 ' + triggerLabel + ' \xB7 ' + freedLabel + ' tokens freed \u2191';
            compactDiv.appendChild(headerLine);

            var descLine = document.createElement('div');
            descLine.style.cssText = 'font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;';
            descLine.textContent = 'Conversation was compacted to free up context. Current context: ~' + afterLabel + ' tokens.';
            compactDiv.appendChild(descLine);

            chatHistory.appendChild(compactDiv);
            scrollChat();

            // Force-update the token counter from compactResult data
            // to avoid stale display if updateTaskState arrived with old values
            var counter = document.getElementById('context-token-counter');
            if (counter && message.tokensAfter !== undefined) {
                var tokens = message.tokensAfter;
                var cLabel = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
                counter.textContent = '\uD83D\uDCCA ' + cLabel + ' tokens';
                counter.style.display = '';
                counter.style.color = 'var(--vscode-descriptionForeground)';
                counter.title = 'Estimated context token count';
            }
            return;
        }

        if (message.type === 'updateSessionsList') {
            renderSessionHistory(message);
            return;
        }

        if (message.type === 'restoreSession') {
            historyRestoreLoading = false;
            chatHistory.innerHTML = '';
            renderRestoredSession(message.session);
            return;
        }

        if (message.type === 'restoreTaskSessions') {
            historyRestoreLoading = false;
            chatHistory.innerHTML = '';
            message.sessions.forEach(session => renderRestoredSession(session));
            // Scroll directly to the latest turn on resume
            requestAnimationFrame(function () {
                chatHistory.scrollTop = chatHistory.scrollHeight;
            });
            return;
        }

        if (message.type === 'startCouncil') {
            renderCouncilStart(message);
            return;
        }

        if (message.type === 'agentUpdate') {
            renderAgentUpdate(message);
            return;
        }

        if (message.type === 'agentDone') {
            renderAgentDone(message);
            return;
        }

        if (message.type === 'agentDebug') {
            renderAgentDebug(message);
            return;
        }

        if (message.type === 'councilComplete') {
            renderCouncilComplete();
        }

        if (message.type === 'modeInferred') {
            const modeLabels = { plan: 'Plan', auto: 'Auto', direct: 'Exec' };
            const label = modeLabels[message.inferredMode] || message.inferredMode;
            const indicator = document.createElement('div');
            indicator.className = 'message system-note';
            indicator.style.cssText = 'text-align:center;background:none;color:var(--vscode-descriptionForeground);font-size:11px;padding:2px 0;';
            indicator.textContent = '\u26A1 Auto-routed to ' + label + ' mode';
            chatHistory.appendChild(indicator);
            scrollChat();
        }

        if (message.type === 'intentDowngrade') {
            const indicator = document.createElement('div');
            indicator.className = 'message system-note';
            indicator.style.cssText = 'text-align:center;background:none;color:var(--vscode-descriptionForeground);font-size:11px;padding:2px 0;';
            indicator.textContent = '\u2139\uFE0F Planners detected question intent \u2014 skipping executor';
            chatHistory.appendChild(indicator);
            scrollChat();
        }

        if (message.type === 'intentSkip') {
            const indicator = document.createElement('div');
            indicator.className = 'message system-note';
            indicator.style.cssText = 'text-align:center;background:none;color:var(--vscode-descriptionForeground);font-size:11px;padding:2px 0;';
            indicator.textContent = '\u26A1 Simple task detected \u2014 fast-tracking to executor';
            chatHistory.appendChild(indicator);
            scrollChat();
        }

        if (message.type === 'intentUpgrade') {
            const indicator = document.createElement('div');
            indicator.className = 'message system-note';
            indicator.style.cssText = 'text-align:center;background:none;color:var(--vscode-descriptionForeground);font-size:11px;padding:2px 0;';
            const fromMode = message.originalMode || 'inferred';
            indicator.textContent = '\u2B06\uFE0F Planner override: ' + fromMode + ' \u2192 auto (complex task detected)';
            chatHistory.appendChild(indicator);
            scrollChat();
        }

        if (message.type === 'turnComplete') {
            setRunningState(false);
            // Auto-dequeue: only process queued prompts after the entire turn
            // (including executor) has finished and _runningTaskIds is cleared.
            if (pendingQueue.length > 0 && !queuePaused) {
                const next = pendingQueue.shift();
                updateQueueBadge();
                setTimeout(function() { submitFromQueue(next); }, 300);
            } else if (pendingQueue.length > 0 && queuePaused) {
            }
        }

        if (message.type === 'codeBlockApplied') {
            // Mark all buttons for this file as applied
            document.querySelectorAll('.apply-btn').forEach(btn => {
                if (btn.dataset.filePath === message.filePath) {
                    btn.textContent = 'Applied \u2713';
                    btn.classList.add('apply-btn-done');
                }
            });
        }

    });

    sendToHost({ type: 'webviewReady' }, 'startup');

    // Mode selector button group
    document.querySelectorAll('.mode-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            submitMode = btn.dataset.mode || 'auto';
        });
    });

    setTimeout(() => {
        if (agentSelector.childElementCount === 0) {
            sendToHost({ type: 'requestAgents' }, 'startup fallback');
        }
    }, 2000);
} catch (error) {
    console.error('Webview boot failure', error);
}
