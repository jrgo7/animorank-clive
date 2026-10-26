// @vitest-environment happy-dom
/**
 * The CLive windows, mounted for real (`npm run test:component`).
 *
 * This is the coverage the logic tests cannot give: writing `$state` from inside
 * a `$derived` or a template expression throws `state_unsafe_mutation` only when
 * a component tree is evaluating it. Looking a practice session up did exactly
 * that, because creating one writes state.
 */
import type { JsonValue } from '@zenstackhq/orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PhaseTrackWindow from './PhaseTrackWindow.window.svelte';
import ProblemWindow from './ProblemWindow.window.svelte';
import CaseDesignWindow from './CaseDesignWindow.window.svelte';
import AlgorithmDesignWindow from './AlgorithmDesignWindow.window.svelte';
import ImplementWindow from './ImplementWindow.window.svelte';
import { cliveSessionFor } from './cliveSession.svelte';
import { onResearcherKey } from './shortcuts';
import { CLIVE_WINDOW_KEYS, PROBLEM_INFO_WINDOW_KEY } from './phase';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

/** One entry a stub context's telemetry recorded. */
interface RecordedEntry {
  type: string;
  data: Record<string, unknown>;
}

/** What a stub context recorded: keys opened, the `keep` list of every close, and telemetry. */
interface WindowCalls {
  opened: string[];
  closed: (readonly string[])[];
  events?: RecordedEntry[];
}

function stubContext(id: string, calls?: WindowCalls): SolveWindowContext {
  return {
    problem: { id: 'problem-1' },
    practiceSession: { id, extension_data: {} },
    editorState: { code: 'int main(void) { return 0; }' },
    testCaseResults: { results: [], success: false },
    lastTestType: 'run',
    openWindow: (key: string) => {
      calls?.opened.push(key);
    },
    closeWindowsExcept: (keep: readonly string[]) => {
      calls?.closed.push(keep);
    },
    telemetry: {
      record: (type: string, data: Record<string, unknown> = {}) => {
        calls?.events?.push({ type, data });
      },
      flush: async () => {}
    }
  } as unknown as SolveWindowContext;
}

/**
 * Mount one phase's UI. Each phase is its own window component, mounted with
 * nothing but the context: `Window` types an entry as `Component<{ context }>`.
 */
function mountPhase(context: SolveWindowContext, phaseIndex: number): Record<string, unknown> {
  if (phaseIndex === 0) return mount(ProblemWindow, { target: document.body, props: { context } });
  if (phaseIndex === 1) return mount(CaseDesignWindow, { target: document.body, props: { context } });
  if (phaseIndex === 2) return mount(AlgorithmDesignWindow, { target: document.body, props: { context } });
  return mount(ImplementWindow, { target: document.body, props: { context } });
}

/** Click the first button whose text contains `label`. */
function clickButton(label: string): void {
  const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes(label));
  if (!button) throw new Error(`No button matching ${label}`);
  button.click();
}

const PHASES = [
  { id: 'problem_definition', label: 'Problem' },
  { id: 'case_design', label: 'Cases' },
  { id: 'algorithm_design', label: 'Design' },
  { id: 'implement', label: 'Implement' }
];

/**
 * The shape the plugin persists, with every phase's artifact holding none of the
 * fields that phase has -- a session saved before those fields existed.
 */
function missingFieldsState(): JsonValue {
  const phase = {
    artifact: {},
    attempt: 1,
    passed: false,
    advanced: false,
    unlocked: true,
    step: 0,
    added: 0,
    stepResults: {},
    result: null,
    stuck: [],
    stuckDraft: '',
    read: true
  };
  return { clive: { version: 1, current: 0, tutorialSeen: true, phases: [phase, phase, phase, phase] } };
}

describe('CLive windows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function stubBoot(): void {
    // The key gate asks the server once; nothing else in a mount reaches the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ hasApiKey: true, live_check: { available: false, fallback: '', table: [] } }), {
            status: 200
          })
      )
    );
  }

  it('shows the latest code feedback in Implement, one line per line', () => {
    stubBoot();
    const context = stubContext('mount-code-feedback');
    const session = cliveSessionFor(context);
    session.phases[3].unlocked = true;
    session.phases[3].codeFeedback = [
      { attempt: 1, runType: 'run', situation: 'departs_from_plan', focus: 'step 2', nudge: 'Line one\nLine two' }
    ];
    const app = mountPhase(context, 3);
    flushSync();
    expect(document.body.textContent).toContain('About your last Run');
    const lines = Array.from(document.querySelectorAll('[data-code-feedback-line]')).map((el) => el.textContent);
    expect(lines).toEqual(['Line one', 'Line two']);
    unmount(app);
  });

  it('opens the researcher override with the strip closed, and reopens the strip to show it', () => {
    stubBoot();
    const calls: WindowCalls = { opened: [], closed: [] };
    const context = stubContext('mount-override-key', calls);
    const session = cliveSessionFor(context);
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { ...init, cancelable: true });
    const press = key({ key: 'Y', ctrlKey: true, shiftKey: true });
    onResearcherKey(press, { context, session });
    expect(press.defaultPrevented).toBe(true);
    expect(session.overrideOpen).toBe(true);
    expect(calls.opened).toContain('clive:track');
    // The strip, opened afterwards, shows the dialog the key asked for.
    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();
    expect(document.querySelector('[aria-label="Researcher override"]')).not.toBeNull();
    onResearcherKey(key({ key: 'Escape' }), { context, session });
    flushSync();
    expect(document.querySelector('[aria-label="Researcher override"]')).toBeNull();
    unmount(app);
  });

  it('tags the session with a participant from the researcher dialog, even on the last phase', async () => {
    const asked: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/participant')) {
          asked.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ sessionId: 'mount-participant' }), { status: 200 });
        }
        return new Response(JSON.stringify({ hasApiKey: true }), { status: 200 });
      })
    );
    const context = stubContext('mount-participant');
    const session = cliveSessionFor(context);
    session.phases.forEach((phase) => (phase.unlocked = true));
    session.current = 3;
    session.overrideOpen = true;
    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();
    // No phase after Implement, so no move-on; the participant section is still there.
    expect(document.body.textContent).not.toContain('Move on to');
    const input = document.querySelector('[data-participant] input') as HTMLInputElement;
    input.value = 'P07';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    clickButton('Tag this session');
    await vi.waitFor(() => expect(session.participant).toBe('P07'));
    expect(asked).toEqual([
      { sessionId: 'mount-participant', problemId: 'problem-1', participant: 'P07', next: false }
    ]);
    expect(session.overrideOpen).toBe(false);
    unmount(app);
  });

  it('numbers Implement attempts by Run and Submit, not by replies', async () => {
    const attempts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/code-feedback')) {
          attempts.push((JSON.parse(String(init?.body)) as { attempt: number }).attempt);
          return new Response(JSON.stringify({ situation: 'other', summary: 's', focus: 'f', nudge: 'n' }), {
            status: 200
          });
        }
        return new Response(JSON.stringify({ hasApiKey: true }), { status: 200 });
      })
    );
    const context = stubContext('mount-code-attempts');
    const session = cliveSessionFor(context);
    session.phases.forEach((phase) => (phase.unlocked = true));
    const failing = {
      runType: 'run' as const,
      publicTestResults: [{ success: false, testCaseInfo: { public: false } }],
      submittedCode: 'x'
    };
    const passing = {
      runType: 'run' as const,
      publicTestResults: [{ success: true, testCaseInfo: { public: false } }],
      submittedCode: 'x'
    };
    // Two Runs before either reply is back, then a passing Run, then a failing Submit.
    const first = session.codeRan(context, failing);
    const second = session.codeRan(context, failing);
    await Promise.all([first, second]);
    await session.codeRan(context, passing);
    await session.codeRan(context, { ...failing, runType: 'submit' });
    expect(attempts).toEqual([1, 2, 4]);
  });

  it('shows the student their own Design, numbered, while they write the code', () => {
    stubBoot();
    const context = stubContext('design-panel');
    const session = cliveSessionFor(context);
    session.phases[3].unlocked = true;
    session.phases[2].artifact.steps = [
      { text: 'Read the two numbers.', level: 0 },
      { text: 'Split the guest number into three sections.', level: 0 },
      { text: 'Sum the digits of each section.', level: 1 }
    ];
    const app = mountPhase(context, 3);
    flushSync();
    const panel = document.querySelector('[data-design-panel]');
    expect(panel?.textContent).toContain('Your design');
    const rows = Array.from(panel?.querySelectorAll('[data-design-step]') ?? []).map((el) =>
      el.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(rows).toEqual([
      '1. Read the two numbers.',
      '2. Split the guest number into three sections.',
      'a. Sum the digits of each section.'
    ]);
    unmount(app);
  });

  it('marks the box of the case the feedback is about', () => {
    stubBoot();
    const context = stubContext('case-part');
    const session = cliveSessionFor(context);
    session.phases[1].unlocked = true;
    session.current = 1;
    session.phases[1].stepResults.normal_cases = {
      passed: false,
      attempt: 2,
      result: {
        passed: false,
        verdicts: [],
        missing_ids: [],
        advisory_unmet: [],
        nudge: {
          summary: 's',
          nudge: 'Which numbers?',
          reason: 'r',
          focus_id: 'work_is_shown',
          focus_text: 'You show how you got the expected output.',
          focus_not_met: 'Show the numbers.',
          focus_fields: ['normal_cases'],
          failing: [{ id: 'work_is_shown', text: 'You show how you got the expected output.' }]
        }
      }
    };
    const app = mountPhase(context, 1);
    flushSync();
    const flagged = Array.from(document.querySelectorAll('[data-case-part-flagged]')).map((el) =>
      el.getAttribute('aria-label')
    );
    expect(flagged).toEqual(['How I got it, Case 1']);
    unmount(app);
  });

  it('says so when there is no design to show yet', () => {
    stubBoot();
    const context = stubContext('design-panel-empty');
    const session = cliveSessionFor(context);
    session.phases[3].unlocked = true;
    const app = mountPhase(context, 3);
    flushSync();
    expect(document.querySelector('[data-design-panel]')?.textContent).toContain("You haven't written a design yet.");
    unmount(app);
  });

  it('moves a stuck student on to the next phase, recorded as an override', () => {
    stubBoot();
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const context = stubContext('override-move', { opened: [], closed: [], events });
    const session = cliveSessionFor(context);
    session.moveOn(0, 'stuck');
    expect(session.phases[0].advanced).toBe(true);
    expect(session.phases[1].unlocked).toBe(true);
    expect(session.current).toBe(1);
    expect(events.filter((e) => e.type === 'CLIVE_RESEARCHER_OVERRIDE')).toEqual([
      {
        type: 'CLIVE_RESEARCHER_OVERRIDE',
        data: { from_phase: 'problem_definition', to_phase: 'case_design', attempt: 1, reason: 'stuck' }
      }
    ]);
  });

  it('does not override a phase already passed', () => {
    stubBoot();
    const context = stubContext('override-passed');
    const session = cliveSessionFor(context);
    session.pass(0);
    session.moveOn(0, 'x');
    expect(session.phases[0].advanced).toBe(false);
    expect(session.current).toBe(0);
  });

  it('shows an overridden phase as moved on, and a red badge when the session is not logging', () => {
    stubBoot();
    const context = stubContext('override-strip');
    const session = cliveSessionFor(context);
    session.moveOn(0, '');
    session.logging = { ok: false, reason: 'database down' };
    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();
    expect(document.body.textContent).toContain('Moved on');
    const badge = Array.from(document.querySelectorAll('[title]')).find((el) =>
      el.textContent?.includes('NOT LOGGING')
    );
    expect(badge?.getAttribute('title')).toBe('database down');
    unmount(app);
  });

  it('mounts every phase window without writing state from a derived', () => {
    stubBoot();

    PHASES.forEach((phase, index) => {
      const context = stubContext(`mount-${phase.id}`);
      // The first phase opens on its statement alone; this test is about mounting each
      // window, so step past the opening (its own test is below).
      cliveSessionFor(context).phases[0].read = true;
      const app = mountPhase(context, index);
      expect(document.body.textContent, phase.id).toContain(phase.label);
      unmount(app);
    });
  });

  it('opens a phase whose saved work is missing its fields', () => {
    stubBoot();
    const context = stubContext('mount-empty-artifact');
    // Binding a field editor to a field the saved artifact does not hold threw as
    // the window opened, which took the page hook down with it.
    context.practiceSession.extension_data = missingFieldsState();

    const app = mountPhase(context, 0);
    const area = document.querySelector('textarea');
    expect(area).not.toBeNull();
    expect(area?.value).toBe('');
    unmount(app);
  });

  it('opens a problem on a pointer to its statement, with Next to the first question', () => {
    stubBoot();
    const context = stubContext('mount-focus');
    const session = cliveSessionFor(context);
    session.phases[0].unlocked = true;
    session.phases[0].read = false;

    const app = mountPhase(context, 0);
    flushSync();

    // A pointer to the Problem Info tab, and nothing to answer yet. The statement itself
    // lives in that tab, so the phase does not render it.
    expect(document.body.textContent).toContain('Read the problem in the Problem Info tab');
    expect(document.body.textContent).not.toContain('Loading Markdown');
    expect(document.body.textContent).not.toContain('what is the program supposed to do?');

    clickButton('Next');
    flushSync();
    expect(document.body.textContent).toContain('what is the program supposed to do?');
    expect(session.phases[0].read).toBe(true);
    unmount(app);
  });

  it('mounts a phase for a practice session that already has one', () => {
    stubBoot();
    const context = stubContext('mount-existing');

    const first = mountPhase(context, 1);
    unmount(first);
    // Second mount: the session is found rather than created, and is the same one.
    const second = mountPhase(context, 1);
    expect(document.body.textContent).toContain('Cases');
    unmount(second);
  });

  it('takes the page over, showing the editor only while Implement is open', () => {
    stubBoot();
    const calls: WindowCalls = { opened: [], closed: [] };
    const context = stubContext('mount-layout', calls);
    // This test is about the layout, not the walkthrough that a first visit offers.
    cliveSessionFor(context).tutorialSeen = true;

    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();

    // The tracker itself renders while it runs the takeover.
    expect(document.body.textContent).toContain('In progress');
    expect(document.body.textContent).toContain('Locked');

    // On load, the statement and CLive's own windows are what survives.
    expect(calls.closed.at(-1)).toEqual([PROBLEM_INFO_WINDOW_KEY, ...CLIVE_WINDOW_KEYS]);
    expect(calls.opened).not.toContain('code_editor');

    // Entering Implement brings the code editor and the test cases back.
    const session = cliveSessionFor(context);
    session.phases[3].unlocked = true;
    session.open(3);
    flushSync();
    expect(calls.closed.at(-1)).toContain('code_editor');
    expect(calls.closed.at(-1)).toContain('test_cases');
    expect(calls.opened).toContain('code_editor');
    expect(calls.opened).toContain('test_cases');

    // Leaving it takes them away again, keeping the statement.
    session.open(0);
    flushSync();
    expect(calls.closed.at(-1)).toEqual([PROBLEM_INFO_WINDOW_KEY, ...CLIVE_WINDOW_KEYS]);

    unmount(app);
  });

  it('offers the walkthrough on a first visit, and remembers it was dismissed', () => {
    stubBoot();
    const context = stubContext('mount-tutorial');

    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();

    expect(document.body.textContent).toContain('1 of 7');
    expect(document.body.textContent).toContain('Four phases');

    // The page stays put behind the cards: a wheel over them is not the student
    // scrolling the phase strip away underneath.
    const overlay = document.querySelector('[role="dialog"]');
    if (!overlay) throw new Error('no walkthrough overlay');
    const wheel = new Event('wheel', { bubbles: true, cancelable: true });
    overlay.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);

    clickButton('Skip');
    flushSync();
    expect(document.body.textContent).not.toContain('1 of 7');
    expect(cliveSessionFor(context).tutorialSeen).toBe(true);
    unmount(app);
  });

  it('offers nothing to a session that has seen it, and walks the cards when reopened', () => {
    stubBoot();
    const context = stubContext('mount-tutorial-walk');
    cliveSessionFor(context).tutorialSeen = true;

    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();
    expect(document.body.textContent).not.toContain('1 of 7');

    clickButton('How this works');
    flushSync();
    expect(document.body.textContent).toContain('Four phases');

    clickButton('Next');
    flushSync();
    expect(document.body.textContent).toContain('2 of 7');
    expect(document.body.textContent).toContain('First, understand the problem.');

    clickButton('Previous');
    flushSync();
    expect(document.body.textContent).toContain('1 of 7');
    unmount(app);
  });

  it('records the page load and a phase opened from the strip', () => {
    stubBoot();
    const calls: WindowCalls = { opened: [], closed: [], events: [] };
    const context = stubContext('mount-telemetry-load', calls);
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[1].unlocked = true;

    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();

    expect(calls.events).toContainEqual({
      type: 'CLIVE_PROBLEM_LOAD',
      data: { problem: 'problem-1', restored: false, phase: 'problem_definition' }
    });

    clickButton('Cases');
    flushSync();
    expect(calls.events).toContainEqual({
      type: 'CLIVE_PHASE_OPEN',
      data: { phase: 'case_design', via: 'track' }
    });
    unmount(app);
  });

  it('records the statement being read, and the way on to the next phase', () => {
    stubBoot();
    const calls: WindowCalls = { opened: [], closed: [], events: [] };
    const context = stubContext('mount-telemetry-read', calls);
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;

    const app = mountPhase(context, 0);
    flushSync();
    clickButton('Next');
    flushSync();
    expect(calls.events).toContainEqual({
      type: 'CLIVE_PROBLEM_READ',
      data: { phase: 'problem_definition' }
    });

    // Passing the phase and taking the way on records the phase it opened.
    session.pass(0);
    flushSync();
    clickButton('Continue to Cases');
    flushSync();
    expect(calls.events).toContainEqual({
      type: 'CLIVE_PHASE_OPEN',
      data: { phase: 'case_design', via: 'continue' }
    });
    unmount(app);
  });

  it('sends the practice session with a submission and a stuck ask, and records the case changes', async () => {
    const calls: WindowCalls = { opened: [], closed: [], events: [] };
    const context = stubContext('mount-telemetry-phase', calls);
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[1].unlocked = true;

    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith('/boot')) return new Response(JSON.stringify({ hasApiKey: true }), { status: 200 });
      if (path.endsWith('/submit')) {
        return new Response(
          JSON.stringify({
            passed: false,
            verdicts: [
              {
                criterion_id: 'case_is_concrete',
                criterion_text: 't',
                not_met: 'n',
                verdict: 'FAIL',
                gate: 'gating',
                explain: 'e',
                recheck: []
              }
            ],
            missing_ids: [],
            advisory_unmet: []
          }),
          { status: 200 }
        );
      }
      if (path.endsWith('/stuck')) return new Response(JSON.stringify({ feedback: 'f' }), { status: 200 });
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    /** The JSON body of the last request sent to `path`. */
    const sent = (path: string) => {
      const call = fetchMock.mock.calls.findLast(([url]) => String(url).endsWith(path)) as
        | [RequestInfo | URL, RequestInit]
        | undefined;
      return call ? JSON.parse(call[1].body as string) : undefined;
    };

    const app = mountPhase(context, 1);
    flushSync();

    // A case has to hold something before Submit is offered.
    session.phases[1].artifact.normal_cases = [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }];
    flushSync();
    clickButton('Submit');
    await vi.waitFor(() => expect(session.phases[1].stepResults.normal_cases).toBeDefined());
    // The server records the submission in this practice session; the page records nothing of its own.
    expect(sent('/submit')).toMatchObject({ sessionId: 'mount-telemetry-phase', phase: 'case_design' });
    expect(calls.events?.some((e) => e.type === 'CLIVE_SUBMIT')).toBe(false);

    session.phases[1].stuckDraft = 'I do not get the leftover.';
    flushSync();
    clickButton("I'm stuck");
    flushSync();
    clickButton('Ask');
    await vi.waitFor(() => expect(session.phases[1].stuck).toHaveLength(1));
    expect(sent('/stuck')).toMatchObject({
      sessionId: 'mount-telemetry-phase',
      statement: 'I do not get the leftover.'
    });
    expect(calls.events?.some((e) => e.type === 'CLIVE_STUCK')).toBe(false);

    // Both required cases passing offers another; adding and removing one is recorded.
    session.phases[1].stepResults = {
      normal_cases: { result: null, passed: true, attempt: 1 },
      edge_cases: { result: null, passed: true, attempt: 1 }
    };
    flushSync();
    clickButton('Add another case');
    flushSync();
    expect(calls.events).toContainEqual({
      type: 'CLIVE_CASE_ADDED',
      data: { phase: 'case_design', cases: 3 }
    });

    clickButton('Remove this case');
    flushSync();
    expect(calls.events).toContainEqual({
      type: 'CLIVE_CASE_REMOVED',
      data: { phase: 'case_design', cases: 2 }
    });
    unmount(app);
  });
});
