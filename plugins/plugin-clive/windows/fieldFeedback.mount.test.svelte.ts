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
import { cliveSessionFor, type JudgeResult, type NudgeResult, type Verdict } from './cliveSession.svelte';
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
  stubServer({ submit: [response] });
}

/**
 * A server that answers each `/submit` and `/escalate` with the next reply queued
 * for it (the last one repeats), and keeps every body the page sent.
 */
function stubServer(replies: { submit: JudgeResult[]; escalate?: NudgeResult[] }) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/boot')) return new Response(JSON.stringify({ hasApiKey: true }), { status: 200 });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/submit')) {
        sent.push({ path: '/submit', body });
        return new Response(JSON.stringify(next(replies.submit)), { status: 200 });
      }
      if (path.endsWith('/escalate') && replies.escalate) {
        sent.push({ path: '/escalate', body });
        return new Response(JSON.stringify(next(replies.escalate)), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    })
  );
  return { sent: (path: string) => sent.filter((s) => s.path === path).map((s) => s.body) };
}

/** The buttons that say "I'm stuck". */
const stuckButtons = () =>
  Array.from(document.querySelectorAll('button')).filter((el) => el.textContent?.includes("I'm stuck"));

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
    level: 'hint',
    nudge: NUDGE_TEXT,
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

  describe('the hint ladder', () => {
    const PROMPT_TEXT = 'Does the problem give a smallest or largest value for n?';
    const ESCALATED: NudgeResult = { ...FAILED_PROBLEM.nudge!, level: 'prompt', nudge: PROMPT_TEXT };
    /** A resubmit still failing on the same requirement, which the server now answers at prompt. */
    const STILL_FAILING: JudgeResult = {
      ...FAILED_PROBLEM,
      nudge: { ...FAILED_PROBLEM.nudge!, level: 'prompt', nudge: 'Which line of the problem says how big n can be?' }
    };
    /** A resubmit whose first failing requirement is now another one, on Outputs. */
    const NEW_FOCUS: JudgeResult = {
      ...FAILED_PROBLEM,
      verdicts: [verdict('constraints_noted', ['inputs'], { verdict: 'PASS' }), verdict('output_types', ['outputs'])],
      nudge: {
        level: 'hint',
        nudge: 'What kind of value does it print?',
        focus_id: 'output_types',
        focus_text: 'The output_types requirement.',
        focus_not_met: 'You should fix output_types.',
        focus_fields: ['outputs'],
        failing: [{ id: 'output_types', text: 'outputs' }]
      }
    };

    it('shows no "I\'m stuck" before a failed submit, and no box to type into anywhere', () => {
      stubSubmit(FAILED_PROBLEM);
      const { app } = mountProblem('ladder-before');
      expect(stuckButtons()).toHaveLength(0);
      expect(document.body.textContent).not.toContain('What are you having trouble with?');
      unmount(app);
    });

    it('answers a failed submit with a hint and "I\'m stuck"; the button brings a prompt under the hint and goes', async () => {
      const server = stubServer({ submit: [FAILED_PROBLEM], escalate: [ESCALATED] });
      const { session, app } = mountProblem('ladder-escalate');

      clickButton('Submit');
      await vi.waitFor(() => expect(session.phases[0].result).not.toBeNull());
      flushSync();
      expect(document.body.textContent).toContain(NUDGE_TEXT);
      expect(stuckButtons()).toHaveLength(1);

      stuckButtons()[0].click();
      flushSync();
      expect(session.busy).toBe('escalate');
      await vi.waitFor(() => expect(session.busy).toBeNull());
      flushSync();

      // Where the student is and what they were told: no work and no verdicts.
      const [asked] = server.sent('/escalate');
      expect(asked).toMatchObject({
        sessionId: 'ladder-escalate',
        phase: 'problem_definition',
        problemId: 'problem-1',
        attempt: 1,
        history: [{ attempt: 1, level: 'hint', focus_id: 'constraints_noted', nudge: NUDGE_TEXT }]
      });
      expect(asked).not.toHaveProperty('artifact');
      expect(asked).not.toHaveProperty('verdicts');

      const text = document.body.textContent ?? '';
      expect(text).toContain(PROMPT_TEXT);
      expect(text.indexOf(NUDGE_TEXT)).toBeLessThan(text.indexOf(PROMPT_TEXT));
      expect(stuckButtons()).toHaveLength(0);
      expect(session.historyFor(0).at(-1)).toEqual({
        attempt: 1,
        level: 'prompt',
        focus_id: 'constraints_noted',
        nudge: PROMPT_TEXT
      });
      unmount(app);
    });

    it('answers the next failed submit on that requirement with a new prompt and no button', async () => {
      const server = stubServer({ submit: [FAILED_PROBLEM, STILL_FAILING], escalate: [ESCALATED] });
      const { session, app } = mountProblem('ladder-stays');

      clickButton('Submit');
      await vi.waitFor(() => expect(session.phases[0].result).not.toBeNull());
      flushSync();
      stuckButtons()[0].click();
      await vi.waitFor(() => expect(session.historyFor(0).at(-1)?.level).toBe('prompt'));
      flushSync();

      clickButton('Resubmit');
      await vi.waitFor(() => expect(session.phases[0].attempt).toBe(3));
      flushSync();

      // The resubmit carried the escalation, so the server could keep the requirement at prompt.
      expect(server.sent('/submit')[1].history).toContainEqual({
        attempt: 1,
        level: 'prompt',
        focus_id: 'constraints_noted',
        nudge: PROMPT_TEXT
      });
      const text = document.body.textContent ?? '';
      expect(text).toContain('Which line of the problem says how big n can be?');
      expect(text).not.toContain(NUDGE_TEXT);
      expect(stuckButtons()).toHaveLength(0);
      unmount(app);
    });

    it('starts a new requirement at a hint, with the button back', async () => {
      stubServer({ submit: [FAILED_PROBLEM, NEW_FOCUS], escalate: [ESCALATED] });
      const { session, app } = mountProblem('ladder-new-focus');

      clickButton('Submit');
      await vi.waitFor(() => expect(session.phases[0].result).not.toBeNull());
      flushSync();
      stuckButtons()[0].click();
      await vi.waitFor(() => expect(session.historyFor(0).at(-1)?.level).toBe('prompt'));
      flushSync();

      clickButton('Resubmit');
      await vi.waitFor(() => expect(session.phases[0].attempt).toBe(3));
      flushSync();

      expect(session.phases[0].step).toBe(2);
      expect(document.body.textContent).toContain('What kind of value does it print?');
      expect(stuckButtons()).toHaveLength(1);
      unmount(app);
    });

    it('waits under the hint while the prompt is coming', () => {
      stubSubmit(FAILED_PROBLEM);
      const { session, app } = mountProblem('ladder-wait');
      session.phases[0].result = FAILED_PROBLEM;
      session.phases[0].step = 1;
      session.busy = 'escalate';
      flushSync();

      const text = document.body.textContent ?? '';
      expect(text).toContain(NUDGE_TEXT);
      expect(text).toContain('CLive is thinking');
      expect(text.indexOf(NUDGE_TEXT)).toBeLessThan(text.indexOf('CLive is thinking'));
      session.busy = null;
      unmount(app);
    });

    it('shows no stuck UI in any phase, Implement included', () => {
      stubSubmit(FAILED_PROBLEM);
      const context = stubContext('ladder-no-stuck');
      const session = cliveSessionFor(context);
      session.tutorialSeen = true;
      for (const phase of session.phases) {
        phase.unlocked = true;
        phase.read = true;
      }
      for (const Window of [ProblemWindow, CaseDesignWindow, AlgorithmDesignWindow, ImplementWindow]) {
        const app = mount(Window, { target: document.body, props: { context } });
        flushSync();
        expect(stuckButtons(), Window.name).toHaveLength(0);
        expect(document.body.textContent).not.toContain('What are you having trouble with?');
        expect(document.body.textContent).not.toContain('Something to think about');
        unmount(app);
      }
    });
  });

  it('offers a passed submit’s optional points as worth a look, on their question', async () => {
    stubSubmit({
      passed: true,
      verdicts: [
        verdict('constraints_noted', ['inputs'], { verdict: 'PASS' }),
        // Problem has no optional point since criteria v10; Design's stands in for one. The
        // page reads a point's question and gate from the verdict, not its id.
        verdict('values_are_tracked', ['inputs'], { gate: 'advisory' })
      ],
      missing_ids: [],
      advisory_unmet: ['values_are_tracked']
    });
    const { session, app } = mountProblem('feedback-look');

    clickButton('Submit');
    await vi.waitFor(() => expect(session.phases[0].passed).toBe(true));
    clickButton('Inputs');
    flushSync();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Worth a look');
    expect(text).toContain('You should fix values_are_tracked.');
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
