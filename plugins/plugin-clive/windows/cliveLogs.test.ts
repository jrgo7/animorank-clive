import { describe, expect, it } from 'vitest';
import type { SessionLogEntry } from '$lib/analytics/sessionLogView';
import { attachCalls, offsetLabel, prettyValue } from './cliveLogs';

let nextId = 0;

function entry(type: string, timestamp: string, data: unknown = null): SessionLogEntry {
  nextId += 1;
  return {
    id: `entry-${nextId}`,
    type,
    timestamp,
    data: data as SessionLogEntry['data']
  };
}

/** The page hands entries newest first; this is the order the tests build them in. */
function newestFirst(entries: SessionLogEntry[]): SessionLogEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

describe('CLive log folding', () => {
  it('attaches a request’s calls to its record even with a page event between them', () => {
    const call = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.100Z', { during: 'submit', seq: 1 });
    const page = entry('CLIVE_PHASE_OPEN', '2026-10-21T10:00:00.200Z', { phase: 'case_design', via: 'track' });
    const submit = entry('CLIVE_SUBMIT', '2026-10-21T10:00:00.300Z', { phase_id: 'case_design' });

    const events = attachCalls(newestFirst([submit, page, call]));

    expect(events.map((event) => event.entry.type)).toEqual(['CLIVE_PHASE_OPEN', 'CLIVE_SUBMIT']);
    expect(events[0].calls).toEqual([]);
    expect(events[1].calls).toEqual([call]);
  });

  it('keeps each request’s calls with that request', () => {
    const first = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.100Z', { during: 'submit', seq: 1 });
    const firstSubmit = entry('CLIVE_SUBMIT', '2026-10-21T10:00:00.200Z', { attempt: 1 });
    const second = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.300Z', { during: 'submit', seq: 1 });
    const secondSubmit = entry('CLIVE_SUBMIT', '2026-10-21T10:00:00.400Z', { attempt: 2 });

    const events = attachCalls(newestFirst([secondSubmit, second, firstSubmit, first]));

    expect(events.map((event) => [event.entry.type, event.calls])).toEqual([
      ['CLIVE_SUBMIT', [first]],
      ['CLIVE_SUBMIT', [second]]
    ]);
  });

  it('attaches a failed request’s calls to the error they explain', () => {
    const judge = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.100Z', { during: 'stuck', seq: 1, error: 'overloaded' });
    const error = entry('CLIVE_ERROR', '2026-10-21T10:00:00.200Z', { call: 'stuck', error: 'model failed' });

    const events = attachCalls(newestFirst([error, judge]));

    expect(events).toHaveLength(1);
    expect(events[0].entry.type).toBe('CLIVE_ERROR');
    expect(events[0].calls).toEqual([judge]);
  });

  it('attaches a code-feedback call to its record, and a failed one to its error', () => {
    const call = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.100Z', { during: 'code-feedback', seq: 1 });
    const record = entry('CLIVE_CODE_FEEDBACK', '2026-10-21T10:00:00.200Z', { run_type: 'run' });
    const failedCall = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.300Z', { during: 'code-feedback', seq: 1 });
    const error = entry('CLIVE_ERROR', '2026-10-21T10:00:00.400Z', { call: 'code-feedback' });
    const events = attachCalls(newestFirst([record, call, error, failedCall]));
    expect(events.some((e) => e.entry.type === 'CLIVE_ORPHAN_CALLS')).toBe(false);
    expect(events.find((e) => e.entry.type === 'CLIVE_CODE_FEEDBACK')?.calls).toEqual([call]);
  });

  it('returns calls still held at the end as one orphan entry', () => {
    const first = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.100Z', { during: 'submit', seq: 1 });
    const second = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.200Z', { during: 'submit', seq: 2 });

    const events = attachCalls(newestFirst([second, first]));

    expect(events).toHaveLength(1);
    expect(events[0].entry.type).toBe('CLIVE_ORPHAN_CALLS');
    expect(events[0].calls).toEqual([first, second]);
  });

  it('leaves calls alone for an entry that served no model call', () => {
    const call = entry('CLIVE_LLM_CALL', '2026-10-21T10:00:00.100Z', { during: 'submit', seq: 1 });
    const run = entry('CLIVE_RUN', '2026-10-21T10:00:00.200Z', { attempt: 1 });

    const events = attachCalls(newestFirst([run, call]));

    expect(events.map((event) => [event.entry.type, event.calls])).toEqual([
      ['CLIVE_RUN', []],
      ['CLIVE_ORPHAN_CALLS', [call]]
    ]);
  });

  it('reads a timestamp as an offset from the session’s first entry', () => {
    expect(offsetLabel('2026-10-21T10:01:05.000Z', '2026-10-21T10:00:00.000Z')).toBe('+1:05');
    expect(offsetLabel('2026-10-21T10:00:05.000Z', null)).toBe('');
  });

  it('numbers a Design outline the way the judge read it', () => {
    expect(
      prettyValue([
        { text: 'Read the input', level: 0 },
        { text: 'Track the maximum', level: 1 },
        { text: 'Print it', level: 0 }
      ])
    ).toBe('1. Read the input\n   a. Track the maximum\n2. Print it');
  });
});
