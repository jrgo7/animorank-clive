import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmCall } from './llmCalls';

const db = vi.hoisted(() => ({
  practiceSession: { count: vi.fn() },
  sessionHistoryEntry: { createMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() }
}));
vi.mock('$lib/zenstack', () => ({ db }));

import {
  checkSessionLog,
  latestCodeFeedbackRecord,
  latestSubmitRecord,
  llmCallEntries,
  ownsPracticeSession,
  requestEntries,
  SESSION_LOG_TYPES,
  submissionEscalated,
  writeSessionLog
} from './sessionLog';

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
    db.sessionHistoryEntry.create.mockReset();
    db.sessionHistoryEntry.findUnique.mockReset();
    db.sessionHistoryEntry.findMany.mockReset();
  });

  it('finds the newest submit record for a phase and step, and none for a phase never submitted', async () => {
    // Newest first, as the history is read.
    db.sessionHistoryEntry.findMany.mockResolvedValue([
      { data: { phase_id: 'case_design', step: 'edge_cases', attempt: 3 } },
      { data: { phase_id: 'case_design', step: 'normal_cases', attempt: 2 } },
      { data: { phase_id: 'case_design', step: 'normal_cases', attempt: 1 } },
      { data: { phase_id: 'problem_definition', step: null, attempt: 4 } },
      { data: null }
    ]);

    await expect(latestSubmitRecord(SESSION, 'case_design', 'normal_cases')).resolves.toMatchObject({ attempt: 2 });
    await expect(latestSubmitRecord(SESSION, 'problem_definition', null)).resolves.toMatchObject({ attempt: 4 });
    await expect(latestSubmitRecord(SESSION, 'algorithm_design', null)).resolves.toBeNull();
    expect(db.sessionHistoryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { practice_session_id: SESSION, type: 'CLIVE_SUBMIT' },
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }]
      })
    );
  });

  it('knows a submission was escalated only from an escalation written after it, on the same step and attempt', async () => {
    const submit = (step: string, attempt: number) => ({
      type: 'CLIVE_SUBMIT',
      data: { phase_id: 'case_design', step, attempt }
    });
    const escalation = (step: string, attempt: number) => ({
      type: 'CLIVE_ESCALATE',
      data: { phase_id: 'case_design', step, attempt }
    });
    const escalated = () => submissionEscalated(SESSION, 'case_design', 'normal_cases', 2);

    // Newest first, as the history is read.
    db.sessionHistoryEntry.findMany.mockResolvedValue([
      escalation('normal_cases', 2),
      submit('normal_cases', 2),
      escalation('normal_cases', 1),
      submit('normal_cases', 1)
    ]);
    await expect(escalated()).resolves.toBe(true);
    expect(db.sessionHistoryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { practice_session_id: SESSION, type: { in: ['CLIVE_SUBMIT', 'CLIVE_ESCALATE'] } },
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }]
      })
    );

    // The escalation before it was of the submission before it.
    db.sessionHistoryEntry.findMany.mockResolvedValue([submit('normal_cases', 2), escalation('normal_cases', 1)]);
    await expect(escalated()).resolves.toBe(false);

    // Another case's escalation, or one on another attempt, is not this one's.
    db.sessionHistoryEntry.findMany.mockResolvedValue([
      escalation('edge_cases', 2),
      escalation('normal_cases', 1),
      submit('normal_cases', 2)
    ]);
    await expect(escalated()).resolves.toBe(false);
  });

  describe('the newest code feedback', () => {
    const FEEDBACK_AT = new Date('2026-11-25T10:00:10.000Z');
    const FEEDBACK = { attempt: 3, run_type: 'run', code: 'broken', response: { situation: 'other' } };
    const run = (submittedCode: string, results: boolean[], runType = 'run') => ({
      data: { runType, submittedCode, generalTestResults: results }
    });

    /** The history, by entry type, newest first: what each query of the reader finds. */
    function history(rows: { feedback?: unknown[]; escalations?: unknown[]; runs?: unknown[] }): void {
      db.sessionHistoryEntry.findMany.mockImplementation(async ({ where }: { where: { type: unknown } }) => {
        if (where.type === 'CLIVE_CODE_FEEDBACK') return rows.feedback ?? [];
        if (where.type === 'CLIVE_ESCALATE') return rows.escalations ?? [];
        if (where.type === 'RUN_ATTEMPT') return rows.runs ?? [];
        return [];
      });
    }

    it('is null when no code feedback was recorded', async () => {
      history({});
      await expect(latestCodeFeedbackRecord(SESSION)).resolves.toBeNull();
    });

    it('is the newest record, not yet escalated, with nothing passing since the run it answered', async () => {
      history({
        feedback: [{ data: FEEDBACK, timestamp: FEEDBACK_AT }],
        runs: [run('broken', [false, true]), run('older', [true, true])]
      });
      await expect(latestCodeFeedbackRecord(SESSION)).resolves.toEqual({
        record: FEEDBACK,
        escalated: false,
        passedSince: false
      });
      expect(db.sessionHistoryEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { practice_session_id: SESSION, type: 'CLIVE_CODE_FEEDBACK' },
          orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
          take: 1
        })
      );
      // Only escalations written after the feedback are read.
      expect(db.sessionHistoryEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { practice_session_id: SESSION, type: 'CLIVE_ESCALATE', timestamp: { gt: FEEDBACK_AT } }
        })
      );
    });

    it('knows a Run or Submit after the one it answered passed every test', async () => {
      history({
        feedback: [{ data: FEEDBACK, timestamp: FEEDBACK_AT }],
        runs: [run('fixed', [true, true, true], 'submit'), run('broken', [false, true])]
      });
      await expect(latestCodeFeedbackRecord(SESSION)).resolves.toMatchObject({ passedSince: true });
    });

    it('knows an Implement escalation on the same attempt escalated it, and nothing else does', async () => {
      const escalation = (phase_id: string, attempt: number) => ({ data: { phase_id, attempt } });
      history({
        feedback: [{ data: FEEDBACK, timestamp: FEEDBACK_AT }],
        escalations: [escalation('case_design', 3), escalation('implement', 2)]
      });
      await expect(latestCodeFeedbackRecord(SESSION)).resolves.toMatchObject({ escalated: false });

      history({ feedback: [{ data: FEEDBACK, timestamp: FEEDBACK_AT }], escalations: [escalation('implement', 3)] });
      await expect(latestCodeFeedbackRecord(SESSION)).resolves.toMatchObject({ escalated: true });
    });
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

  describe('a log check', () => {
    it('writes a fresh nonce and reports the write when it reads back', async () => {
      let written: { data?: { nonce?: string } } | undefined;
      db.sessionHistoryEntry.create.mockImplementation(async ({ data }: { data: { data: { nonce: string } } }) => {
        written = data;
        return { id: 'entry-1' };
      });
      db.sessionHistoryEntry.findUnique.mockImplementation(async () => ({ data: written?.data }));

      await expect(checkSessionLog(SESSION)).resolves.toEqual({ ok: true, file: SESSION, error: '' });

      expect(db.sessionHistoryEntry.create).toHaveBeenCalledWith({
        data: {
          practice_session_id: SESSION,
          type: 'CLIVE_LOG_CHECK',
          data: { nonce: expect.any(String) },
          timestamp: expect.any(Date)
        },
        select: { id: true }
      });
      expect(db.sessionHistoryEntry.findUnique).toHaveBeenCalledWith({
        where: { id: 'entry-1' },
        select: { data: true }
      });
    });

    it('reports a check that cannot be read back, rather than throwing', async () => {
      db.sessionHistoryEntry.create.mockResolvedValue({ id: 'entry-1' });
      db.sessionHistoryEntry.findUnique.mockResolvedValue({ data: { nonce: 'some-other-check' } });

      await expect(checkSessionLog(SESSION)).resolves.toEqual({
        ok: false,
        file: SESSION,
        error: 'The entry was written but could not be read back.'
      });
    });

    it('reports a failed write, rather than throwing', async () => {
      db.sessionHistoryEntry.create.mockRejectedValue(new Error('database down'));

      await expect(checkSessionLog(SESSION)).resolves.toEqual({
        ok: false,
        file: SESSION,
        error: 'database down'
      });
    });
  });

  describe('a request’s entries', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stamps the record after its last model call, even when both land in the same millisecond', () => {
      // The call's latency was rounded up, so it "finished" a millisecond after the clock now reads.
      vi.useFakeTimers({ now: new Date('2026-10-20T08:00:03.276Z') });
      const entries = requestEntries('escalate', [call('nudge', '2026-10-20T08:00:00.000Z', 3277)], {
        type: SESSION_LOG_TYPES.escalate,
        data: { level: 'prompt' }
      });

      expect(entries.map((e) => e.type)).toEqual(['CLIVE_LLM_CALL', 'CLIVE_ESCALATE']);
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
