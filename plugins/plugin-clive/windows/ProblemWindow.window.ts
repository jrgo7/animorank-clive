import { Window } from '$lib/window';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import ProblemWindowComponent from './ProblemWindow.window.svelte';

export class ProblemWindow extends Window<SolveWindowContext> {
  static readonly title = 'Problem Definition';
  static readonly closeable = false;
  constructor(context: SolveWindowContext) {
    super(
      {
        title: ProblemWindow.title,
        closable: ProblemWindow.closeable,
        context
      },
      ProblemWindowComponent
    );
  }
}
