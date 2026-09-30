import { SvelteMap } from 'svelte/reactivity';
import { PHASES, type ArtifactField, type CaseRow, type PhaseConfig } from './phase';

export type ArtifactValue = string | CaseRow[];

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

export function blankRow(): CaseRow {
  return { input: '', output: '', working: '' };
}

function blankValueFor(field: ArtifactField, startingCode: string): ArtifactValue {
  if (field.kind === 'code') return startingCode;
  if (field.kind === 'cases') return [blankRow()];
  return '';
}

/** Whether a field's value holds anything a phase can be judged on. */
export function isFilled(value: ArtifactValue | undefined): boolean {
  if (Array.isArray(value)) return value.some(rowFilled);
  return typeof value === 'string' && value.trim() !== '';
}

function rowFilled(row: CaseRow): boolean {
  return !!(row.input.trim() || row.output.trim() || row.working.trim());
}

/** One phase's working state: what the student has written, and what came back for it. */
export class PhaseState {
  artifact: Record<string, ArtifactValue> = $state({});
  attempt: number = $state(1);
  passed: boolean = $state(false);
  /** Set by a researcher override that moved the student on without a pass; there is no override UI yet (see the plugin's README notes), but the flag is here so the track can distinguish it from a real pass once one exists. */
  advanced: boolean = $state(false);
  unlocked: boolean = $state(false);
  result: JudgeResult | null = $state(null);
  hints: HintEntry[] = $state([]);

  constructor(config: PhaseConfig, startingCode: string) {
    this.artifact = Object.fromEntries(config.artifactFields.map((f) => [f.id, blankValueFor(f, startingCode)]));
  }
}

/**
 * All four phases for one practice session, and which one is open. The
 * counterpart of the prototype's global `S` object in `student.html`, but
 * scoped to one practice session rather than the whole page, and reactive via
 * Svelte 5 runes instead of a manual `render()` call after every mutation.
 *
 * One instance per practice session, shared by every CLive window through
 * {@link cliveSessionFor} -- the phase tracker and the four phase windows all
 * read and write the same instance, the same way AnimoRank's own
 * `SolveWindowContext` is shared across its own windows.
 */
export class CliveSession {
  readonly phases: PhaseState[];
  current: number = $state(0);
  /**
   * `'run'` never appears here: the Implement phase's compiling and running is
   * AnimoRank's own `context.testCaseResults`/native Submit flow (see
   * `PhaseWindowContent.svelte`), not something this plugin's UI does itself.
   */
  busy: 'hint' | 'submit' | null = $state(null);
  busySince: number | null = $state(null);
  error: string | null = $state(null);

  constructor(startingCode: string) {
    this.phases = PHASES.map((config, i) => {
      const state = new PhaseState(config, startingCode);
      state.unlocked = i === 0;
      return state;
    });
  }

  /** Earlier phases' filled fields, carried into a later phase's judge call as context. */
  priorArtifacts(uptoIndex: number): { label: string; fields: { label: string; value: ArtifactValue }[] }[] {
    const out: { label: string; fields: { label: string; value: ArtifactValue }[] }[] = [];
    for (let i = 0; i < uptoIndex; i++) {
      const config = PHASES[i];
      const state = this.phases[i];
      const fields = config.artifactFields
        .filter((f) => isFilled(state.artifact[f.id]))
        .map((f) => ({ label: f.label, value: state.artifact[f.id] }));
      if (fields.length) out.push({ label: config.label, fields });
    }
    return out;
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
}

const sessions = new SvelteMap<string, CliveSession>();

/**
 * The one {@link CliveSession} for a practice session, created on first use.
 * Lives for the page's lifetime, not any one window's -- closing and
 * reopening a CLive panel does not lose progress. Not yet persisted past a
 * reload: that's `PracticeSession.extension_data` via `savePracticeSession`
 * (see `$lib/practiceSession/api`), left for once the phases are actually
 * judged server-side.
 */
export function cliveSessionFor(practiceSessionId: string, startingCode: string): CliveSession {
  let session = sessions.get(practiceSessionId);
  if (!session) {
    session = new CliveSession(startingCode);
    sessions.set(practiceSessionId, session);
  }
  return session;
}
