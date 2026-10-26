import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { JsonValue } from '@zenstackhq/orm';
import type { TelemetryService } from '$lib/telemetry/telemetryService';
import { toJsonValue, type IntoJsonValue } from '$lib/types/utils';
import { savePracticeSession } from '$lib/practiceSession/api';
import { codeFeedback, fetchBoot, setParticipant, type NudgeTurn } from './api';
import { implementReached, LatestOnly, toCodeRun, wantsCodeFeedback } from './codeFeedback';
import { CLIVE_EVENT } from './telemetry';
import type { SolveWindowContext } from '../../../src/routes/problem/[problem_id]/[session_id]/context.svelte';
import {
  PHASES,
  blankValueFor,
  inPlay,
  isFilled,
  isPerStep,
  type ArtifactField,
  type ArtifactValue,
  type PhaseConfig
} from './phase';

export type { ArtifactValue };

/** One ask in a phase: what the student said was hard, and the reply they read. */
export interface StuckEntry {
  statement: string;
  feedback: string;
  /** The field the student was on, when the phase showed exactly one. */
  fieldId: string | null;
  attempt: number;
}

export interface Verdict {
  criterion_id: string;
  criterion_text?: string;
  /** The line the student reads for this requirement: what to do, in the criterion's own words. */
  not_met?: string;
  verdict: 'PASS' | 'FAIL';
  gate: 'gating' | 'advisory';
  explain?: string;
  recheck?: string[];
  /** For a computed verdict: the rows whose input the problem does not allow. */
  outside_rules?: string[];
  /** Which questions this verdict belongs on; absent from a result saved before it was sent. */
  fields?: string[];
}

export interface NudgeResult {
  /** Which situation the model decided the student is in. */
  situation?: string;
  summary: string;
  nudge: string;
  reason: string;
  focus_id: string;
  /** The focused requirement's own text, for a requirement with no `not_met` line. */
  focus_text?: string;
  /** The focused requirement's `not_met`, the line the student sees just above the nudge. */
  focus_not_met?: string;
  /** The questions the focused requirement is about: the first is where a failed submit opens. */
  focus_fields?: string[];
  failing: { id: string; text: string }[];
}

export interface JudgeResult {
  passed: boolean;
  verdicts: Verdict[];
  missing_ids: string[];
  advisory_unmet: string[];
  nudge?: NudgeResult;
  nudge_error?: string;
}

/** One step's own outcome in a per-step phase. */
export interface StepResult {
  result: JudgeResult | null;
  passed: boolean;
  attempt: number;
}

/** The shape persisted under `PracticeSession.extension_data.clive`. */
interface PersistedState {
  version: 1;
  current: number;
  /** Whether the walkthrough has been offered (and dismissed) for this practice session. */
  tutorialSeen: boolean;
  phases: {
    artifact: Record<string, ArtifactValue>;
    attempt: number;
    passed: boolean;
    advanced: boolean;
    unlocked: boolean;
    step: number;
    added: number;
    stepResults: Record<string, StepResult>;
    result: JudgeResult | null;
    stuck: StuckEntry[];
    /** The ask the student was part-way through typing. */
    stuckDraft: string;
    /** Whether the phase's opening was left behind (a problem opens on its statement alone). */
    read: boolean;
    /** Replies about the code after failing Runs and Submits, newest first (Implement). */
    codeFeedback?: CodeFeedbackEntry[];
    /** Earlier nudges, oldest first, by step field id (or `phase` for an all-at-once phase). */
    feedbackHistory?: Record<string, NudgeTurn[]>;
  }[];
}

const PERSIST_KEY = 'clive';
const PERSIST_VERSION = 1;
const SAVE_DEBOUNCE_MS = 500;

/**
 * A saved artifact with every field its phase has.
 *
 * The fields are authored content, so the set grows: a session saved before a
 * field existed holds an artifact that simply lacks it. Restoring such an
 * artifact as it stands would reach the field editor as `undefined`, and Svelte
 * refuses to bind a prop that has a fallback to an undefined value
 * (`props_invalid_value`) — every phase window would throw as it opened. A value
 * the saved state does hold is kept exactly as it is, blank or not.
 */
function completeArtifact(config: PhaseConfig, saved: unknown, startingCode: string): Record<string, ArtifactValue> {
  const stored = (saved ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    config.artifactFields.map((field) => {
      const value = stored[field.id];
      const missing = value === undefined || value === null;
      return [field.id, missing ? blankValueFor(field, startingCode) : (value as ArtifactValue)];
    })
  );
}

/** One reply about the student's code after a Run or Submit that did not pass. */
export interface CodeFeedbackEntry {
  attempt: number;
  runType: 'run' | 'submit';
  situation: string;
  focus: string;
  nudge: string;
}

/** One phase's working state: what the student has written, and what came back for it. */
export class PhaseState {
  artifact: Record<string, ArtifactValue> = $state({});
  attempt: number = $state(1);
  passed: boolean = $state(false);
  /** Set by a researcher override that moved the student on without a pass; there is no override UI yet. */
  advanced: boolean = $state(false);
  unlocked: boolean = $state(false);
  /** Which field a stepped phase shows. */
  step: number = $state(0);
  /** How many optional cases (Cases 3-5) have been added. */
  added: number = $state(0);
  /** The phase-level result, for a phase judged all at once. */
  result: JudgeResult | null = $state(null);
  /** Each step's own result, for a per-step phase. */
  stepResults: Record<string, StepResult> = $state({});
  /** Every stuck ask in this phase and its reply, newest first. */
  stuck: StuckEntry[] = $state([]);
  /** The ask the student is typing, kept across a reload. */
  stuckDraft: string = $state('');
  /** Whether the ask box is open; not persisted, it is a moment in the page. */
  stuckOpen: boolean = $state(false);
  /**
   * Whether the phase's opening has been left behind. A problem opens on its
   * statement alone, with Next to the first question.
   */
  read: boolean = $state(false);
  /** Replies about the code after failing Runs and Submits, newest first (Implement only). */
  codeFeedback: CodeFeedbackEntry[] = $state([]);
  /** Earlier nudges, oldest first, by step field id (or `phase` for an all-at-once phase). */
  feedbackHistory: Record<string, NudgeTurn[]> = $state({});

  constructor(config: PhaseConfig, startingCode: string, unlocked: boolean) {
    this.artifact = Object.fromEntries(config.artifactFields.map((f) => [f.id, blankValueFor(f, startingCode)]));
    this.unlocked = unlocked;
  }
}

/**
 * All four phases for one practice session, and which one is open. The
 * counterpart of the prototype's global `S` object in `student.html`, but scoped
 * to one practice session rather than the whole page, reactive via Svelte 5
 * runes, and persisted to the session's `extension_data`.
 *
 * One instance per practice session, shared by every CLive window through
 * {@link cliveSessionFor}.
 */
export class CliveSession {
  readonly phases: PhaseState[];
  current: number = $state(0);
  /**
   * What the plugin is waiting on. `'run'` never appears here: the Implement
   * phase's compiling and running is AnimoRank's own submit flow (see
   * `ImplementWindow.window.svelte`), not something this plugin's UI does itself.
   */
  busy: 'stuck' | 'submit' | null = $state(null);
  /** How many replies about the code are on their way; separate from `busy`, they never block the page. */
  codeFeedbackPending: number = $state(0);
  /** Whether a reply about the code is on its way. */
  get codeFeedbackBusy(): boolean {
    return this.codeFeedbackPending > 0;
  }
  private readonly codeFeedbackRequests = new LatestOnly();
  busySince: number | null = $state(null);
  error: string | null = $state(null);
  /** Whether a model provider is configured; the Hint button is disabled when not. */
  hasApiKey: boolean = $state(true);
  /** Whether the walkthrough has been offered (and dismissed) for this practice session. */
  tutorialSeen: boolean = $state(false);
  /** Whether the researcher dialog (Ctrl+Shift+Y) is showing; not persisted. */
  overrideOpen: boolean = $state(false);
  /** Who is working in this session, as the researcher tagged it; '' when untagged. */
  participant: string = $state('');
  /** Whether this session's history accepted the log check; null until it answers. */
  logging: { ok: boolean; reason: string } | null = $state(null);
  /** Whether saved CLive work was found for this session, for `CLIVE_PROBLEM_LOAD`. */
  public readonly restored: boolean;

  private readonly sessionId: string;
  /** The session's telemetry sink; the entries CLive records are flushed with its saves. */
  private readonly telemetry: TelemetryService;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: SolveWindowContext) {
    this.sessionId = context.practiceSession.id;
    this.telemetry = context.telemetry;
    this.phases = PHASES.map((config, i) => new PhaseState(config, context.editorState.code, i === 0));
    this.restored = this.restore(context.practiceSession.extension_data, context.editorState.code);
    const tag = (context.practiceSession.extension_data as Record<string, unknown> | null)?.clive_participant;
    this.participant = typeof tag === 'string' ? tag : '';
    void this.refreshBoot();
  }

  private async refreshBoot(): Promise<void> {
    try {
      this.hasApiKey = (await fetchBoot()).hasApiKey;
    } catch {
      // The key gate is a courtesy; the server's own error is the fallback.
    }
  }

  private restore(extensionData: unknown, startingCode: string): boolean {
    const stored = extensionData as { clive?: PersistedState } | null | undefined;
    const persisted = stored?.clive;
    if (!persisted || persisted.version !== PERSIST_VERSION || persisted.phases?.length !== PHASES.length) {
      return false;
    }
    this.current = persisted.current ?? 0;
    // A session saved before the walkthrough existed has not seen it.
    this.tutorialSeen = persisted.tutorialSeen === true;
    persisted.phases.forEach((saved, i) => {
      const phase = this.phases[i];
      Object.assign(phase, {
        artifact: completeArtifact(PHASES[i], saved.artifact, startingCode),
        attempt: saved.attempt,
        passed: saved.passed,
        advanced: saved.advanced,
        unlocked: saved.unlocked,
        step: saved.step,
        added: saved.added,
        stepResults: saved.stepResults ?? {},
        result: saved.result,
        stuck: saved.stuck ?? [],
        stuckDraft: typeof saved.stuckDraft === 'string' ? saved.stuckDraft : '',
        // A session saved before a problem opened on its statement alone has already started.
        read: typeof saved.read === 'boolean' ? saved.read : true,
        codeFeedback: Array.isArray(saved.codeFeedback) ? saved.codeFeedback : [],
        feedbackHistory: saved.feedbackHistory ?? {}
      });
    });
    return true;
  }

  private snapshot(): JsonValue {
    const state: PersistedState = {
      version: PERSIST_VERSION,
      current: this.current,
      tutorialSeen: this.tutorialSeen,
      phases: this.phases.map((phase) => ({
        artifact: $state.snapshot(phase.artifact) as Record<string, ArtifactValue>,
        attempt: phase.attempt,
        passed: phase.passed,
        advanced: phase.advanced,
        unlocked: phase.unlocked,
        step: phase.step,
        added: phase.added,
        stepResults: $state.snapshot(phase.stepResults) as Record<string, StepResult>,
        result: $state.snapshot(phase.result) as JudgeResult | null,
        stuck: $state.snapshot(phase.stuck) as StuckEntry[],
        stuckDraft: phase.stuckDraft,
        read: phase.read,
        codeFeedback: $state.snapshot(phase.codeFeedback) as CodeFeedbackEntry[],
        feedbackHistory: $state.snapshot(phase.feedbackHistory) as Record<string, NudgeTurn[]>
      }))
    };
    // The shape is a plain JSON object; `PersistedState` only documents it for restore,
    // and `toJsonValue` rejects anything JSON cannot carry faithfully.
    return toJsonValue(state as unknown as IntoJsonValue);
  }

  /**
   * Persist the session, debounced. A failed save surfaces through
   * {@link error} but never blocks judging: the work is still in memory, and
   * the PUT route merges top-level keys so no other extension's data is touched.
   *
   * The session's telemetry is flushed alongside the save, as the code editor's
   * own save does: the entries CLive recorded are already buffered, and a student
   * who works only in CLive's panels never touches the editor that otherwise
   * flushes them.
   */
  persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void savePracticeSession(this.sessionId, {
        extension_data: { [PERSIST_KEY]: this.snapshot() }
      })
        .then(() => this.telemetry.flush())
        .catch((cause: unknown) => {
          this.error = cause instanceof Error ? cause.message : String(cause);
        });
    }, SAVE_DEBOUNCE_MS);
  }

  /** The result a step's feedback reads: its own in a per-step phase, the phase's otherwise. */
  stateFor(index: number, fieldId: string): StepResult {
    const config = PHASES[index];
    const state = this.phases[index];
    if (!isPerStep(config)) {
      return { result: state.result, passed: state.passed, attempt: state.attempt };
    }
    const step = state.stepResults[fieldId] ?? { result: null, passed: false, attempt: 1 };
    const added = config.artifactFields.find((f) => f.id === fieldId)?.added;
    // A passed phase passes its steps -- except an added case, judged on its own.
    return { ...step, passed: step.passed || (state.passed && !added) };
  }

  /** The fields a student is working on in a phase, optional cases aside until added. */
  inPlay(index: number): ArtifactField[] {
    return inPlay(PHASES[index], this.phases[index].added);
  }

  /** Whether a step is open: only a per-step phase locks, and only behind an earlier step. */
  stepOpen(index: number, j: number): boolean {
    if (!isPerStep(PHASES[index])) return true;
    return this.inPlay(index)
      .slice(0, j)
      .every((field) => this.stateFor(index, field.id).passed);
  }

  /** Earlier nudges for a phase (or one of its steps), oldest first, the last five. */
  historyFor(index: number, key = 'phase'): NudgeTurn[] {
    return (this.phases[index].feedbackHistory[key] ?? []).slice(-5);
  }

  /** Keeps a nudge the student was shown, so the next one can tell it is repeating itself. */
  private remember(index: number, key: string, attempt: number, result: JudgeResult): void {
    const n = result.nudge;
    if (!n) return;
    const state = this.phases[index];
    const turns = state.feedbackHistory[key] ?? [];
    turns.push({ attempt, situation: n.situation ?? 'other', focus_id: n.focus_id, nudge: n.nudge });
    state.feedbackHistory[key] = turns.slice(-20);
  }

  /** Records one step's result and passes the phase once every required step has passed. */
  completeStep(index: number, fieldId: string, result: JudgeResult): void {
    const config = PHASES[index];
    const state = this.phases[index];
    const step = state.stepResults[fieldId] ?? { result: null, passed: false, attempt: 1 };
    this.remember(index, fieldId, step.attempt, result);
    step.result = result;
    if (result.passed) step.passed = true;
    else step.attempt += 1;
    state.stepResults[fieldId] = step;

    const allRequired = config.artifactFields
      .filter((field) => !field.added)
      .every((field) => state.stepResults[field.id]?.passed);
    if (allRequired) this.pass(index);
  }

  /** Records an all-at-once phase's result. */
  recordResult(index: number, result: JudgeResult): void {
    const state = this.phases[index];
    this.remember(index, 'phase', state.attempt, result);
    state.result = result;
    if (result.passed) this.pass(index);
    else state.attempt += 1;
  }

  /**
   * A Run or Submit finished. Once the student has reached Implement, each one is
   * an attempt (Implement's `attempt` counts them, passing or not), and one that
   * failed is answered. A passing one drops any reply still coming about older code.
   */
  async codeRan(
    context: SolveWindowContext,
    execution: { runType: 'run' | 'submit'; publicTestResults: readonly unknown[]; submittedCode: string }
  ): Promise<void> {
    if (!implementReached(this.phases)) return;
    const state = this.phases[PHASES.findIndex((p) => p.phase === 'implement')];
    const attempt = state.attempt;
    state.attempt += 1;
    if (wantsCodeFeedback(this.phases, this.hasApiKey, execution.publicTestResults as { success: boolean }[])) {
      await this.requestCodeFeedback(context, execution, attempt);
    } else {
      this.dropPendingCodeFeedback();
      this.persist();
    }
  }

  /**
   * Ask what to say about code that failed a Run or Submit, and keep the reply on
   * Implement. Only the newest request's reply is kept; a failed request leaves
   * the earlier feedback as it was.
   */
  private async requestCodeFeedback(
    context: SolveWindowContext,
    execution: { runType: 'run' | 'submit'; publicTestResults: readonly unknown[]; submittedCode: string },
    attempt: number
  ): Promise<void> {
    const index = PHASES.findIndex((p) => p.phase === 'implement');
    const state = this.phases[index];
    const history = state.codeFeedback
      .slice(0, 5)
      .reverse()
      .map(({ situation, focus, nudge }) => ({ situation, focus, nudge }));
    this.codeFeedbackPending += 1;
    try {
      const { current, value } = await this.codeFeedbackRequests.run(() =>
        codeFeedback({
          sessionId: this.sessionId,
          problemId: context.problem.id,
          code: execution.submittedCode,
          runType: execution.runType,
          attempt,
          priorArtifacts: this.priorArtifacts(index),
          history,
          run: toCodeRun(execution.publicTestResults)
        })
      );
      if (!current) return;
      state.codeFeedback.unshift({
        attempt,
        runType: execution.runType,
        situation: value.situation,
        focus: value.focus,
        nudge: value.nudge
      });
      this.persist();
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.codeFeedbackPending -= 1;
    }
  }

  /** A Run or Submit that passed: any reply still coming about older code is no longer about this code. */
  private dropPendingCodeFeedback(): void {
    this.codeFeedbackRequests.cancel();
  }

  /**
   * The researcher's participant tag. Tags this session, or (`next`) starts a fresh
   * session on this problem tagged for the next participant, and returns the id of
   * the session the page should now be on.
   */
  async tagParticipant(problemId: string, participant: string, next: boolean): Promise<string> {
    const { sessionId } = await setParticipant({ sessionId: this.sessionId, problemId, participant, next });
    if (!next) this.participant = participant.trim();
    return sessionId;
  }

  /** Opens an already-unlocked phase; does nothing for one the student hasn't reached. */
  open(index: number): void {
    if (!this.phases[index]?.unlocked) return;
    this.current = index;
    this.error = null;
  }

  /**
   * A researcher's override: move the student on from `index` without a pass. The
   * phase is marked `advanced` (it reads "Moved on", never "Passed") and the
   * override is recorded. Does nothing for a passed phase or the last one.
   */
  moveOn(index: number, reason: string): void {
    const state = this.phases[index];
    const next = PHASES[index + 1];
    if (!state || !next || state.passed) return;
    state.advanced = true;
    this.phases[index + 1].unlocked = true;
    this.open(index + 1);
    this.telemetry.record(CLIVE_EVENT.researcherOverride, {
      from_phase: PHASES[index].phase,
      to_phase: next.phase,
      attempt: state.attempt,
      reason
    });
    this.persist();
  }

  /** Marks a phase passed and unlocks the next one. */
  pass(index: number): void {
    this.phases[index].passed = true;
    if (this.phases[index + 1]) this.phases[index + 1].unlocked = true;
  }

  /**
   * Earlier phases' filled fields, carried into a later phase's judge call. An
   * added case carries forward only once it has passed: a wrong extra case must
   * not mislead the plan.
   */
  priorArtifacts(uptoIndex: number): { label: string; fields: { label: string; value: ArtifactValue }[] }[] {
    const out: { label: string; fields: { label: string; value: ArtifactValue }[] }[] = [];
    for (let i = 0; i < uptoIndex; i++) {
      const config = PHASES[i];
      const state = this.phases[i];
      const fields = this.inPlay(i)
        .filter(
          (field) =>
            isFilled(state.artifact[field.id]) && (!field.added || state.stepResults[field.id]?.passed === true)
        )
        .map((field) => ({ label: field.label, value: state.artifact[field.id] }));
      if (fields.length) out.push({ label: config.label, fields });
    }
    return out;
  }
}

const sessions = new SvelteMap<string, CliveSession>();

/**
 * The one {@link CliveSession} for a practice session, created on first use.
 * Lives for the page's lifetime, not any one window's -- closing and reopening a
 * CLive panel does not lose progress. Progress past a reload is restored from
 * `PracticeSession.extension_data.clive`.
 *
 * Creating the session writes state (the map it is registered in, and the
 * `$state` fields of a new instance), and a component may call this while a
 * `$derived` is evaluating -- which Svelte forbids as `state_unsafe_mutation`.
 * The lookup is therefore untracked: obtaining the session is a lookup, not a
 * reactive computation, and callers read the returned object's `$state` to stay
 * reactive.
 */
export function cliveSessionFor(context: SolveWindowContext): CliveSession {
  return untrack(() => {
    let session = sessions.get(context.practiceSession.id);
    if (!session) {
      session = new CliveSession(context);
      sessions.set(context.practiceSession.id, session);
    }
    return session;
  });
}
