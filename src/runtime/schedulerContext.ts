import {
    SchedulerAgentRun,
    SchedulerTask,
    SchedulerTaskEvent,
    SchedulerStore,
} from './schedulerStore';

const IMPORTANT_EVENT_TYPES = new Set([
    'task_checkpointed',
    'task_handed_off',
    'master_yielded',
    'task_updated_from_inbox',
    'task_priority_changed_from_inbox',
    'task_paused',
    'task_resumed',
    'task_cancelled_from_inbox',
    'task_reassigned',
]);

export interface SchedulerContextPacket {
    task: SchedulerTask;
    recent_events: SchedulerTaskEvent[];
    agent_runs: SchedulerAgentRun[];
    latest_checkpoint?: Record<string, unknown>;
    latest_handoff?: Record<string, unknown>;
    truncated: boolean;
}

export interface SchedulerContextOptions {
    maxEvents?: number;
    maxChars?: number;
}

export function buildSchedulerContextPacket(
    workspacePath: string,
    taskId: string,
    options: SchedulerContextOptions = {}
): SchedulerContextPacket | undefined {
    const store = new SchedulerStore(workspacePath);
    const task = store.getTask(taskId);
    if (!task) return undefined;

    const maxEvents = Math.max(1, options.maxEvents ?? 12);
    const importantEvents = store.listTaskEvents(taskId)
        .filter(event => IMPORTANT_EVENT_TYPES.has(event.event_type))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const truncated = importantEvents.length > maxEvents;
    const recentEvents = importantEvents.slice(-maxEvents);
    const latestCheckpoint = [...importantEvents].reverse().find(event => event.event_type === 'task_checkpointed')?.payload;
    const latestHandoff = [...importantEvents].reverse().find(event => event.event_type === 'task_handed_off')?.payload;
    const agentRuns = store.listAgentRuns().filter(run => run.task_id === taskId).slice(-5);

    return {
        task,
        recent_events: recentEvents,
        agent_runs: agentRuns,
        latest_checkpoint: latestCheckpoint,
        latest_handoff: latestHandoff,
        truncated,
    };
}

export function formatSchedulerContextForPrompt(
    packet: SchedulerContextPacket,
    options: SchedulerContextOptions = {}
): string {
    const maxChars = Math.max(1000, options.maxChars ?? 6000);
    const lines: string[] = [
        '## Inherited Scheduler Context',
        'This is task-scoped context from Optimus scheduler state. Treat it as inherited conversation context, not global project memory.',
        '',
        `- **Scheduler task**: \`${packet.task.id}\` [${packet.task.status}, priority=${packet.task.priority}] ${packet.task.title}`,
        `- **Required capability**: ${packet.task.required_capability}`,
        packet.task.assigned_agent_id ? `- **Assigned agent**: ${packet.task.assigned_agent_id}` : '',
        packet.task.context_summary ? `- **Context summary**: ${packet.task.context_summary}` : '',
        packet.task.acceptance_criteria ? `- **Acceptance criteria**: ${packet.task.acceptance_criteria}` : '',
        packet.task.affected_files.length > 0 ? `- **Affected files**: ${packet.task.affected_files.join(', ')}` : '',
        '',
    ].filter(Boolean);

    if (packet.latest_checkpoint) {
        lines.push('### Latest Checkpoint');
        appendPayloadLines(lines, packet.latest_checkpoint, ['summary', 'current_focus', 'next_steps', 'open_questions', 'handoff_recommended']);
        lines.push('');
    }

    if (packet.latest_handoff) {
        lines.push('### Latest Handoff');
        appendPayloadLines(lines, packet.latest_handoff, ['summary', 'reason', 'required_capability', 'assigned_agent_id', 'previous_status', 'next_status']);
        lines.push('');
    }

    if (packet.recent_events.length > 0) {
        lines.push('### Recent Scheduler Events');
        if (packet.truncated) {
            lines.push('- Earlier scheduler events were omitted to keep this context bounded.');
        }
        for (const event of packet.recent_events) {
            lines.push(`- ${event.created_at} \`${event.event_type}\`: ${summarizePayload(event.payload)}`);
        }
        lines.push('');
    }

    if (packet.agent_runs.length > 0) {
        lines.push('### Recent Agent Runs');
        for (const run of packet.agent_runs) {
            lines.push(`- \`${run.id}\` [${run.status}] ${run.runtime_run_id || ''}`.trim());
        }
        lines.push('');
    }

    const formatted = lines.join('\n').trim();
    if (formatted.length <= maxChars) return formatted;
    return `${formatted.slice(0, maxChars)}\n\n[Scheduler context truncated to ${maxChars} characters.]`;
}

function appendPayloadLines(lines: string[], payload: Record<string, unknown>, keys: string[]): void {
    for (const key of keys) {
        const value = payload[key];
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
            if (value.length === 0) continue;
            lines.push(`- **${key}**: ${value.join('; ')}`);
        } else {
            lines.push(`- **${key}**: ${String(value)}`);
        }
    }
}

function summarizePayload(payload: Record<string, unknown>): string {
    const summary = payload.summary || payload.reason || payload.next_steps || payload.content_summary;
    if (summary) return String(summary);
    const compact = JSON.stringify(payload);
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}
