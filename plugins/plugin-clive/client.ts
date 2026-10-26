import type { ClientAnimoRankAPI } from '$lib/api/client';
import { ClientPlugin } from '$lib/plugin/clientPlugin';
import type { SolveWindowContext } from '../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import { SolveWindowRegistry } from '../../src/routes/problem/[problem_id]/[session_id]/windowRegistry';
import type { ProblemEditorWindowContext } from '../../src/routes/edit/[slug]/context.svelte';
import { ProblemEditorWindowRegistry } from '../../src/routes/edit/[slug]/windowRegistry';
import type { SessionLogsWindowRegistry } from '../../src/routes/instructor/analytics/session-logs/windowRegistry';
import type { SessionLogsViewContext } from '../../src/routes/instructor/analytics/session-logs/context.svelte';
import { PhaseTrackWindow } from './windows/PhaseTrackWindow.window';
import { ProblemWindow } from './windows/ProblemWindow.window';
import { CaseDesignWindow } from './windows/CaseDesignWindow.window';
import { AlgorithmDesignWindow } from './windows/AlgorithmDesignWindow.window';
import { ImplementWindow } from './windows/ImplementWindow.window';
import { ReferenceSolutionWindow } from './windows/ReferenceSolutionWindow.window';
import { CLiveLogsWindow } from './windows/CLiveLogs.window';
import { live } from './windows/live.svelte';
import { cliveSessionFor } from './windows/cliveSession.svelte';
import { PHASE_PLACEMENT_REFERENCE, PHASE_TRACK_SIZING, PHASES, PROBLEM_INFO_WINDOW_KEY } from './windows/phase';
import { showPhaseWindows } from './windows/phaseWindows';
import { CLIVE_EVENT } from './windows/telemetry';
import { checkLog } from './windows/api';
import { onResearcherKey, type ShortcutTarget } from './windows/shortcuts';

/** The key the log view is registered under, in the plugin's own namespace. */
const LOG_VIEW = 'events';

export default class CLivePlugin extends ClientPlugin {
  private logViewKey = LOG_VIEW;
  /**
   * The solve page the researcher's keys act on. Plugins get no unload hook, so the
   * key listener is added once and follows whichever page loaded last.
   */
  private shortcutTarget: ShortcutTarget | undefined;

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

    // The session-logs page renders whatever each plugin registers; this one's
    // view is the prototype's Logs page: one timeline of a session's CLive
    // events, with each model call folded into the submit or stuck ask it served.
    const logRegistrar =
      await api.clientRegistryProviderRegistrar.getRegistrarById<SessionLogsWindowRegistry>('window.session_logs');
    this.logViewKey = `${logRegistrar.id}:${LOG_VIEW}`;
    logRegistrar.register(LOG_VIEW, CLiveLogsWindow);
  }

  public async onSolvePageLoad(context: SolveWindowContext): Promise<void> {
    const session = cliveSessionFor(context);

    // Captured, so the keys work in the code editor and text boxes too.
    if (!this.shortcutTarget) {
      window.addEventListener(
        'keydown',
        (e) => {
          if (this.shortcutTarget) onResearcherKey(e, this.shortcutTarget);
        },
        true
      );
    }
    this.shortcutTarget = { context, session };

    // A Run or Submit that did not pass, once the student has reached Implement: CLive
    // answers on its own with the situation it sees and one thing to do.
    context.executionObservable.subscribe('tests', (execution) => {
      void session.codeRan(context, execution);
    });

    // A Run is AnimoRank's own flow -- the plugin has none of its own -- so its
    // outcome is recorded from the execution event. The code itself is already
    // in the telemetry hook's `RUN_ATTEMPT` entry; Submit is recorded
    // server-side as `CLIVE_SUBMIT`.
    context.executionObservable.subscribe('tests', (execution) => {
      if (execution.runType !== 'run') return;
      const passed = execution.generalTestResults.filter(Boolean).length;
      context.telemetry.record(CLIVE_EVENT.run, {
        problem: context.problem.id,
        phase: PHASES[session.current]?.phase ?? null,
        passed: passed === execution.generalTestResults.length,
        tests_passed: passed,
        tests_total: execution.generalTestResults.length
      });
    });

    // Prove the session's history accepts writes before the student settles in.
    // Independent of clangd, so a slow handshake cannot delay it.
    void checkLog(context.practiceSession.id, context.problem.id)
      .then((answer) => {
        session.logging = { ok: answer.ok, reason: answer.error };
      })
      .catch((error: unknown) => {
        // The thing being checked is the history write, so a failure cannot be
        // recorded in it: the phase strip shows NOT LOGGING instead, and the page
        // still opens.
        session.logging = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        console.warn('CLive could not check the session log', error);
      });

    // Live C diagnostics start now rather than when Implement opens, so clangd
    // has the whole session to load in (13 MB, and a second or two to start) --
    // and deliberately not awaited by the page: its handshake is not something
    // the windows above should wait on. `attach` itself resolves once the mode
    // is known, which is what `CLIVE_SESSION_START` records. See
    // `windows/live.svelte.ts`.
    void (async () => {
      try {
        await live.attach(context);
      } catch {
        // `attach` degrades to 'unavailable' on its own; a failure there must
        // not cost the session its start record.
      }
      context.telemetry.record(CLIVE_EVENT.sessionStart, {
        problem: context.problem.id,
        new_session: !session.restored,
        live: live.mode
      });
    })();

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
    // Given its own row above the phase tabs, sized to the tiles and the line
    // above them: the phase window is the one that should take the space, so
    // this one is exactly its content and cannot be dragged.
    await context.openWindow('clive:track', { direction: 'above', referencePanel: first }, PHASE_TRACK_SIZING);
    // The other three phases join Problem's tab group so every phase is
    // reachable by clicking a tab, not only by passing gates -- `openWindow`
    // always ends with `panel.api.setActive()` (see `DockviewWindowManager`),
    // so each of these would steal focus in turn; the final re-open below
    // hands it to the phase the student was last on once all four tabs exist.
    for (const { phase } of PHASES.slice(1)) {
      await context.openWindow(`clive:${phase}`, { direction: 'within', referencePanel: first });
    }
    await context.openWindow(`clive:${PHASES[session.current]?.phase ?? PHASES[0].phase}`);

    // ...and close the page's own windows out of the way, for the phase the
    // student was last on. The strip does this too, on every phase change; the
    // call here is the one that holds on a page whose windows were built before
    // the page bound `closeWindowsExcept` (see `phaseWindows.ts`).
    // The editor windows go first even for a student already on Implement: in a
    // layout built just now they share a tab group with the phases, and reopening
    // them puts them beside the phase window instead. A closed window keeps its state.
    showPhaseWindows(context, PHASES[0].phase);
    showPhaseWindows(context, PHASES[cliveSessionFor(context).current]?.phase ?? '');
  }

  public async onSessionLogsLoad(context: SessionLogsViewContext): Promise<void> {
    // A session with any CLive entry is worth reading as a CLive timeline; the
    // replay and raw views stay one tab away. Replay leaves CLive sessions to
    // this view (see the session-replay plugin), so the tab strip does not
    // depend on which page hook happens to run last.
    if (context.logs.some((entry) => entry.type.startsWith('CLIVE_'))) await context.openView(this.logViewKey);
  }

  public async onProblemEditorLoad(context: ProblemEditorWindowContext): Promise<void> {
    // Registered by `init`; opened here so the box sits beside Starter Code
    // without the editor's default layout having to know about this plugin.
    await context.openWindow('clive:reference_solution', { direction: 'below', referencePanel: 'starter_code' });
  }
}
