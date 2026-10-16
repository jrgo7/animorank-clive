// @vitest-environment happy-dom
/**
 * Filling in one case, the way a student does. Submit used to wait for the
 * expected output *and* "How I got it" on every case, so a case with an input
 * alone left the button dead with nothing on screen saying what was missing.
 * Now a case submits as soon as it holds anything, and the rubric — whose
 * `case_is_concrete` and `work_is_shown` are both gating — says what is missing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CaseDesignWindow from './CaseDesignWindow.window.svelte';
import { cliveSessionFor } from './cliveSession.svelte';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

function stubContext(id: string): SolveWindowContext {
  return {
    problem: { id: 'problem-1' },
    practiceSession: { id, extension_data: {} },
    editorState: { code: '' },
    testCaseResults: { results: [], success: false },
    lastTestType: 'run',
    openWindow: () => {},
    closeWindowsExcept: () => {},
    telemetry: { record: () => {}, flush: async () => {} }
  } as unknown as SolveWindowContext;
}

/** Type into a box the way a student does: set the value, then fire its input event. */
function type(ariaLabel: string, text: string): void {
  const box = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${ariaLabel}"]`);
  if (!box) throw new Error(`no textarea labelled ${ariaLabel}`);
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickButton(label: string): void {
  const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes(label));
  if (!button) throw new Error(`No button matching ${label}`);
  button.click();
}

function submitButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes('Submit'));
}

describe('filling in a case', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function stubPassing(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const path = String(url);
        if (path.endsWith('/boot')) return new Response(JSON.stringify({ hasApiKey: true }), { status: 200 });
        return new Response(JSON.stringify({ passed: true, verdicts: [], missing_ids: [], advisory_unmet: [] }), {
          status: 200
        });
      })
    );
  }

  function mountCases(id: string) {
    const context = stubContext(id);
    const session = cliveSessionFor(context);
    session.tutorialSeen = true;
    session.phases[1].unlocked = true;
    const app = mount(CaseDesignWindow, { target: document.body, props: { context } });
    flushSync();
    return { context, session, app };
  }

  it('submits as soon as the case holds anything, and then walks on', async () => {
    stubPassing();
    const { session, app } = mountCases('cases-submit');

    // Nothing typed yet: nothing to judge.
    expect(submitButton()?.disabled).toBe(true);

    type('Input, Case 1', '4 6');
    flushSync();
    expect(session.phases[1].artifact.normal_cases).toEqual([{ input: '4 6', output: '', working: '' }]);
    expect(submitButton()?.disabled).toBe(false);

    clickButton('Submit');
    await vi.waitFor(() => expect(session.stateFor(1, 'normal_cases').passed).toBe(true));
    // Case 1 passing is what opens Case 2.
    expect(document.body.textContent).toContain('Case 2');
    unmount(app);
  });

  it('still refuses a case whose input repeats an earlier one', () => {
    stubPassing();
    const { session, app } = mountCases('cases-duplicate');

    session.phases[1].artifact.normal_cases = [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }];
    session.phases[1].stepResults = { normal_cases: { result: null, passed: true, attempt: 1 } };
    flushSync();

    clickButton('Case 2');
    flushSync();
    // Whitespace does not make two inputs different.
    type('Input, Case 2', ' 4   6 ');
    flushSync();

    expect(submitButton()?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Use a different input from Case 1.');
    unmount(app);
  });
});
