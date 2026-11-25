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

/** The view's text as the browser shows it: a line wrapped in the markup is one line on screen. */
function render(logs: SessionLogEntry[]): string {
  const app = mount(CLiveLogs, { target: document.body, props: { context: stubContext(logs) } });
  flushSync();
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
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

  it('names the participant the researcher tagged, and lists the tagging and any override', () => {
    const text = render([
      entry('CLIVE_RESEARCHER_OVERRIDE', '2026-10-21T10:05:00.000Z', { from_phase: 'problem_definition' }),
      entry('CLIVE_PARTICIPANT', '2026-10-21T10:01:00.000Z', { participant: 'P07' }),
      entry('CLIVE_SESSION_START', '2026-10-21T10:00:00.000Z', {})
    ]);
    expect(text).toContain('participant P07');
    expect(text).toContain('Participant tagged');
    expect(text).toContain('Researcher override');
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

  it('shows each nudge’s level, and each escalation with its prompt, reason and call, counting escalations', () => {
    const text = render([
      entry('CLIVE_ESCALATE', '2026-10-21T10:01:00.000Z', {
        phase_id: 'case_design',
        problem_id: 'problem-1',
        step: 'normal_cases',
        attempt: 1,
        level: 'prompt',
        focus_id: 'case_is_concrete',
        response: {
          level: 'prompt',
          nudge: 'Which two numbers would you give it?',
          reason: 'Still describes the input.',
          focus_not_met: 'Give a real input',
          leak_blocked: false
        }
      }),
      entry('CLIVE_LLM_CALL', '2026-10-21T10:00:59.000Z', {
        during: 'escalate',
        seq: 1,
        purpose: 'nudge',
        latency_ms: 900
      }),
      entry('CLIVE_SUBMIT', '2026-10-21T10:00:20.000Z', {
        phase_id: 'case_design',
        problem_id: 'problem-1',
        attempt: 1,
        step: 'normal_cases',
        response: {
          passed: false,
          missing_ids: [],
          verdicts: [],
          nudge: {
            level: 'hint',
            focus_not_met: 'Give a real input',
            nudge: 'What would you actually type in?',
            reason: 'Describes the input.'
          }
        }
      })
    ]);

    expect(text).toContain('Escalation · case_design · problem-1 · normal_cases · attempt 1');
    expect(text).toContain('Level: hint');
    expect(text).toContain('Level: prompt');
    expect(text).toContain('Which two numbers would you give it?');
    expect(text).toContain('Still describes the input.');
    expect(text).toContain('Describes the input.');
    expect(text).toContain('1 escalation');
    expect(text).not.toContain('stuck ask');
    expect(text).toContain('Model calls (1)');
  });

  it('shows each code-feedback reply with its level, and an Implement escalation with its prompt', () => {
    const text = render([
      entry('CLIVE_PHASE_PASSED', '2026-10-21T10:03:00.000Z', { phase: 'implement', attempt: 3, run_type: 'submit' }),
      entry('CLIVE_ESCALATE', '2026-10-21T10:02:00.000Z', {
        phase_id: 'implement',
        problem_id: 'problem-1',
        step: null,
        attempt: 2,
        run_type: 'run',
        level: 'prompt',
        situation: 'departs_from_plan',
        focus: 'step 2',
        response: {
          level: 'prompt',
          situation: 'departs_from_plan',
          summary: '2 of 4 examples fail.',
          focus: 'step 2',
          nudge: 'Where does nSum get its starting value?',
          leaks: ['C code: a line ending in a semicolon'],
          leak_blocked: false
        }
      }),
      entry('CLIVE_CODE_FEEDBACK', '2026-10-21T10:01:00.000Z', {
        problem_id: 'problem-1',
        run_type: 'run',
        attempt: 2,
        level: 'hint',
        code: 'int main(void) { return 1; }',
        run: { compiled: true, cases: [{ input: '4', expected: '10', actual: '4', passed: false }], hiddenFailed: 1 },
        response: {
          level: 'hint',
          situation: 'departs_from_plan',
          summary: '2 of 4 examples fail.',
          focus: 'step 2',
          nudge: 'Follow section two through your plan.',
          leaks: [],
          leak_blocked: false
        }
      }),
      // Recorded before the ladder: no level.
      entry('CLIVE_CODE_FEEDBACK', '2026-10-21T10:00:00.000Z', {
        run_type: 'submit',
        attempt: 1,
        response: { situation: 'other', summary: 'It ran.', focus: 'the loop', nudge: 'Look at the loop.' }
      })
    ]);

    expect(text).toContain('Code feedback · run · attempt 2');
    expect(text).toContain('Code feedback · submit · attempt 1');
    expect(text).toContain('Level: hint');
    expect(text).toContain('Situation: departs_from_plan');
    expect(text).toContain('Focus: step 2');
    expect(text).toContain('Follow section two through your plan.');
    expect(text).toContain('Look at the loop.');
    expect(text).toContain('int main(void) { return 1; }');
    expect(text).toContain('Escalation · implement · problem-1 · attempt 2');
    expect(text).toContain('Level: prompt');
    expect(text).toContain('Where does nSum get its starting value?');
    expect(text).toContain('Leak check found: C code: a line ending in a semicolon');
    expect(text).toContain('2 code feedback replies');
    expect(text).toContain('1 escalation');
    expect(text).toContain('Phase passed');
  });

  it('says when the leak check held a nudge back', () => {
    const text = render([
      entry('CLIVE_ESCALATE', '2026-10-21T10:01:00.000Z', {
        phase_id: 'case_design',
        level: 'prompt',
        response: { level: 'prompt', nudge: '', leak_blocked: true, leaks: ['Case 1 expected output "24"'] }
      })
    ]);
    expect(text).toContain('The leak check held this nudge back');
    expect(text).toContain('Case 1 expected output "24"');
  });

  it('still renders a session recorded before the ladder: stuck asks, situations and summaries', () => {
    const text = render([
      entry('CLIVE_SUBMIT', '2026-10-21T10:00:20.000Z', {
        phase_id: 'problem_definition',
        attempt: 1,
        response: {
          passed: false,
          verdicts: [],
          nudge: { situation: 'meaning_not_type', summary: 'Types first', nudge: 'Which type?', focus_not_met: 'n' }
        }
      }),
      entry('CLIVE_STUCK', '2026-10-21T10:00:10.000Z', {
        phase_id: 'problem_definition',
        attempt: 1,
        statement: 'I do not understand',
        diagnosis: 'No constraints recorded',
        response: { feedback: 'Start with the input.' }
      })
    ]);

    expect(text).toContain('Situation: meaning_not_type');
    expect(text).toContain('Types first');
    expect(text).toContain('Stuck · problem_definition');
    expect(text).toContain('1 stuck ask (before the hint ladder)');
    expect(text).toContain('0 escalations');
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
