// @vitest-environment happy-dom
/**
 * Going back to the version that passed.
 *
 * A passed phase stays editable, and a failed resubmit never takes the pass away:
 * the later phases keep being judged against the version that last passed
 * (`passedArtifact`). After a failed resubmit the work on screen and the work the
 * later judges read have parted, so the student can put the passing version back.
 * Problem and Design go back as a whole, since they are judged as a whole; a case
 * goes back on its own. Implement has no such copy: its code lives in AnimoRank's
 * own editor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ProblemWindow from './ProblemWindow.window.svelte';
import CaseDesignWindow from './CaseDesignWindow.window.svelte';
import AlgorithmDesignWindow from './AlgorithmDesignWindow.window.svelte';
import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

const PASS: JudgeResult = { passed: true, verdicts: [], missing_ids: [], advisory_unmet: [] };
const FAIL: JudgeResult = { passed: false, verdicts: [], missing_ids: [], advisory_unmet: [] };

/** A failed submit with one required point on `field`, which the page shows as that line. */
function failOn(field: string, line: string): JudgeResult {
  return {
    passed: false,
    verdicts: [{ criterion_id: 'some_requirement', verdict: 'FAIL', gate: 'gating', fields: [field], explain: line }],
    missing_ids: [],
    advisory_unmet: []
  };
}

const RESTORE = 'Latest Passing';

function stubContext(id: string, record: (_type: string, _data: unknown) => void = () => {}): SolveWindowContext {
  return {
    problem: { id: 'problem-1' },
    practiceSession: { id, extension_data: {} },
    editorState: { code: '' },
    testCaseResults: { results: [], success: false },
    lastTestType: 'run',
    openWindow: () => {},
    closeWindowsExcept: () => {},
    telemetry: { record, flush: async () => {} }
  } as unknown as SolveWindowContext;
}

/** Every request answered: `/boot` with a key, a save with OK. Returns the spy to read saves from. */
function stubFetch() {
  const spy = vi.fn<[url: RequestInfo | URL, init?: RequestInit], Promise<Response>>(async (url) => {
    if (String(url).endsWith('/boot')) return new Response(JSON.stringify({ hasApiKey: true }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

type Session = ReturnType<typeof cliveSessionFor>;

function fillProblem(session: Session): void {
  session.phases[0].artifact.summary = 'Return the nth prime.';
  session.phases[0].artifact.inputs = 'n, an int from 1 to 999';
  session.phases[0].artifact.outputs = 'the nth prime as an int';
}

/** Problem passed, then two answers changed and the resubmit failed. */
function problemFailedAfterPass(session: Session, result: JudgeResult = FAIL): void {
  fillProblem(session);
  session.recordResult(0, PASS);
  session.phases[0].artifact.summary = 'Print the nth prime.';
  session.phases[0].artifact.inputs = 'n, an int from 1 to 900';
  session.recordResult(0, result);
}

/** Case 1 passed, then its output changed and the resubmit failed. */
function caseFailedAfterPass(session: Session, result: JudgeResult = FAIL): void {
  session.phases[1].artifact.normal_cases = [{ input: '4', output: '7', working: '2, 3, 5, 7: the 4th is 7.' }];
  session.completeStep(1, 'normal_cases', PASS);
  (session.phases[1].artifact.normal_cases as { output: string }[])[0].output = '9';
  session.completeStep(1, 'normal_cases', result);
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes(label));
}

describe('going back to the version that passed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('puts every Problem answer back as it passed, and drops the failed result', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('restore-problem'));
    problemFailedAfterPass(session);

    expect(session.canRestore(0, 'phase')).toBe(true);
    session.restorePassed(0, 'phase');

    expect(session.phases[0].artifact).toEqual({
      summary: 'Return the nth prime.',
      inputs: 'n, an int from 1 to 999',
      outputs: 'the nth prime as an int'
    });
    expect(session.phases[0].result).toBeNull();
    expect(session.phases[0].passed).toBe(true);
    expect(session.canRestore(0, 'phase')).toBe(false);
  });

  it('is not offered for work that never passed', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('restore-never-passed'));
    fillProblem(session);
    session.recordResult(0, FAIL);

    expect(session.canRestore(0, 'phase')).toBe(false);
    session.restorePassed(0, 'phase');
    expect(session.phases[0].artifact.summary).toBe('Return the nth prime.');
  });

  it('is not offered while the latest submit passed', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('restore-latest-passed'));
    fillProblem(session);
    session.recordResult(0, PASS);
    session.phases[0].artifact.summary = 'Print the nth prime.';

    expect(session.canRestore(0, 'phase')).toBe(false);
  });

  it('puts a case back as a copy, so typing into it afterwards leaves the passing version alone', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('restore-case-copy'));
    caseFailedAfterPass(session);

    expect(session.canRestore(1, 'normal_cases')).toBe(true);
    session.restorePassed(1, 'normal_cases');
    expect(session.phases[1].artifact.normal_cases).toEqual([
      { input: '4', output: '7', working: '2, 3, 5, 7: the 4th is 7.' }
    ]);
    expect(session.phases[1].stepResults.normal_cases.result).toBeNull();

    // The case boxes bind to the row's own properties, so typing mutates the row.
    (session.phases[1].artifact.normal_cases as { output: string }[])[0].output = '11';
    expect(session.priorArtifacts(2)[0].fields[0].value).toEqual([
      { input: '4', output: '7', working: '2, 3, 5, 7: the 4th is 7.' }
    ]);
  });

  it('leaves the other cases as they are', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('restore-case-alone'));
    caseFailedAfterPass(session);
    session.phases[1].artifact.edge_cases = [{ input: '1', output: '2', working: 'The first prime is 2.' }];
    session.completeStep(1, 'edge_cases', PASS);
    (session.phases[1].artifact.edge_cases as { output: string }[])[0].output = '3';
    session.completeStep(1, 'edge_cases', FAIL);

    session.restorePassed(1, 'normal_cases');

    expect(session.phases[1].artifact.edge_cases).toEqual([
      { input: '1', output: '3', working: 'The first prime is 2.' }
    ]);
    expect(session.phases[1].stepResults.edge_cases.result).toEqual(FAIL);
    expect(session.canRestore(1, 'edge_cases')).toBe(true);
  });

  it('records the restore in the session log, with the case it was', () => {
    stubFetch();
    const record = vi.fn();
    const session = cliveSessionFor(stubContext('restore-logged', record));
    problemFailedAfterPass(session);
    caseFailedAfterPass(session);

    session.restorePassed(0, 'phase');
    session.restorePassed(1, 'normal_cases');

    expect(record.mock.calls).toEqual([
      ['CLIVE_RESTORE_PASSED', { phase: 'problem_definition', step: null }],
      ['CLIVE_RESTORE_PASSED', { phase: 'case_design', step: 'normal_cases' }]
    ]);
  });

  it('is saved, so a reload keeps the restored work', async () => {
    const fetchSpy = stubFetch();
    const session = cliveSessionFor(stubContext('restore-saved'));
    problemFailedAfterPass(session);

    session.restorePassed(0, 'phase');

    const save = await vi.waitFor(() => {
      const call = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PUT');
      if (!call) throw new Error('not saved yet');
      return call;
    });
    const saved = JSON.parse(String(save[1]?.body)).extension_data.clive;
    expect(saved.phases[0].artifact.inputs).toBe('n, an int from 1 to 999');
    expect(saved.phases[0].result).toBeNull();
  });
});

describe('the button that goes back', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows on Problem after a failed resubmit and puts the passing answers on screen', () => {
    stubFetch();
    const context = stubContext('restore-problem-window');
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[0].read = true;
    fillProblem(session);
    session.recordResult(0, PASS);
    session.phases[0].artifact.summary = 'Print the nth prime.';
    const app = mount(ProblemWindow, { target: document.body, props: { context } });
    flushSync();

    // Edited but not yet resubmitted: nothing to go back from.
    expect(buttonLabelled(RESTORE)).toBeUndefined();

    session.recordResult(0, failOn('summary', 'Say what the function hands back.'));
    flushSync();
    expect(document.body.textContent).toContain('Say what the function hands back.');

    buttonLabelled(RESTORE)!.click();
    flushSync();

    expect(document.querySelector('textarea')?.value).toBe('Return the nth prime.');
    expect(document.body.textContent).not.toContain('Say what the function hands back.');
    expect(buttonLabelled(RESTORE)).toBeUndefined();
    unmount(app);
  });

  it('shows on a case after a failed resubmit and puts the passing case on screen', () => {
    stubFetch();
    const context = stubContext('restore-cases-window');
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[1].unlocked = true;
    caseFailedAfterPass(session, failOn('normal_cases', 'Trace the case again.'));
    const app = mount(CaseDesignWindow, { target: document.body, props: { context } });
    flushSync();

    const output = () =>
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Expected output, Case 1"]')?.value;
    expect(output()).toBe('9');

    buttonLabelled(RESTORE)!.click();
    flushSync();

    expect(output()).toBe('7');
    expect(document.body.textContent).not.toContain('Trace the case again.');
    expect(buttonLabelled(RESTORE)).toBeUndefined();
    unmount(app);
  });

  it('shows on Design after a failed resubmit and puts the passing steps on screen', () => {
    stubFetch();
    const context = stubContext('restore-design-window');
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    const design = session.phases[2];
    design.unlocked = true;
    design.artifact.steps = [
      { text: 'Count primes from 2.', level: 0 },
      { text: 'Return the nth one.', level: 0 }
    ];
    session.recordResult(2, PASS);
    design.artifact.steps = [{ text: 'Return n.', level: 0 }];
    session.recordResult(2, failOn('steps', 'Walk through your case with these steps.'));
    const app = mount(AlgorithmDesignWindow, { target: document.body, props: { context } });
    flushSync();

    buttonLabelled(RESTORE)!.click();
    flushSync();

    const steps = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label^="Step"]'));
    expect(steps.map((el) => el.value)).toEqual(['Count primes from 2.', 'Return the nth one.']);
    expect(document.body.textContent).not.toContain('Walk through your case with these steps.');
    unmount(app);
  });
});
