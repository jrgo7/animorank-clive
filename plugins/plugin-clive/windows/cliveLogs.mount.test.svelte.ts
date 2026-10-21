// @vitest-environment happy-dom
/**
 * The CLive session-logs view, mounted for real. The logic tests cover the
 * folding; this proves the timeline it produces is what the page renders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { SessionLogEntry } from '$lib/analytics/sessionLogView';
import type { SessionLogsViewContext } from '../../../src/routes/instructor/analytics/session-logs/context.svelte';
import CLiveLogs from './CLiveLogs.window.svelte';

let nextId = 0;

function entry(type: string, timestamp: string, data: unknown): SessionLogEntry {
  nextId += 1;
  return { id: `mount-${nextId}`, type, timestamp, data: data as SessionLogEntry['data'] };
}

function stubContext(logs: SessionLogEntry[]): SessionLogsViewContext {
  return {
    logs,
    problem: { id: 'problem-1', name: 'Sums', description: '', language: 'c' },
    problemSet: null,
    document: null,
    openView: async () => {}
  } as unknown as SessionLogsViewContext;
}

function render(logs: SessionLogEntry[]): string {
  const app = mount(CLiveLogs, { target: document.body, props: { context: stubContext(logs) } });
  flushSync();
  const text = document.body.textContent ?? '';
  unmount(app);
  return text;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CLive logs view', () => {
  it('says so when the session has no CLive entries', () => {
    const text = render([entry('TEXT_MODIFIED', '2026-10-21T10:00:00.000Z', {})]);
    expect(text).toContain('No CLive events in this session');
    expect(text).not.toContain('Session started');
  });

  it('renders the timeline with its navigation, runs, submits, stuck asks and calls', () => {
    const logs = [
      entry('CLIVE_SUBMIT', '2026-10-21T10:00:20.000Z', {
        phase_id: 'case_design',
        problem_id: 'problem-1',
        attempt: 1,
        artifact: { cases: '1, 2, 3' },
        response: {
          passed: false,
          missing_ids: [],
          verdicts: [
            {
              criterion_id: 'case_is_concrete',
              criterion_text: 'Each case is concrete',
              verdict: 'FAIL',
              gate: 'gating',
              evidence: 'the input is large',
              evidence_found: true
            }
          ],
          nudge: { summary: 'Name the values', focus_not_met: 'Say what the input is', nudge: 'Write one exact case.' }
        }
      }),
      entry('CLIVE_LLM_CALL', '2026-10-21T10:00:15.000Z', {
        during: 'submit',
        seq: 1,
        purpose: 'judge',
        model: 'fake-flash',
        input_tokens: 10,
        output_tokens: 20,
        latency_ms: 1200,
        system: 'judge this',
        user: 'the work',
        raw_text: '{}'
      }),
      entry('CLIVE_RUN', '2026-10-21T10:00:12.000Z', {
        problem: 'problem-1',
        phase: 'implement',
        passed: true,
        tests_passed: 2,
        tests_total: 2
      }),
      entry('CLIVE_STUCK', '2026-10-21T10:00:10.000Z', {
        phase_id: 'problem_definition',
        problem_id: 'problem-1',
        attempt: 1,
        statement: 'I do not understand',
        diagnosis: 'No constraints recorded',
        response: { feedback: 'Start with the input.' }
      }),
      entry('CLIVE_LIVE_CHECK', '2026-10-21T10:00:08.000Z', {
        problem: 'problem-1',
        diagnostics: [
          { line: 3, kind: 'missing-semicolon' },
          { line: 5, kind: 'undeclared' }
        ]
      }),
      entry('CLIVE_PROBLEM_LOAD', '2026-10-21T10:00:02.000Z', {
        problem: 'problem-1',
        restored: false,
        phase: 'problem_definition'
      }),
      entry('CLIVE_SESSION_START', '2026-10-21T10:00:00.000Z', {
        problem: 'problem-1',
        new_session: true,
        live: 'on'
      })
    ];

    const text = render(logs);

    expect(text).toContain('CLive events');
    expect(text).toContain('Session started');
    expect(text).toContain('Problem loaded');
    expect(text).toContain('Live: 2 marked (missing-semicolon, undeclared)');
    expect(text).toContain('Stuck · problem_definition');
    expect(text).toContain('I do not understand');
    expect(text).toContain('No constraints recorded');
    expect(text).toContain('Run · problem-1');
    expect(text).toContain('Tests: 2/2 passed');
    expect(text).toContain('Submit · case_design');
    expect(text).toContain('Each case is concrete');
    expect(text).toContain('the input is large');
    expect(text).toContain('Name the values');
    expect(text).toContain('Model calls (1)');
    expect(text).toContain('judge this');
    expect(text).toContain('+0:20');
  });

  it('shows an error with the calls that led to it', () => {
    const text = render([
      entry('CLIVE_ERROR', '2026-10-21T10:00:05.000Z', { call: 'stuck', error: 'the model gave up' }),
      entry('CLIVE_LLM_CALL', '2026-10-21T10:00:04.000Z', {
        during: 'stuck',
        seq: 1,
        purpose: 'stuck',
        error: 'overloaded',
        latency_ms: 500
      }),
      entry('CLIVE_SESSION_START', '2026-10-21T10:00:00.000Z', { live: 'off' })
    ]);

    expect(text).toContain('Error during stuck');
    expect(text).toContain('the model gave up');
    expect(text).toContain('Model calls (1)');
    expect(text).toContain('failed');
  });
});
