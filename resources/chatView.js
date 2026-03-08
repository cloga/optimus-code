const vscode = acquireVsCodeApi();
const diagnosticLog = document.getElementById('diagnostic-log');
const diagnosticStatus = document.getElementById('diagnostic-status');
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
const configBtn = document.getElementById('config-btn');
const agentSelector = document.getElementById('agent-selector');
const executorSelector = document.getElementById('executor-selector');
const diagnosticPanel = document.getElementById('diagnostic-panel');
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
let historyListLoading = false;
let historyRestoreLoading = false;

function getPhasePresentation(phaseKind, state, restored) {
    const normalizedKind = phaseKind === 'executor' ? 'executor' : 'planner';
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
    if (response && response.role === 'executor') {
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
        .map(line => line.trim())
        .filter(line => line && line !== '---');
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
            detailTarget = 'meta';
            return;
        }

        const completionMatch = /^([✓✗])\s*(.+)$/.exec(line);
        if (completionMatch) {
            const status = completionMatch[1] === '✓' ? 'success' : 'error';
            const title = completionMatch[2].trim() || 'Tool';

            if (currentTool && currentTool.title === title) {
                currentTool.status = status;
                detailTarget = 'result';
                return;
            }

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

function renderProcessHtml(thinkingHtml, thinkingText) {
    if (!thinkingHtml && !thinkingText) {
        return '';
    }

    const steps = extractProcessEntries(thinkingText);
    const notes = extractProcessNotes(thinkingText);

    if (steps.length === 0) {
        return '<div class="markdown-body process-markdown-fallback">' + (thinkingHtml || '') + '</div>';
    }

    let html = '<div class="process-timeline">';
    steps.forEach((step, index) => {
        html += renderProcessStepHtml(step, index);
    });
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

function setDiagnosticStatus(status, text) {
    if (!diagnosticStatus) {
        return;
    }

    diagnosticStatus.className = 'diagnostic-status ' + status;
    diagnosticStatus.textContent = text;
}

function addDiagnosticLine(message, replaceInitial) {
    if (!diagnosticLog) {
        return;
    }

    if (replaceInitial && diagnosticLog.textContent === 'Waiting for script boot...') {
        diagnosticLog.textContent = '';
    }

    const line = document.createElement('div');
    line.className = 'diagnostic-line';
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    diagnosticLog.appendChild(line);

    while (diagnosticLog.childElementCount > 30) {
        diagnosticLog.removeChild(diagnosticLog.firstChild);
    }

    diagnosticLog.scrollTop = diagnosticLog.scrollHeight;
}

function showBootFailure(error) {
    setDiagnosticStatus('failed', 'FAILED');
    if (diagnosticLog) {
        diagnosticLog.textContent = 'Boot failure: ' + (error && error.message ? error.message : String(error));
    }
}

function applyDebugMode(enabled) {
    debugMode = enabled;

    if (diagnosticPanel) {
        diagnosticPanel.classList.toggle('visible', enabled);
    }

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
    addDiagnosticLine('postMessage -> ' + payload.type + (reason ? ' | ' + reason : ''), true);
    vscode.postMessage(payload);
}

function showView(viewId) {
    chatView.classList.remove('active');
    sessionsView.classList.remove('active');
    document.getElementById(viewId).classList.add('active');
    if (viewId === 'sessions-view' && !historyListLoading) {
        setSessionsLoading(true, 'Loading history...');
    }
    addDiagnosticLine('showView -> ' + viewId, true);
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

function scrollChat() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
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
        addDiagnosticLine('prompt keydown -> submit via Enter', true);
        submitPrompt();
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
                addDiagnosticLine('paste image | type=' + item.type, true);
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
    const text = promptInput.value;
    addDiagnosticLine('submitPrompt invoked | length=' + text.length, true);
    if (!text.trim() && pendingImages.length === 0) {
        addDiagnosticLine('submitPrompt aborted | empty input', true);
        return;
    }

    const selectedAgents = getSelectedAgents();
    if (selectedAgents.length === 0) {
        addDiagnosticLine('submitPrompt aborted | no selected agents', true);
        return;
    }

    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
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
    scrollChat();

    const executor = executorSelector.value;
    const images = pendingImages.length > 0 ? pendingImages.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType })) : undefined;
    sendToHost({ type: 'askCouncil', value: text, agents: selectedAgents, mode: 'auto', executor: executor, images }, 'submitPrompt');
    promptInput.value = '';
    clearPendingImages();
}

function submitCompact() {
    addDiagnosticLine('submitCompact invoked (real compact)', true);

    const compactMsg = document.createElement('div');
    compactMsg.className = 'message user';
    compactMsg.style.cssText = 'text-align: center; background: none; color: var(--vscode-descriptionForeground); font-size: 11px;';
    compactMsg.textContent = '⚡ Compacting Context...';
    chatHistory.appendChild(compactMsg);
    scrollChat();

    sendToHost({ type: 'compactContext' }, 'submitCompact');
}

function handleButtonAction(actionId) {
    addDiagnosticLine('handleButtonAction -> ' + actionId, true);
    switch (actionId) {
        case 'new-chat-btn':
            chatHistory.innerHTML = '<div class="message agent"><div class="agent-name">Optimus Council</div><p>Welcome! Describe your architecture problem, and I will summon the agents concurrently.</p></div>';
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
        addDiagnosticLine('direct handler -> ' + actionId + ' via ' + event.type, true);
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
        'ask-btn'
    ].includes(node.id));

    return target ? target.id : null;
}

function renderSessionHistory(message) {
    historyListLoading = false;
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

        div.appendChild(titleRow);

        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = [
            session.taskStatus ? 'Status: ' + session.taskStatus : null,
            typeof session.turnCount === 'number' ? 'Turns: ' + session.turnCount : null,
            session.attachmentCount ? 'Images: ' + session.attachmentCount : null,
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
                    content += '<details style="margin-bottom: 8px;"><summary style="cursor: pointer; outline: none; font-weight: bold;">⚙️ Execution Process</summary>';
                    content += renderProcessHtml(response.thinkingHtml, response.thinking || '');
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
    } else {
        stopBtn.style.display = 'none';
        compactBtn.style.display = '';
        askBtn.style.display = '';
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
            + '<details open style="margin-bottom:8px;"><summary style="cursor:pointer;outline:none;font-weight:bold;">⚙️ Execution Process</summary>'
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
        // Auto-collapse Execution Process when output content arrives
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

            // Execution Process section (collapsed by default, below output)
            if (message.thinkingHtml) {
                const processDetails = document.createElement('details');
                processDetails.style.marginBottom = '8px';
                const processSummary = document.createElement('summary');
                const stepCount = extractProcessEntries(message.thinking || '').length;
                processSummary.textContent = stepCount > 0
                    ? '⚙️ Execution Process (' + stepCount + ' steps)'
                    : '⚙️ Execution Process';
                processSummary.style.cursor = 'pointer';
                processSummary.style.outline = 'none';
                processSummary.style.fontWeight = 'bold';
                processDetails.appendChild(processSummary);

                const thinkingDiv = document.createElement('div');
                thinkingDiv.innerHTML = renderProcessHtml(message.thinkingHtml || '', message.thinking || '');
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

    window.addEventListener('error', event => {
        setDiagnosticStatus('failed', 'FAILED');
        addDiagnosticLine('window.error -> ' + event.message, true);
    });

    window.addEventListener('unhandledrejection', event => {
        const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
        setDiagnosticStatus('failed', 'FAILED');
        addDiagnosticLine('unhandledrejection -> ' + reason, true);
    });

    setDiagnosticStatus('running', 'RUNNING');
    addDiagnosticLine('script booted', true);

    bindAgentSelectionLimit();
    bindPromptKeyboardShortcut();
    bindPasteHandler();
    bindButtonAction(configBtn, 'config-btn');
    bindButtonAction(document.getElementById('new-chat-btn'), 'new-chat-btn');
    bindButtonAction(toggleBtn, 'toggle-sessions-btn');
    bindButtonAction(backToChatBtn, 'back-to-chat-btn');
    bindButtonAction(document.getElementById('stop-btn'), 'stop-btn');
    bindButtonAction(document.getElementById('compact-btn'), 'compact-btn');
    bindButtonAction(askBtn, 'ask-btn');

    document.addEventListener('click', event => {
        const actionId = getActionIdFromEvent(event);
        if (!actionId) {
            return;
        }

        event.preventDefault();
        addDiagnosticLine('captured click -> ' + actionId, true);
        handleButtonAction(actionId);
    }, true);

    document.addEventListener('pointerup', event => {
        const actionId = getActionIdFromEvent(event);
        if (!actionId) {
            return;
        }

        event.preventDefault();
        addDiagnosticLine('captured pointerup -> ' + actionId, true);
        handleButtonAction(actionId);
    }, true);

    // --- Floating collapse button for off-screen expanded sections ---
    const floatingBar = document.createElement('div');
    floatingBar.id = 'floating-collapse-bar';
    floatingBar.style.display = 'none';
    document.body.appendChild(floatingBar);

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
        items.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'floating-collapse-btn';
            btn.textContent = '▲ ' + item.text;
            btn.addEventListener('click', () => {
                item.details.open = false;
                updateFloatingCollapseBar();
            });
            floatingBar.appendChild(btn);
        });
    }

    chatHistory.addEventListener('scroll', updateFloatingCollapseBar, { passive: true });
    // Also update when details toggle
    chatHistory.addEventListener('toggle', e => {
        if (e.target && e.target.tagName === 'DETAILS') {
            updateFloatingCollapseBar();
        }
    }, true);

    window.addEventListener('message', event => {
        const message = event.data;
        addDiagnosticLine('host -> ' + message.type, true);

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
            return;
        }

        if (message.type === 'hostDebug') {
            if (debugMode) {
                addDiagnosticLine('hostDebug -> ' + message.messageType + (message.detail ? ' | ' + message.detail : ''), true);
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

        if (message.type === 'codeBlockApplied') {
            // Mark all buttons for this file as applied
            document.querySelectorAll('.apply-btn').forEach(btn => {
                if (btn.dataset.filePath === message.filePath) {
                    btn.textContent = 'Applied ✓';
                    btn.classList.add('apply-btn-done');
                }
            });
        }
    });

    sendToHost({ type: 'webviewReady' }, 'startup');

    setTimeout(() => {
        if (agentSelector.childElementCount === 0) {
            sendToHost({ type: 'requestAgents' }, 'startup fallback');
        }
    }, 2000);
} catch (error) {
    showBootFailure(error);
}
