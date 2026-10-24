// @vitest-environment happy-dom
/**
 * `DockviewWindowManager.closeWindowsExcept` against a real dockview, in a DOM.
 * The stub-context tests in `cliveWindows.mount.test.svelte.ts` cover what the
 * plugin asks for; this covers that the manager actually does it — and that a
 * closed window is reopened as the same one, which is what lets CLive close the
 * code editor outside the Implement phase and get it back inside it.
 */
import { describe, expect, it } from 'vitest';
import { DockviewWindowManager } from '$lib/window/dockviewWindowManager';
import { WindowRegistry } from '$lib/window/windowRegistry';
import { PhaseTrackWindow } from './PhaseTrackWindow.window';
import { ProblemWindow } from './ProblemWindow.window';
import { cliveSessionFor } from './cliveSession.svelte';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

class TestRegistry extends WindowRegistry<SolveWindowContext> {
  public id = 'window.test';
  constructor() {
    super();
    this.register('clive:track', PhaseTrackWindow);
    this.register('clive:problem_definition', ProblemWindow);
  }
}

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

/** Text only this phase's window renders, in its opening state. */
const PHASE_TEXT = 'Read the problem in the Problem Info tab';

describe('DockviewWindowManager windows', () => {
  it('closes everything but the kept keys, and reopens the same window', async () => {
    const context = stubContext('manager-close');
    // This test is about closing and reopening, not the walkthrough a first visit offers.
    cliveSessionFor(context).tutorialSeen = true;
    const manager = new DockviewWindowManager(context, new TestRegistry(), {});
    const root = document.createElement('div');
    document.body.appendChild(root);
    await manager.attach(root);

    expect(document.body.textContent).toContain('CLive Phases');
    expect(document.body.textContent).toContain(PHASE_TEXT);

    manager.closeWindowsExcept(['clive:track']);
    expect(document.body.textContent).toContain('CLive Phases');
    expect(document.body.textContent).not.toContain(PHASE_TEXT);

    await manager.openWindow('clive:problem_definition');
    expect(document.body.textContent).toContain(PHASE_TEXT);

    manager.destroy();
    root.remove();
  });
});
