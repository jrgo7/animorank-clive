import { Window } from '$lib/window';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import AlgorithmDesignWindowComponent from './AlgorithmDesignWindow.window.svelte';

/** Phase 3 of PCDIT: `algorithm_design` (see `phase.ts`). */
export class AlgorithmDesignWindow extends Window<SolveWindowContext> {
  static readonly title = 'Design';
  static readonly closeable = false;
  constructor(context: SolveWindowContext) {
    super(
      { title: AlgorithmDesignWindow.title, closable: AlgorithmDesignWindow.closeable, context },
      AlgorithmDesignWindowComponent
    );
  }
}
