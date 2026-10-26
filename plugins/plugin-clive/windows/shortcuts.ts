/**
 * The researcher's keys, which work wherever focus is and whichever CLive windows
 * are open: Ctrl+Shift+Y opens the override (reopening the strip that shows it),
 * Ctrl+Shift+L the live reasoning window, Escape closes the override.
 */
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import type { CliveSession } from './cliveSession.svelte';
import { PHASE_TRACK_SIZING, PHASES } from './phase';

export interface ShortcutTarget {
  context: SolveWindowContext;
  session: CliveSession;
}

export function onResearcherKey(e: KeyboardEvent, { context, session }: ShortcutTarget): void {
  const key = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey && key === 'l') {
    // A separate small window, so it can sit on another screen.
    e.preventDefault();
    e.stopPropagation();
    window.open(
      `/plugin-api/clive/live?session=${encodeURIComponent(context.practiceSession.id)}`,
      'clive-live',
      'popup,width=520,height=760'
    );
  } else if (e.ctrlKey && e.shiftKey && key === 'y') {
    e.preventDefault();
    e.stopPropagation();
    session.overrideOpen = !session.overrideOpen;
    // Above the open phase, where the page first put it; anywhere, if that phase is closed too.
    const phase = `clive:${PHASES[session.current].phase}`;
    if (session.overrideOpen)
      void context.openWindow('clive:track', { direction: 'above', referencePanel: phase }, PHASE_TRACK_SIZING);
  } else if (e.key === 'Escape' && session.overrideOpen) {
    session.overrideOpen = false;
  }
}
