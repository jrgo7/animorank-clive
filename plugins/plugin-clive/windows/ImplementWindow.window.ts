import { Window } from '$lib/window';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import ImplementWindowComponent from './ImplementWindow.window.svelte';

/**
 * Phase 4 of PCDIT: `implement` (see `phase.ts`). Its `code` field has no
 * editor of its own -- the student writes it in AnimoRank's native Code
 * Editor window, whose tests decide the phase; this one shows their Design and
 * the hints about their code, with "I'm stuck" under the latest. See
 * `ImplementWindow.window.svelte`.
 */
export class ImplementWindow extends Window<SolveWindowContext> {
  static readonly title = 'Implement';
  static readonly closeable = false;
  constructor(context: SolveWindowContext) {
    super({ title: ImplementWindow.title, closable: ImplementWindow.closeable, context }, ImplementWindowComponent);
  }
}
