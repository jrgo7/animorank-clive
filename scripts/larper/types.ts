/** The shapes the larper's modules share. See `docs/superpowers/specs/2026-11-14-larper-design.md`. */

export type PhaseId = 'problem_definition' | 'case_design' | 'algorithm_design' | 'implement';
export const PHASES: PhaseId[] = ['problem_definition', 'case_design', 'algorithm_design', 'implement'];

/** What the team expects CLive to do with a category. Every key is optional; a blank one is not compared. */
export interface Expect {
  blocks?: boolean;
  /** Criterion ids that should come back unmet, required or optional. */
  fails?: string[];
  /** Situation ids, any one of which is acceptable. */
  situations?: string[];
}

/** One kind of student answer in one phase. */
export interface Category {
  id: string;
  /** The name in the team's document. */
  name: string;
  /** Told to the larper: what such a student writes. Never names a requirement. */
  writes: string;
  expect: Expect | null;
}

export interface Answer {
  problemId: string;
  phase: PhaseId;
  category: string;
  /** 1-based. */
  variant: number;
  /** Keyed by the phase's field ids. */
  artifact: Record<string, unknown>;
  writtenBy: 'larper' | 'hand';
  model?: string;
  /** The larper's reply could not be used. */
  error?: string;
}

/** A problem's known-good answers, one artifact per phase, each of which passed CLive. */
export type Baseline = Partial<Record<PhaseId, Record<string, unknown>>>;

export interface Result {
  answer: Answer;
  /** 2 is the repeat submit. */
  pass: 1 | 2;
  /** Null when the row errored. */
  blocked: boolean | null;
  /** Required points that failed. */
  failed: string[];
  advisoryUnmet: string[];
  /** Null when CLive gave no feedback. */
  situation: string | null;
  feedback: string;
  focusFields: string[];
  observed: { compiled?: boolean; publicPassed?: boolean };
  /** The answer is mechanically not what its category asked for. */
  offCategory: boolean;
  /** Against the category's `expect`; null when that is blank. */
  matches: boolean | null;
  /** Submit's log record, or the code feedback. */
  record: unknown;
  error?: string;
  ms: number;
}
