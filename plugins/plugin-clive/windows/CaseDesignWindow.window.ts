import { Window } from '$lib/window';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import CaseDesignWindowComponent from './CaseDesignWindow.window.svelte';

/** Phase 2 of PCDIT: `case_design` (see `phase.ts`). Runs before Design, despite the name. */
export class CaseDesignWindow extends Window<SolveWindowContext> {
  static readonly title = 'Cases';
  static readonly closeable = false;
  constructor(context: SolveWindowContext) {
    super({ title: CaseDesignWindow.title, closable: CaseDesignWindow.closeable, context }, CaseDesignWindowComponent);
  }
}
