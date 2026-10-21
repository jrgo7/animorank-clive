import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmCall } from './llmCalls';

const db = vi.hoisted(() => ({
  practiceSession: { count: vi.fn() },
  sessionHistoryEntry: { createMany: vi.fn() }
}));
vi.mock('$lib/zenstack', () => ({ db }));

import { llmCallEntries, ownsPracticeSession, requestEntries, SESSION_LOG_TYPES, writeSessionLog } from './sessionLog';

const SESSION = '123e4567-e89b-42d3-a456-426614174000';

function call(purpose: LlmCall['purpose'], started: string, latency: number): LlmCall {
  return {
    purpose,
    started,
    provider: 'fake',
    model_requested: 'fake-flash',
    effort: 'medium',
    max_output_tokens: 4000,
    system: 's',
    user: 'u',
    model: 'fake-flash',
    raw_text: '{}',
    reasoning: null,
    reasoning_tokens: null,
    stop_reason: 'stop',
    request_id: null,
    input_tokens: 1,
    output_tokens: 1,
    latency_ms: latency,
    error: null
  };
}

describe('session log', () => {
  beforeEach(() => {
    db.practiceSession.count.mockReset();
    db.sessionHistoryEntry.createMany.mockReset();
  });

  it('owns a practice session only when it is this user’s, for this problem', async () => {
    db.practiceSession.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(ownsPracticeSession('user-1', SESSION, 'problem-1')).resolves.toBe(true);
    await expect(ownsPracticeSession('user-2', SESSION, 'problem-1')).resolves.toBe(false);
    expect(db.practiceSession.count).toHaveBeenNthCalledWith(1, {
      where: { id: SESSION, student_id: 'user-1', problem_id: 'problem-1' }
    });
  });

  it('numbers model calls from 1 and stamps each at the moment it finished', () => {
    const entries = llmCallEntries('submit', [
      call('judge', '2026-10-15T07:12:58.222Z', 2021),
      call('nudge', '2026-10-15T07:13:00.300Z', 500)
    ]);

    expect(entries.map((e) => e.type)).toEqual([SESSION_LOG_TYPES.llmCall, SESSION_LOG_TYPES.llmCall]);
    expect(entries.map((e) => e.data.seq)).toEqual([1, 2]);
    expect(entries.every((e) => e.data.during === 'submit')).toBe(true);
    expect(entries[0].data.purpose).toBe('judge');
    expect(entries[0].timestamp.toISOString()).toBe('2026-10-15T07:13:00.243Z');
    expect(entries[1].timestamp.toISOString()).toBe('2026-10-15T07:13:00.800Z');
  });

  it('writes entries into the practice session’s history in one go', async () => {
    const at = new Date('2026-10-15T07:13:00.250Z');

    await writeSessionLog(SESSION, [{ type: SESSION_LOG_TYPES.submit, data: { attempt: 1 }, timestamp: at }]);

    expect(db.sessionHistoryEntry.createMany).toHaveBeenCalledWith({
      data: [{ practice_session_id: SESSION, type: 'CLIVE_SUBMIT', data: { attempt: 1 }, timestamp: at }]
    });
  });

  it('writes nothing for no entries', async () => {
    await writeSessionLog(SESSION, []);

    expect(db.sessionHistoryEntry.createMany).not.toHaveBeenCalled();
  });

  describe('a request’s entries', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stamps the record after its last model call, even when both land in the same millisecond', () => {
      // The call's latency was rounded up, so it "finished" a millisecond after the clock now reads.
      vi.useFakeTimers({ now: new Date('2026-10-20T08:00:03.276Z') });
      const entries = requestEntries('stuck', [call('stuck', '2026-10-20T08:00:00.000Z', 3277)], {
        type: SESSION_LOG_TYPES.stuck,
        data: { statement: 's' }
      });

      expect(entries.map((e) => e.type)).toEqual(['CLIVE_LLM_CALL', 'CLIVE_STUCK']);
      expect(entries[0].timestamp.toISOString()).toBe('2026-10-20T08:00:03.277Z');
      expect(entries[1].timestamp.toISOString()).toBe('2026-10-20T08:00:03.278Z');
    });

    it('stamps the record now when that is already after its calls', () => {
      vi.useFakeTimers({ now: new Date('2026-10-20T08:00:10.000Z') });
      const entries = requestEntries('submit', [call('judge', '2026-10-20T08:00:00.000Z', 2000)], {
        type: SESSION_LOG_TYPES.submit,
        data: {}
      });

      expect(entries[1].timestamp.toISOString()).toBe('2026-10-20T08:00:10.000Z');
    });

    it('stamps a request that made no model call now', () => {
      vi.useFakeTimers({ now: new Date('2026-10-20T08:00:10.000Z') });
      const entries = requestEntries('submit', [], { type: SESSION_LOG_TYPES.error, data: { error: 'e' } });

      expect(entries).toHaveLength(1);
      expect(entries[0].timestamp.toISOString()).toBe('2026-10-20T08:00:10.000Z');
    });
  });

  it('keeps model calls in the order they were made when their finish times collide', () => {
    const entries = llmCallEntries('submit', [
      call('judge', '2026-10-20T08:00:00.000Z', 1000),
      call('nudge', '2026-10-20T08:00:00.500Z', 500)
    ]);

    expect(entries[1].timestamp.getTime()).toBeGreaterThan(entries[0].timestamp.getTime());
  });
});
