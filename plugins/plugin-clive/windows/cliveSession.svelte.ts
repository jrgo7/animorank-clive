import { SvelteMap } from 'svelte/reactivity';
import type { JsonValue } from '@zenstackhq/orm';
import { toJsonValue, type IntoJsonValue } from '$lib/types/utils';
import { savePracticeSession } from '$lib/practiceSession/api';
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

export interface HintEntry {
  diagnosis: string;
  hint: string;
  criterion_text: string;
  attempt: number;
}

export interface Verdict {
  criterion_id: string;
  criterion_text?: string;
  verdict: 'PASS' | 'FAIL';
  gate: 'gating' | 'advisory';
  explain?: string;
  recheck?: string[];
}

export interface NudgeResult {
  summary: string;
  nudge: string;
  reason: string;
  focus_id: string;
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
    hints: HintEntry[];
  }[];
}

const PERSIST_KEY = 'clive';
const PERSIST_VERSION = 1;
const SAVE_DEBOUNCE_MS = 500;

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
  hints: HintEntry[] = $state([]);

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
  /** `'run'` never appears: the Implement phase's compiling and running is AnimoRank's own submit flow. */
  busy: 'hint' | 'submit' | null = $state(null);
  busySince: number | null = $state(null);
  error: string | null = $state(null);
  /** Whether a model provider is configured; the Hint button is disabled when not. */
  hasApiKey: boolean = $state(true);

  private readonly sessionId: string;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: SolveWindowContext) {
    this.sessionId = context.practiceSession.id;
    this.phases = PHASES.map((config, i) => new PhaseState(config, context.editorState.code, i === 0));
    this.restore(context.practiceSession.extension_data);
    void this.refreshBoot();
  }

  private async refreshBoot(): Promise<void> {
    try {
      const response = await fetch('/plugin-api/clive/boot');
      if (response.ok) this.hasApiKey = ((await response.json()) as { hasApiKey?: boolean }).hasApiKey !== false;
    } catch {
      // The key gate is a courtesy; the server's own error is the fallback.
    }
  }

  private restore(extensionData: unknown): void {
    const stored = extensionData as { clive?: PersistedState } | null | undefined;
    const persisted = stored?.clive;
    if (!persisted || persisted.version !== PERSIST_VERSION || persisted.phases?.length !== PHASES.length) {
      return;
    }
    this.current = persisted.current ?? 0;
    persisted.phases.forEach((saved, i) => {
      const phase = this.phases[i];
      Object.assign(phase, {
        artifact: saved.artifact,
        attempt: saved.attempt,
        passed: saved.passed,
        advanced: saved.advanced,
        unlocked: saved.unlocked,
        step: saved.step,
        added: saved.added,
        stepResults: saved.stepResults ?? {},
        result: saved.result,
        hints: saved.hints ?? []
      });
    });
  }

  private snapshot(): JsonValue {
    const state: PersistedState = {
      version: PERSIST_VERSION,
      current: this.current,
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
        hints: $state.snapshot(phase.hints) as HintEntry[]
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
   */
  persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void savePracticeSession(this.sessionId, {
        extension_data: { [PERSIST_KEY]: this.snapshot() }
      }).catch((cause: unknown) => {
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

  /** Records one step's result and passes the phase once every required step has passed. */
  completeStep(index: number, fieldId: string, result: JudgeResult): void {
    const config = PHASES[index];
    const state = this.phases[index];
    const step = state.stepResults[fieldId] ?? { result: null, passed: false, attempt: 1 };
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
    state.result = result;
    if (result.passed) this.pass(index);
    else state.attempt += 1;
  }

  /** Opens an already-unlocked phase; does nothing for one the student hasn't reached. */
  open(index: number): void {
    if (!this.phases[index]?.unlocked) return;
    this.current = index;
    this.error = null;
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
 */
export function cliveSessionFor(context: SolveWindowContext): CliveSession {
  let session = sessions.get(context.practiceSession.id);
  if (!session) {
    session = new CliveSession(context);
    sessions.set(context.practiceSession.id, session);
  }
  return session;
}
