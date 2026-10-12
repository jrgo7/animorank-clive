import { Window } from '$lib/window';
import type { ProblemEditorWindowContext } from '../../../src/routes/edit/[slug]/context.svelte';
import ReferenceSolution from './ReferenceSolutionWindow.window.svelte';

/**
 * CLive's per-problem reference solution, authored beside Starter Code on the
 * problem editor. The judge never sees it; the Cases phase runs each hand-written
 * case row through it to compute the `outputs_are_correct` criterion.
 */
export class ReferenceSolutionWindow extends Window<ProblemEditorWindowContext> {
  static readonly title = 'Reference solution';
  static readonly closeable = true;
  constructor(context: ProblemEditorWindowContext) {
    super(
      { title: ReferenceSolutionWindow.title, closable: ReferenceSolutionWindow.closeable, context },
      ReferenceSolution
    );
  }
}
