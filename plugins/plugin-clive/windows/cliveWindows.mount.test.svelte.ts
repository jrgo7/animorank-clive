// @vitest-environment happy-dom
/**
 * The CLive windows, mounted for real (`npm run test:component`).
 *
 * This is the coverage the logic tests cannot give: writing `$state` from inside
 * a `$derived` or a template expression throws `state_unsafe_mutation` only when
 * a component tree is evaluating it. Looking a practice session up did exactly
 * that, because creating one writes state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PhaseTrackWindow from './PhaseTrackWindow.window.svelte';
import PhaseWindowContent from './PhaseWindowContent.svelte';
import { cliveSessionFor } from './cliveSession.svelte';
import { CLIVE_WINDOW_KEYS } from './phase';
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

function mountPhase(context: SolveWindowContext, phaseIndex: number): Record<string, unknown> {
  return mount(PhaseWindowContent, { target: document.body, props: { context, phaseIndex } });
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

describe('CLive windows', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function stubBoot(): void {
    // The key gate asks the server once; nothing else in a mount reaches the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ hasApiKey: true }), { status: 200 }))
    );
  }

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

  it('opens a problem on its statement alone, with Next to the first question', () => {
    stubBoot();
    const context = stubContext('mount-focus');
    const session = cliveSessionFor(context);
    session.phases[0].unlocked = true;
    session.phases[0].read = false;

    const app = mountPhase(context, 0);
    flushSync();

    // The statement, and nothing to answer yet. The markdown editor that renders the
    // description never loads in the test environment, so its placeholder is what can be
    // observed here; the focus row is the plugin's own text.
    expect(document.body.textContent).toContain('Take your time with the problem');
    expect(document.body.textContent).toContain('Loading Markdown');
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

    // On load, only CLive's own windows survive.
    expect(calls.closed.at(-1)).toEqual(CLIVE_WINDOW_KEYS);
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

    // Leaving it takes them away again.
    session.open(0);
    flushSync();
    expect(calls.closed.at(-1)).toEqual(CLIVE_WINDOW_KEYS);

    unmount(app);
  });

  it('offers the walkthrough on a first visit, and remembers it was dismissed', () => {
    stubBoot();
    const context = stubContext('mount-tutorial');

    const app = mount(PhaseTrackWindow, { target: document.body, props: { context } });
    flushSync();

    expect(document.body.textContent).toContain('1 of 7');
    expect(document.body.textContent).toContain('Four phases');

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
      data: { problem: 'problem-1', restored: false }
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

  it('records a submission, a stuck ask and the case changes', async () => {
    const calls: WindowCalls = { opened: [], closed: [], events: [] };
    const context = stubContext('mount-telemetry-phase', calls);
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[1].unlocked = true;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
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
      })
    );

    const app = mountPhase(context, 1);
    flushSync();

    // A case has to hold something before Submit is offered.
    session.phases[1].artifact.normal_cases = [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }];
    flushSync();
    clickButton('Submit');
    await vi.waitFor(() => expect(calls.events?.some((e) => e.type === 'CLIVE_SUBMIT')).toBe(true));
    expect(calls.events).toContainEqual({
      type: 'CLIVE_SUBMIT',
      data: {
        phase: 'case_design',
        step: 'normal_cases',
        attempt: 1,
        passed: false,
        blocking: ['case_is_concrete'],
        advisory_unmet: [],
        missing_ids: []
      }
    });

    session.phases[1].stuckDraft = 'I do not get the leftover.';
    flushSync();
    clickButton("I'm stuck");
    flushSync();
    clickButton('Ask');
    await vi.waitFor(() => expect(calls.events?.some((e) => e.type === 'CLIVE_STUCK')).toBe(true));
    expect(calls.events).toContainEqual({
      type: 'CLIVE_STUCK',
      data: { phase: 'case_design', field: null, statement: 'I do not get the leftover.' }
    });

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
