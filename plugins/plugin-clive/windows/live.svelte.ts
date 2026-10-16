/**
 * Live C diagnostics in Implement, on the solve page.
 *
 * Ported from the prototype's student page: clangd (WebAssembly, in this
 * browser) marks compile problems while the student types, in the team's words
 * (`content/base/diagnostics.yaml`'s `clang` codes), as squiggles in AnimoRank's
 * own Code Editor — spec `2026-10-12-live-c-diagnostics-design.md`. It starts
 * when the solve page loads, so it is ready by the time the student reaches
 * Implement.
 *
 * Where the port had to differ, and why:
 *
 * - The prototype remembers the `?live=0` switch per participant code, which this
 *   port has no equivalent of; it is remembered per practice session instead, so
 *   it survives a reload of the page it was set on.
 * - The prototype logs the resolved mode in `session_start`; this port has no
 *   session-start entry. A session that ran live checking shows a
 *   `CLIVE_LIVE_CHECK_READY` entry, one that could not shows
 *   `CLIVE_LIVE_CHECK_FAILED` with the reason, and one that never ran shows
 *   neither.
 * - Run and Submit leave their compile errors as text in AnimoRank's own test
 *   result panel rather than as marks in the editor, so the prototype's "gcc's
 *   marks win" rule becomes: a run or submit clears the squiggles, and the next
 *   edit brings them back.
 *
 * Everything here is silent when clangd is not vendored or the page is not
 * cross-origin isolated: `mode` stays 'unavailable' and no work is started.
 */
import { SvelteURLSearchParams } from 'svelte/reactivity';
import type { monaco } from '$lib/monaco';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import { fetchBoot } from './api';
import { createClangdWorker, createLiveCheckClient, type ClangdDiagnostic, type LiveCheckClient } from './liveCheck';
import { liveMarks, type LiveMark, type LiveTable } from './liveMarks';
import { CLIVE_EVENT } from './telemetry';

/** How long after the last keystroke a check is sent. */
const PAUSE_MS = 600;
/**
 * The marker owner of the live squiggles. AnimoRank's editor has no other marker
 * owner today; this one keeps live checking's marks separable from whoever
 * draws next.
 */
const LIVE_OWNER = 'clive-live';

/** 'on' runs live checking; 'off' is the researcher's switch; 'unavailable' is this machine. */
export type LiveMode = 'on' | 'off' | 'unavailable';

/** A mark placed and worded, waiting only for the severity Monaco's API wants. */
type PendingMarker = Omit<monaco.editor.IMarkerData, 'severity'>;

class LiveChecking {
  /** Whether live checking runs at all, and why not when it does not. */
  mode: LiveMode = $state('unavailable');
  /** Whether clangd answered its handshake; the note under the editor reads this. */
  ready: boolean = $state(false);
  /** Whether live checking gave up for this session: no marks, no checkbox. */
  dead: boolean = $state(false);
  /** Whether the hover carries clang's own message under the description. */
  raw: boolean = $state(false);

  private context: SolveWindowContext | null = null;
  private table: LiveTable | null = null;
  private client: LiveCheckClient | null = null;
  /**
   * Monaco's marker API, resolved once live checking really starts. Every mark is
   * an error, so severity is the one thing the painter adds: Submit compiles with
   * `-Werror`, and a warning-coloured squiggle would say otherwise.
   */
  private painter: ((_model: monaco.editor.ITextModel, _markers: PendingMarker[]) => void) | null = null;
  private timer: number | NodeJS.Timeout | undefined;
  private marks: LiveMark[] = [];
  /** The set of marks already logged, so only a change is recorded. */
  private logged = '[]';
  /** Set by a run or submit: its own answer is the final word until the next edit. */
  private superseded = false;

  private storageKey(name: string): string {
    return `clive.${name}.v1:${this.context?.practiceSession.id ?? 'anon'}`;
  }

  /** Whether the switch or a previous visit turned live checking off for this session. */
  private switchedOff(): boolean {
    try {
      return localStorage.getItem(this.storageKey('live')) === 'off';
    } catch {
      return false; // private mode: the URL alone decides, this visit
    }
  }

  /**
   * The `?live=` switch, read once and then remembered. Taken out of the address
   * like the page's other one-shot parameters, so a reload does not re-apply it.
   */
  private readSwitch(): boolean {
    const params = new SvelteURLSearchParams(location.search);
    const asked = params.get('live');
    if (asked === null) return false;
    try {
      if (asked === '0') localStorage.setItem(this.storageKey('live'), 'off');
      if (asked === '1') localStorage.removeItem(this.storageKey('live'));
    } catch {
      // private mode: the URL alone decides, this visit
    }
    params.delete('live');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    return asked === '0';
  }

  /**
   * Wire live checking into a freshly opened solve page. Called once, from the
   * plugin's page hook, so the worker has the whole session to load in.
   */
  async attach(context: SolveWindowContext): Promise<void> {
    this.context = context;
    try {
      this.raw = localStorage.getItem(this.storageKey('rawwords')) === 'on';
    } catch {
      // private mode: the box starts off, as it does by default
    }
    const asked = this.readSwitch();
    if (asked || this.switchedOff()) {
      this.mode = 'off';
      return;
    }
    try {
      this.table = (await fetchBoot()).live_check;
    } catch {
      this.mode = 'unavailable'; // the API is unreachable; the page is as it was
      return;
    }
    if (!this.table.available || !globalThis.crossOriginIsolated) {
      this.mode = 'unavailable';
      return;
    }
    this.mode = 'on';
    this.watch();
    await this.start();
  }

  /**
   * Every edit restarts the pause and then checks; a run or a submit clears the
   * squiggles, because the compiler's own answer is the final word until the
   * student edits the code they ran.
   */
  private watch(): void {
    const context = this.context;
    if (!context) return;
    let seenResults = context.testCaseResults;
    let seenType = context.lastTestType;
    $effect.root(() => {
      $effect(() => {
        // Both are read so each edit (and a fresh model, from Reset Code) restarts
        // the pause; the text checked is the one this edit produced.
        const { model, code } = context.editorState;
        if (!model || this.mode !== 'on' || !this.ready || this.dead) return;
        this.superseded = false;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.client?.check(code), PAUSE_MS);
      });
      $effect(() => {
        const results = context.testCaseResults;
        const type = context.lastTestType;
        if (results === seenResults && type === seenType) return;
        seenResults = results;
        seenType = type;
        this.superseded = true;
        this.clear();
      });
    });
  }

  private async start(): Promise<void> {
    try {
      // Monaco is loaded here rather than at this module's top: the plugin's
      // windows render where there is no editor (including the component tests),
      // and the editor's own contributions have no business in those contexts.
      // The editor is on screen long before clangd has an answer.
      const { monaco } = await import('$lib/monaco');
      this.painter = (model, markers) =>
        monaco.editor.setModelMarkers(
          model,
          LIVE_OWNER,
          markers.map((marker) => ({ ...marker, severity: monaco.MarkerSeverity.Error }))
        );
      const worker = await createClangdWorker();
      const client = createLiveCheckClient({ worker });
      this.client = client;
      client.onDead((reason) => this.died(reason));
      client.onDiagnostics((diagnostics) => this.show(diagnostics));
      const { loadMs } = await client.start();
      this.ready = true;
      this.context?.telemetry.record(CLIVE_EVENT.liveCheckReady, { load_ms: Math.round(loadMs) });
      this.kick();
    } catch (error) {
      this.died(error instanceof Error ? error.message : String(error));
    }
  }

  /** One check now, for the text the editor holds. */
  private kick(): void {
    const context = this.context;
    if (!context?.editorState.model || !this.ready || this.dead) return;
    this.client?.check(context.editorState.code);
  }

  private show(diagnostics: ClangdDiagnostic[]): void {
    const context = this.context;
    if (!context || !this.table) return;
    this.marks = liveMarks(diagnostics, context.editorState.code, this.table);
    const summary = JSON.stringify(this.marks.map((mark) => ({ line: mark.line, kind: mark.kind })));
    if (summary !== this.logged) {
      this.logged = summary;
      context.telemetry.record(CLIVE_EVENT.liveCheck, {
        problem: context.problem.id,
        diagnostics: JSON.parse(summary) as { line: number; kind: string }[]
      });
    }
    this.draw();
  }

  /** Repaint the squiggles, at the word each mark points at. */
  private draw(): void {
    const model = this.context?.editorState.model;
    // CLive shows the code editor only while Implement is on screen, so the model
    // the context holds is disposed once the student leaves that phase.
    if (!model || model.isDisposed() || !this.painter) return;
    this.painter(
      model,
      this.superseded
        ? []
        : this.marks.map((mark) => {
            const line = Math.min(Math.max(1, mark.line), model.getLineCount());
            const end = model.getLineMaxColumn(line);
            // clangd reports a missing `;` just past the last character; the mark
            // then belongs on that character's word.
            const column = Math.max(1, Math.min(mark.column, end - 1));
            const word = model.getWordAtPosition({ lineNumber: line, column });
            return {
              startLineNumber: line,
              startColumn: word ? word.startColumn : column,
              endLineNumber: line,
              endColumn: word ? word.endColumn : Math.min(column + 1, end),
              message: this.raw && mark.raw ? `${mark.say}\n\nCompiler: ${mark.raw}` : mark.say
            };
          })
    );
  }

  private clear(): void {
    this.marks = [];
    this.draw();
  }

  private died(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.clear();
    this.context?.telemetry.record(CLIVE_EVENT.liveCheckFailed, { reason });
  }

  /** The raw-words box: clang's own message under our description, or not. */
  setRaw(on: boolean): void {
    this.raw = on;
    try {
      localStorage.setItem(this.storageKey('rawwords'), on ? 'on' : 'off');
    } catch {
      // private mode: the box still works for this visit
    }
    this.context?.telemetry.record(CLIVE_EVENT.liveRawToggle, { on });
    this.draw();
  }
}

/** One solve page per tab, so one live-checking session at a time. */
export const live = new LiveChecking();
