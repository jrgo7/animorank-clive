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
import { PHASES } from './windows/phase';

export default class CLivePlugin extends ClientPlugin {
  public async init(api: ClientAnimoRankAPI): Promise<void> {
    const registrar = api.clientRegistryProviderRegistrar.getRegistrar(SolveWindowRegistry);
    registrar.register('track', PhaseTrackWindow);
    // Registered under each phase's own id (`problem_definition`, …) rather
    // than an arbitrary key, so `context.openWindow('clive:' + phase.phase)`
    // in PhaseWindowContent/PhaseTrackWindow needs no lookup table of its own.
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
    // `openWindow` is async (`DockviewWindowManager.ensureWindow` awaits the
    // window registry), so firing these without awaiting lets them land in
    // whatever order their internal awaits happen to resolve in -- including
    // which one ends up focused, and where an unpositioned panel like `track`
    // gets placed by dockview's own default. Awaiting each call in turn makes
    // the order below the actual order things happen in.
    const first = `clive:${PHASES[0].phase}`;
    await context.openWindow(first);
    // Given its own row above the phase tabs, rather than an unpositioned
    // `openWindow('clive:track')` -- dockview's default placement for a panel
    // with no explicit position isn't something this plugin controls, and
    // isn't guaranteed to land somewhere visible.
    await context.openWindow('clive:track', { direction: 'above', referencePanel: first });
    // The other three phases join Problem's tab group so every phase is
    // reachable by clicking a tab, not only by passing gates -- `openWindow`
    // always ends with `panel.api.setActive()` (see `DockviewWindowManager`),
    // so each of these would steal focus in turn; the final re-open below
    // hands it back to Problem once all four tabs exist.
    for (const { phase } of PHASES.slice(1)) {
      await context.openWindow(`clive:${phase}`, { direction: 'within', referencePanel: first });
    }
    await context.openWindow(first);
  }

  public async onProblemEditorLoad(context: ProblemEditorWindowContext): Promise<void> {
    // Registered by `init`; opened here so the box sits beside Starter Code
    // without the editor's default layout having to know about this plugin.
    await context.openWindow('clive:reference_solution', { direction: 'below', referencePanel: 'starter_code' });
  }
}
