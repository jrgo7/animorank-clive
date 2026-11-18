// @vitest-environment happy-dom
/**
 * What a later phase's judge is shown of the earlier ones (`priorArtifacts`).
 *
 * Passed phases stay editable, so a student can go back and erase or break a field
 * after it passed. The later judge measures its phase against the earlier work --
 * Design traces the student's own case, Implement follows the student's own plan --
 * so it is handed the version of each field that last passed, not whatever the box
 * holds now. Work that never passed (a researcher's move-on) is carried as it stands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CaseDesignWindow from './CaseDesignWindow.window.svelte';
import { cliveSessionFor, type JudgeResult } from './cliveSession.svelte';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

const PASS: JudgeResult = { passed: true, verdicts: [], missing_ids: [], advisory_unmet: [] };
const FAIL: JudgeResult = { passed: false, verdicts: [], missing_ids: [], advisory_unmet: [] };

function stubContext(id: string, extensionData: Record<string, unknown> = {}): SolveWindowContext {
  return {
    problem: { id: 'problem-1' },
    practiceSession: { id, extension_data: extensionData },
    editorState: { code: '' },
    testCaseResults: { results: [], success: false },
    lastTestType: 'run',
    openWindow: () => {},
    closeWindowsExcept: () => {},
    telemetry: { record: () => {}, flush: async () => {} }
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

function fillProblem(session: ReturnType<typeof cliveSessionFor>, summary: string): void {
  session.phases[0].artifact.summary = summary;
  session.phases[0].artifact.inputs = 'length then width, each an int from 1 to 100';
  session.phases[0].artifact.outputs = 'the area as an int';
}

describe('the earlier work a later phase is judged against', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the version that passed, even after the student erases it', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('carry-erased'));
    fillProblem(session, 'Find the area of a rectangle.');
    session.recordResult(0, PASS);

    session.phases[0].artifact.summary = '';

    expect(session.priorArtifacts(1)).toEqual([
      {
        label: 'Problem',
        fields: [
          { label: 'Summary', value: 'Find the area of a rectangle.' },
          { label: 'Inputs', value: 'length then width, each an int from 1 to 100' },
          { label: 'Outputs', value: 'the area as an int' }
        ]
      }
    ]);
  });

  it('keeps the passing version when an edited resubmit fails', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('carry-failed-resubmit'));
    fillProblem(session, 'Find the area of a rectangle.');
    session.recordResult(0, PASS);

    session.phases[0].artifact.summary = 'The program reads two numbers and prints them.';
    session.recordResult(0, FAIL);

    expect(session.priorArtifacts(1)[0].fields[0]).toEqual({
      label: 'Summary',
      value: 'Find the area of a rectangle.'
    });
  });

  it('moves to the newer version when an edited resubmit passes', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('carry-passed-resubmit'));
    fillProblem(session, 'Find the area of a rectangle.');
    session.recordResult(0, PASS);

    session.phases[0].artifact.summary = 'Multiply the length by the width and print it.';
    session.recordResult(0, PASS);
    session.phases[0].artifact.summary = '';

    expect(session.priorArtifacts(1)[0].fields[0]).toEqual({
      label: 'Summary',
      value: 'Multiply the length by the width and print it.'
    });
  });

  it('keeps a case as it passed when its row is edited in place afterwards', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('carry-case-row'));
    session.phases[1].artifact.normal_cases = [{ input: '4 6', output: '24', working: '4 * 6 = 24' }];
    session.completeStep(1, 'normal_cases', PASS);

    // The case boxes bind to the row's own properties, so an edit mutates the row.
    (session.phases[1].artifact.normal_cases as { output: string }[])[0].output = '25';

    expect(session.priorArtifacts(2)).toEqual([
      {
        label: 'Cases',
        fields: [{ label: 'Case 1', value: [{ input: '4 6', output: '24', working: '4 * 6 = 24' }] }]
      }
    ]);
  });

  it('carries work that never passed as it stands', () => {
    stubFetch();
    const session = cliveSessionFor(stubContext('carry-never-passed'));
    fillProblem(session, 'Find the area of a rectangle.');

    expect(session.priorArtifacts(1)[0].fields[0]).toEqual({
      label: 'Summary',
      value: 'Find the area of a rectangle.'
    });
  });

  it('remembers the passing version across a reload', async () => {
    const fetchSpy = stubFetch();
    const first = cliveSessionFor(stubContext('carry-reload-a'));
    fillProblem(first, 'Find the area of a rectangle.');
    first.recordResult(0, PASS);
    first.phases[0].artifact.summary = '';
    first.persist();

    const save = await vi.waitFor(() => {
      const call = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PUT');
      if (!call) throw new Error('not saved yet');
      return call;
    });
    const saved = JSON.parse(String(save[1]?.body)).extension_data;

    const reloaded = cliveSessionFor(stubContext('carry-reload-b', saved));

    expect(reloaded.phases[0].artifact.summary).toBe('');
    expect(reloaded.priorArtifacts(1)[0].fields[0]).toEqual({
      label: 'Summary',
      value: 'Find the area of a rectangle.'
    });
  });
});

describe('an extra case the student removes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function clickButton(label: string): void {
    const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes(label));
    if (!button) throw new Error(`No button matching ${label}`);
    button.click();
  }

  it('is not carried forward when a new one is added in its place', () => {
    stubFetch();
    const context = stubContext('carry-removed-case');
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    const cases = session.phases[1];
    cases.unlocked = true;
    cases.artifact.normal_cases = [{ input: '4 6', output: '24', working: '4 * 6 = 24' }];
    session.completeStep(1, 'normal_cases', PASS);
    cases.artifact.edge_cases = [{ input: '1 1', output: '1', working: '1 * 1 = 1' }];
    session.completeStep(1, 'edge_cases', PASS);
    cases.added = 1;
    cases.artifact.case_3 = [{ input: '100 100', output: '10000', working: '100 * 100 = 10000' }];
    session.completeStep(1, 'case_3', PASS);
    cases.step = 2;
    const app = mount(CaseDesignWindow, { target: document.body, props: { context } });
    flushSync();

    clickButton('Remove this case');
    flushSync();
    clickButton('Add another case');
    flushSync();

    expect(session.priorArtifacts(2)).toEqual([
      {
        label: 'Cases',
        fields: [
          { label: 'Case 1', value: [{ input: '4 6', output: '24', working: '4 * 6 = 24' }] },
          { label: 'Case 2', value: [{ input: '1 1', output: '1', working: '1 * 1 = 1' }] }
        ]
      }
    ]);
    unmount(app);
  });
});
