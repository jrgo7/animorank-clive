import { IMPLEMENT_PHASE, IMPLEMENT_WINDOW_KEY, solveLayoutKeys } from './phase';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';

/**
 * Show the windows the page should be showing while `phase` is the one the
 * student is on, and close the rest: the problem statement and CLive's own
 * windows always, plus the two the Implement phase needs -- the editor the
 * student writes in and the test-case results its gate reads -- only while it is
 * the phase on screen.
 *
 * Called from two places, and safe to call as often as anything changes. The
 * page hook calls it so a page load settles into this arrangement whatever
 * windows it opened with; the phase strip calls it so changing phase moves the
 * editor with it. The hook's call is the one that matters on a page whose
 * windows were built while the dock was still being laid out: such a window runs
 * its own effect before the page has bound `openWindow` and `closeWindowsExcept`
 * to the dock, so an effect alone would find them doing nothing.
 */
export function showPhaseWindows(context: SolveWindowContext, phase: string): void {
  context.closeWindowsExcept(solveLayoutKeys(phase));

  if (phase === IMPLEMENT_PHASE) {
    context.openWindow('code_editor', { direction: 'right', referencePanel: IMPLEMENT_WINDOW_KEY });
    context.openWindow('test_cases', { direction: 'below', referencePanel: 'code_editor' });
    // Each open focuses its panel, so the last one would be the results; the student
    // is here to write code, so hand them the editor.
    context.openWindow('code_editor');
  }
}
