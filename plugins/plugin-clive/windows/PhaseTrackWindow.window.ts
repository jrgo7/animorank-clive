import { Window } from '$lib/window';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import PhaseTrackWindowComponent from './PhaseTrackWindow.window.svelte';

export class PhaseTrackWindow extends Window<SolveWindowContext> {
  static readonly title = 'CLive Phases';
  static readonly closeable = false;
  constructor(context: SolveWindowContext) {
    super({ title: PhaseTrackWindow.title, closable: PhaseTrackWindow.closeable, context }, PhaseTrackWindowComponent);
  }
}
