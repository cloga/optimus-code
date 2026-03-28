import { describe, expect, it, afterEach } from 'vitest';
import {
    createEventBuffer,
    pushStreamEvent,
    subscribeToEvents,
    markStreamComplete,
    getEventBuffer,
    clearEventBuffer,
    StreamEvent,
} from '../utils/agentRuntime';

const createdBuffers: string[] = [];

afterEach(() => {
    for (const id of createdBuffers) {
        clearEventBuffer(id);
    }
    createdBuffers.length = 0;
});

function makeRunId(): string {
    const id = `test_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    createdBuffers.push(id);
    return id;
}

describe('StreamEvent buffer', () => {
    it('creates a buffer and pushes events', () => {
        const runId = makeRunId();
        createEventBuffer(runId);

        const event = pushStreamEvent(runId, 'text', 'Hello');
        expect(event).not.toBeNull();
        expect(event!.type).toBe('text');
        expect(event!.data).toBe('Hello');
        expect(event!.sequence).toBe(1);
    });

    it('increments sequence numbers', () => {
        const runId = makeRunId();
        createEventBuffer(runId);

        pushStreamEvent(runId, 'text', 'a');
        pushStreamEvent(runId, 'thinking', 'b');
        const third = pushStreamEvent(runId, 'text', 'c');

        expect(third!.sequence).toBe(3);
    });

    it('returns null when pushing to a nonexistent buffer', () => {
        const result = pushStreamEvent('nonexistent_run', 'text', 'data');
        expect(result).toBeNull();
    });

    it('notifies live listeners on push', () => {
        const runId = makeRunId();
        createEventBuffer(runId);

        const received: StreamEvent[] = [];
        subscribeToEvents(runId, 0, (event) => received.push(event));

        pushStreamEvent(runId, 'text', 'live1');
        pushStreamEvent(runId, 'text', 'live2');

        expect(received).toHaveLength(2);
        expect(received[0].data).toBe('live1');
        expect(received[1].data).toBe('live2');
    });

    it('replays events since a given sequence on subscribe', () => {
        const runId = makeRunId();
        createEventBuffer(runId);

        pushStreamEvent(runId, 'text', 'first');
        pushStreamEvent(runId, 'text', 'second');
        pushStreamEvent(runId, 'text', 'third');

        const received: StreamEvent[] = [];
        subscribeToEvents(runId, 1, (event) => received.push(event));

        expect(received).toHaveLength(2);
        expect(received[0].data).toBe('second');
        expect(received[1].data).toBe('third');
    });

    it('marks the buffer complete and pushes a done event', () => {
        const runId = makeRunId();
        createEventBuffer(runId);

        pushStreamEvent(runId, 'text', 'content');
        markStreamComplete(runId);

        const buffer = getEventBuffer(runId);
        expect(buffer?.completed).toBe(true);

        const lastEvent = buffer!.events[buffer!.events.length - 1];
        expect(lastEvent.type).toBe('done');
    });

    it('returns completed=true when subscribing to a completed buffer', () => {
        const runId = makeRunId();
        createEventBuffer(runId);
        pushStreamEvent(runId, 'text', 'data');
        markStreamComplete(runId);

        const { completed } = subscribeToEvents(runId, 0, () => {});
        expect(completed).toBe(true);
    });

    it('unsubscribe stops receiving events', () => {
        const runId = makeRunId();
        createEventBuffer(runId);

        const received: StreamEvent[] = [];
        const { unsubscribe } = subscribeToEvents(runId, 0, (event) => received.push(event));

        pushStreamEvent(runId, 'text', 'before');
        unsubscribe();
        pushStreamEvent(runId, 'text', 'after');

        expect(received).toHaveLength(1);
        expect(received[0].data).toBe('before');
    });

    it('supports multiple concurrent subscribers', () => {
        const runId = makeRunId();
        createEventBuffer(runId);

        const received1: StreamEvent[] = [];
        const received2: StreamEvent[] = [];
        subscribeToEvents(runId, 0, (event) => received1.push(event));
        subscribeToEvents(runId, 0, (event) => received2.push(event));

        pushStreamEvent(runId, 'text', 'shared');

        expect(received1).toHaveLength(1);
        expect(received2).toHaveLength(1);
        expect(received1[0].data).toBe('shared');
    });

    it('clearEventBuffer removes the buffer', () => {
        const runId = makeRunId();
        createEventBuffer(runId);
        pushStreamEvent(runId, 'text', 'data');

        clearEventBuffer(runId);
        expect(getEventBuffer(runId)).toBeUndefined();
    });
});
