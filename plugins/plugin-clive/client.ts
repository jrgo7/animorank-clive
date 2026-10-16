import type { ClientAnimoRankAPI } from '$lib/api/client';
import { ClientPlugin } from '$lib/plugin/clientPlugin';
import type { SolveWindowContext } from '../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import { SolveWindowRegistry } from '../../src/routes/problem/[problem_id]/[session_id]/windowRegistry';
import type { ProblemEditorWindowContext } from '../../src/routes/edit/[slug]/context.svelte';
import { ProblemEditorWindowRegistry } from '../../src/routes/edit/[slug]/windowRegistry';
import { PhaseTrackWindow } from './windows/PhaseTrackWindow.window';
import { ProblemWindow } from './windows/ProblemWindow.window';
import { CaseDesignWindow } from './windows/CaseDesignWindow.window';
import { AlgorithmDesignWindow } from './windows/AlgorithmDesignWindow.window';
import { ImplementWindow } from './windows/ImplementWindow.window';
import { ReferenceSolutionWindow } from './windows/ReferenceSolutionWindow.window';
import { live } from './windows/live.svelte';
import { cliveSessionFor } from './windows/cliveSession.svelte';
import { PHASE_PLACEMENT_REFERENCE, PHASES, PROBLEM_INFO_WINDOW_KEY } from './windows/phase';
import { showPhaseWindows } from './windows/phaseWindows';

/**
 * The CLive strip's height, in pixels: its four phase cards, the line under them,
 * and its own padding -- measured from the panel's content. The phase window is
 * the one that should take the room, so this one is pinned to exactly this.
 */
const PHASE_TRACK_HEIGHT = 226;

export default class CLivePlugin extends ClientPlugin {
  public async init(api: ClientAnimoRankAPI): Promise<void> {
    const registrar = api.clientRegistryProviderRegistrar.getRegistrar(SolveWindowRegistry);
    registrar.register('track', PhaseTrackWindow);
    // Registered under each phase's own id (`problem_definition`, …) rather
    // than an arbitrary key, so `context.openWindow('clive:' + phase.phase)` in
    // the phase windows and PhaseTrackWindow needs no lookup table of its own.
    registrar.register(PHASES[0].phase, ProblemWindow);
    registrar.register(PHASES[1].phase, CaseDesignWindow);
    registrar.register(PHASES[2].phase, AlgorithmDesignWindow);
    registrar.register(PHASES[3].phase, ImplementWindow);

    // CLive's per-problem reference solution, authored on the problem editor.
    api.clientRegistryProviderRegistrar
      .getRegistrar(ProblemEditorWindowRegistry)
      .register('reference_solution', ReferenceSolutionWindow);
  }

  public async onSolvePageLoad(context: SolveWindowContext): Promise<void> {
    // Live C diagnostics start now rather than when Implement opens, so clangd
    // has the whole session to load in (13 MB, and a second or two to start) --
    // and deliberately not awaited: its handshake is not something the windows
    // above should wait on. See `windows/live.svelte.ts`.
    void live.attach(context);

    // `openWindow` is async (`DockviewWindowManager.ensureWindow` awaits the
    // window registry), so firing these without awaiting lets them land in
    // whatever order their internal awaits happen to resolve in -- including
    // which one ends up focused, and where an unpositioned panel like `track`
    // gets placed by dockview's own default. Awaiting each call in turn makes
    // the order below the actual order things happen in.
    const first = `clive:${PHASES[0].phase}`;
    // Into AnimoRank's own right-hand column rather than one of its own: the
    // statement keeps the left of the page, and the phase windows take the
    // column the editor and its results were in (they are closed below, and
    // reopened for Implement). The fallback is for a layout with no editor open
    // at all -- a column of its own, to the right of the statement.
    await context.openWindow(first, [
      { direction: 'within', referencePanel: PHASE_PLACEMENT_REFERENCE },
      { direction: 'right', referencePanel: PROBLEM_INFO_WINDOW_KEY }
    ]);
    // Given its own row above the phase tabs, sized to the cards and the line
    // under them: the phase window is the one that should take the space, so
    // this one starts at exactly its content and cannot be dragged smaller.
    await context.openWindow(
      'clive:track',
      { direction: 'above', referencePanel: first },
      { initialHeight: PHASE_TRACK_HEIGHT, minimumHeight: PHASE_TRACK_HEIGHT }
    );
    // The other three phases join Problem's tab group so every phase is
    // reachable by clicking a tab, not only by passing gates -- `openWindow`
    // always ends with `panel.api.setActive()` (see `DockviewWindowManager`),
    // so each of these would steal focus in turn; the final re-open below
    // hands it back to Problem once all four tabs exist.
    for (const { phase } of PHASES.slice(1)) {
      await context.openWindow(`clive:${phase}`, { direction: 'within', referencePanel: first });
    }
    await context.openWindow(first);

    // ...and close the page's own windows out of the way, for the phase the
    // student was last on. The strip does this too, on every phase change; the
    // call here is the one that holds on a page whose windows were built before
    // the page bound `closeWindowsExcept` (see `phaseWindows.ts`).
    showPhaseWindows(context, PHASES[cliveSessionFor(context).current]?.phase ?? '');
  }

  public async onProblemEditorLoad(context: ProblemEditorWindowContext): Promise<void> {
    // Registered by `init`; opened here so the box sits beside Starter Code
    // without the editor's default layout having to know about this plugin.
    await context.openWindow('clive:reference_solution', { direction: 'below', referencePanel: 'starter_code' });
  }
}
