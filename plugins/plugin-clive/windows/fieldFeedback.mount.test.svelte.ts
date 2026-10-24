// @vitest-environment happy-dom
/**
 * Feedback one thing at a time, the way a student meets it. A failed submit used
 * to put a card about one requirement beside a list of every requirement, each
 * failure badged "Blocks". The prototype's way, ported here: the page opens on
 * the question the nudge is about, says "Start here" there and nothing else,
 * and keeps the full list out of a stepped phase.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ProblemWindow from './ProblemWindow.window.svelte';
import CaseDesignWindow from './CaseDesignWindow.window.svelte';
import AlgorithmDesignWindow from './AlgorithmDesignWindow.window.svelte';
import ImplementWindow from './ImplementWindow.window.svelte';
import { cliveSessionFor, type JudgeResult, type Verdict } from './cliveSession.svelte';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

function stubContext(id: string): SolveWindowContext {
  return {
    problem: { id: 'problem-1' },
    practiceSession: { id, extension_data: {} },
    editorState: { code: 'int main(void) { return 0; }' },
    testCaseResults: { results: [], success: false },
    lastTestType: 'run',
    openWindow: () => {},
    closeWindowsExcept: () => {},
    telemetry: { record: () => {}, flush: async () => {} }
  } as unknown as SolveWindowContext;
}

function clickButton(label: string): void {
  const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes(label));
  if (!button) throw new Error(`No button matching ${label}`);
  button.click();
}

/** The server answers every submit with `response`. */
function stubSubmit(response: JudgeResult): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith('/boot')) return new Response(JSON.stringify({ hasApiKey: true }), { status: 200 });
      if (path.endsWith('/submit')) return new Response(JSON.stringify(response), { status: 200 });
      throw new Error(`unexpected ${path}`);
    })
  );
}

function verdict(id: string, fields: string[], overrides: Partial<Verdict> = {}): Verdict {
  return {
    criterion_id: id,
    criterion_text: `The ${id} requirement.`,
    not_met: `You should fix ${id}.`,
    verdict: 'FAIL',
    gate: 'gating',
    explain: `What ${id} asks for.`,
    recheck: [],
    outside_rules: [],
    fields,
    ...overrides
  };
}

const NUDGE_TEXT = 'Which values can each input take? Where does the problem say so?';

/** A failed Problem submit: Inputs and Outputs each miss a requirement, and the nudge picked the Inputs one. */
const FAILED_PROBLEM: JudgeResult = {
  passed: false,
  verdicts: [
    verdict('novel_wording', ['summary'], { verdict: 'PASS' }),
    verdict('constraints_noted', ['inputs']),
    verdict('output_types', ['outputs'])
  ],
  missing_ids: [],
  advisory_unmet: [],
  nudge: {
    summary: 'Your inputs need one more thing.',
    nudge: NUDGE_TEXT,
    reason: 'Upstream.',
    focus_id: 'constraints_noted',
    focus_text: 'The constraints_noted requirement.',
    focus_not_met: 'You should fix constraints_noted.',
    focus_fields: ['inputs'],
    failing: [
      { id: 'constraints_noted', text: 'constraints' },
      { id: 'output_types', text: 'outputs' }
    ]
  }
};

describe('feedback one thing at a time', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  /** Problem, every question answered, on its last question (where the first Submit waits). */
  function mountProblem(id: string) {
    const context = stubContext(id);
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    const phase = session.phases[0];
    phase.read = true;
    phase.artifact = { summary: 'Multiply two numbers.', inputs: 'Two ints.', outputs: 'Their product.' };
    phase.step = 2;
    const app = mount(ProblemWindow, { target: document.body, props: { context } });
    flushSync();
    return { session, app };
  }

  it('opens a failed submit on the nudge’s question, with "Start here" and nothing else beside it', async () => {
    stubSubmit(FAILED_PROBLEM);
    const { session, app } = mountProblem('feedback-start');

    clickButton('Submit');
    await vi.waitFor(() => expect(session.phases[0].result).not.toBeNull());
    flushSync();

    // Moved from Outputs to Inputs, the question the nudge is about.
    expect(session.phases[0].step).toBe(1);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Start here');
    expect(text).toContain('You should fix constraints_noted.');
    expect(text).toContain(NUDGE_TEXT);
    expect(text).toContain("There may be other things to fix. Submit again once this one's done and I'll check.");
    // No list of every requirement, no other failure, no phase-level card.
    expect(text).not.toContain('Every requirement');
    expect(text).not.toContain('See every requirement');
    expect(text).not.toContain("Let's look at this one");
    expect(text).not.toContain('What output_types asks for.');

    // The Outputs tab is marked as one to fix, the Summary tab as fine.
    const tab = (label: string) =>
      Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes(label));
    expect(tab('Outputs')?.dataset.mark).toBe('bad');
    expect(tab('Summary')?.dataset.mark).toBe('ok');

    // Another failing question shows its own line, and not the nudge.
    clickButton('Outputs');
    flushSync();
    expect(document.body.textContent).toContain('Something to fix here');
    expect(document.body.textContent).toContain('What output_types asks for.');
    expect(document.body.textContent).not.toContain(NUDGE_TEXT);
    unmount(app);
  });

  it('offers a passed submit’s optional points as worth a look, on their question', async () => {
    stubSubmit({
      passed: true,
      verdicts: [
        verdict('constraints_noted', ['inputs'], { verdict: 'PASS' }),
        verdict('input_order_stated', ['inputs'], { gate: 'advisory' })
      ],
      missing_ids: [],
      advisory_unmet: ['input_order_stated']
    });
    const { session, app } = mountProblem('feedback-look');

    clickButton('Submit');
    await vi.waitFor(() => expect(session.phases[0].passed).toBe(true));
    clickButton('Inputs');
    flushSync();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Worth a look');
    expect(text).toContain('You should fix input_order_stated.');
    expect(text).toContain('Optional. You can move on without these.');
    unmount(app);
  });

  it('says once, above the question, when part of the work came back unchecked', () => {
    stubSubmit(FAILED_PROBLEM);
    const { session, app } = mountProblem('feedback-missing');
    session.phases[0].result = { ...FAILED_PROBLEM, nudge: undefined, missing_ids: ['output_types'] };
    flushSync();

    // As the browser shows it: a line wrapped in the markup is one line on screen.
    expect(document.body.textContent?.replace(/\s+/g, ' ')).toContain(
      'Part of your work came back unchecked. That is a fault on our side, not yours — submitting again usually settles it.'
    );
    unmount(app);
  });

  it('shows the wait where the feedback goes while a resubmit is checked', () => {
    stubSubmit(FAILED_PROBLEM);
    const { session, app } = mountProblem('feedback-wait');
    session.phases[0].result = FAILED_PROBLEM;
    session.phases[0].step = 1;
    flushSync();
    expect(document.body.textContent).toContain('Start here');

    session.busy = 'submit';
    flushSync();
    expect(document.body.textContent).not.toContain('Start here');
    expect(document.body.textContent).toContain('Checking your work against every requirement.');
    session.busy = null;
    unmount(app);
  });

  it('puts a case’s computed check beside the nudge, and says when a case passed', async () => {
    const context = stubContext('feedback-cases');
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[1].unlocked = true;
    session.phases[1].artifact.normal_cases = [{ input: '4 6', output: '25', working: '4 * 6 = 25.' }];
    const failed: JudgeResult = {
      passed: false,
      verdicts: [verdict('outputs_are_correct', ['normal_cases'], { recheck: ['Case 1'] })],
      missing_ids: [],
      advisory_unmet: [],
      nudge: {
        ...FAILED_PROBLEM.nudge!,
        nudge: 'What does 4 times 6 come to?',
        focus_id: 'outputs_are_correct',
        focus_not_met: 'You should check your expected output.',
        focus_fields: ['normal_cases'],
        failing: [{ id: 'outputs_are_correct', text: 'outputs' }]
      }
    };
    stubSubmit(failed);
    const app = mount(CaseDesignWindow, { target: document.body, props: { context } });
    flushSync();

    clickButton('Submit');
    await vi.waitFor(() => expect(session.phases[1].stepResults.normal_cases).toBeDefined());
    flushSync();
    let text = document.body.textContent ?? '';
    expect(text).toContain('Start here');
    expect(text).toContain('You should check your expected output.');
    expect(text).toContain("The expected output doesn't match the problem's rule. Trace it again.");
    expect(text).toContain('What does 4 times 6 come to?');
    expect(text).not.toContain('Every requirement');

    session.phases[1].stepResults.normal_cases = {
      result: { passed: true, verdicts: [], missing_ids: [], advisory_unmet: [] },
      passed: true,
      attempt: 2
    };
    flushSync();
    text = document.body.textContent ?? '';
    expect(text).toContain('This case passed.');
    expect(text).not.toContain('Start here');
    unmount(app);
  });

  it('starts Design on its one question, without the list', () => {
    stubSubmit(FAILED_PROBLEM);
    const context = stubContext('feedback-design');
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[2].unlocked = true;
    session.phases[2].result = {
      passed: false,
      verdicts: [verdict('steps_are_ordered', ['steps'])],
      missing_ids: [],
      advisory_unmet: [],
      nudge: {
        ...FAILED_PROBLEM.nudge!,
        nudge: 'What happens first?',
        focus_id: 'steps_are_ordered',
        focus_not_met: 'You should put your steps in order.',
        focus_fields: ['steps'],
        failing: [{ id: 'steps_are_ordered', text: 'order' }]
      }
    };
    const app = mount(AlgorithmDesignWindow, { target: document.body, props: { context } });
    flushSync();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Start here');
    expect(text).toContain('You should put your steps in order.');
    expect(text).toContain('What happens first?');
    expect(text).not.toContain('Every requirement');
    expect(text).not.toContain("Let's look at this one");
    unmount(app);
  });

  it('folds Implement’s full list away under "See every requirement"', () => {
    stubSubmit(FAILED_PROBLEM);
    const context = stubContext('feedback-implement');
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[3].unlocked = true;
    session.phases[3].result = {
      passed: true,
      verdicts: [
        verdict('follows_own_design', [], { gate: 'advisory' }),
        verdict('readable', [], { gate: 'advisory', verdict: 'PASS' })
      ],
      missing_ids: [],
      advisory_unmet: ['follows_own_design']
    };
    const app = mount(ImplementWindow, { target: document.body, props: { context } });
    flushSync();

    const ledger = Array.from(document.querySelectorAll('details')).find((el) =>
      el.querySelector('summary')?.textContent?.includes('See every requirement')
    );
    expect(ledger).toBeDefined();
    expect(ledger?.open).toBe(false);
    const text = ledger?.textContent ?? '';
    expect(text).toContain('Optional');
    expect(text).toContain('Met');
    expect(text).toContain('The follows_own_design requirement.');
    expect(text).toContain('Not met. This one is optional: you can move on without it.');
    expect(document.body.textContent).not.toContain('Every requirement, checked');
    unmount(app);
  });
});
