/**
 * Feedback one thing at a time, on the question it is about. After a failed
 * submit the student sees only the requirement the nudge picked, on the question
 * that requirement is about, under "Start here"; another question with a
 * required failure gets the team's line for each; optional points wait until the
 * submit passes. The full list of requirements is not put in front of a stepped
 * phase at all.
 *
 * A port of the prototype's `fieldStates`, `startHere`, `renderFieldFeedback`
 * and question-tab marks (`clive-userflow/src/clive/studio/static/student.html`).
 * Plain TypeScript, so the windows and the tests share one copy of the rules; the
 * wording is the prototype's.
 */
import type { JudgeResult, Verdict } from './cliveSession.svelte';

/** Said under the one failure shown when there is more than one: the rest come on the next submit. */
export const MORE_TO_FIX = "There may be other things to fix. Submit again once this one's done and I'll check.";

/**
 * A requirement stated alone, as a plain fact, read to a first-term student as
 * praise; this words it as something still to do: `Check this: …`. The first
 * letter is lowered only when the second is lower case too, so a leading "C" or
 * "I" stays as written.
 */
export const notYet = (text: string): string =>
  `Check this: ${/^[A-Z][a-z]/.test(text || '') ? text[0].toLowerCase() + text.slice(1) : text || ''}`;

/** One question's failures after a submit, required and optional apart. */
export interface FieldVerdicts {
  blocking: Verdict[];
  advisory: Verdict[];
}

/** What one question shows after a submit; `null` is nothing at all. */
export type FieldFeedback =
  /** The question the nudge is about: its line, a computed verdict's check, and the guiding questions. */
  | { kind: 'start'; lead: string; check: string | null; nudge: string; more: boolean }
  /** Another question with a required failure: one line per failing requirement. */
  | { kind: 'fix'; lines: string[] }
  /** A passed submit's optional points on this question. */
  | { kind: 'look'; points: { notMet: string; explain: string }[] }
  /** A case of a per-step phase that passed, which has no phase-level banner of its own. */
  | { kind: 'case_passed' };

const isBlocking = (v: Verdict) => v.verdict === 'FAIL' && v.gate !== 'advisory';

/**
 * Each question's failures, from the verdicts tagged to it. A question no
 * failing verdict names has no entry, and reads as met.
 */
export function fieldStates(result: JudgeResult | null | undefined): Record<string, FieldVerdicts> {
  const out: Record<string, FieldVerdicts> = {};
  for (const v of result?.verdicts ?? []) {
    if (v.verdict !== 'FAIL') continue;
    for (const id of v.fields ?? []) {
      const state = (out[id] ??= { blocking: [], advisory: [] });
      (v.gate === 'advisory' ? state.advisory : state.blocking).push(v);
    }
  }
  return out;
}

/**
 * The question a failed submit opens on: the first one the nudge's focus is
 * about, or, if the nudge could not be written, the first with a required
 * failure; `fallback` (the question on screen) when neither names one.
 */
export function startHere(result: JudgeResult, fieldIds: readonly string[], fallback: number): number {
  const states = fieldStates(result);
  const want = result.nudge?.focus_fields?.[0] ?? fieldIds.find((id) => (states[id]?.blocking.length ?? 0) > 0);
  const j = want === undefined ? -1 : fieldIds.indexOf(want);
  return j >= 0 ? j : fallback;
}

/** What to do with a case a computed verdict failed: which kind of problem, never its answer. */
function caseCheck(v: Verdict): string | null {
  if (v.outside_rules?.length) {
    return "The program can't use this input. Check that it follows the problem's rules and is typed the way the examples are.";
  }
  if (v.recheck?.length) return "The expected output doesn't match the problem's rule. Trace it again.";
  return null;
}

/**
 * What one question shows after a submit. The nudge goes only on the question it
 * starts from, with no other failures beside it; another question with a
 * required failure gets the team's line for each; optional points appear only
 * once the submit has passed.
 */
export function fieldFeedback(
  result: JudgeResult | null | undefined,
  fieldId: string,
  perStep: boolean
): FieldFeedback | null {
  if (!result) return null;
  const state = fieldStates(result)[fieldId] ?? { blocking: [], advisory: [] };
  const n = result.nudge;

  if (n && n.focus_fields?.[0] === fieldId) {
    const others = state.blocking.filter((v) => v.criterion_id !== n.focus_id);
    const focused = state.blocking.find((v) => v.criterion_id === n.focus_id);
    return {
      kind: 'start',
      // The team's direct line for this requirement when it has one.
      lead: n.focus_not_met || notYet(n.focus_text ?? ''),
      check: focused ? caseCheck(focused) : null,
      nudge: n.nudge,
      more: others.length > 0 || result.verdicts.filter(isBlocking).length > 1
    };
  }

  if (state.blocking.length) {
    return { kind: 'fix', lines: state.blocking.map((v) => caseCheck(v) || v.explain || v.criterion_text || '') };
  }

  // This result's pass, not the phase's: a phase passed earlier and failed on
  // resubmit shows the required points alone, like any failed submit.
  if (result.passed && state.advisory.length) {
    return {
      kind: 'look',
      // The direct line first (what is missing), then what the point asks for.
      points: state.advisory.map((v) => ({
        notMet: v.not_met ?? '',
        explain: v.explain || (v.not_met ? '' : (v.criterion_text ?? ''))
      }))
    };
  }

  if (perStep && result.passed) return { kind: 'case_passed' };
  return null;
}

/**
 * A question's mark on the tabs that switch between them: `bad` while a
 * required point fails on it, `look` once passed with an optional point worth a
 * look, `ok` otherwise, and nothing before a first submit.
 */
export function fieldMark(result: JudgeResult | null | undefined, fieldId: string): '' | 'bad' | 'ok' | 'look' {
  if (!result) return '';
  const state = fieldStates(result)[fieldId];
  if (state?.blocking.length) return 'bad';
  return result.passed && state?.advisory.length ? 'look' : 'ok';
}

/** The box of a case each Cases requirement is about. */
const CASE_PART: Record<string, 'input' | 'output' | 'working'> = {
  case_is_concrete: 'input',
  outputs_are_correct: 'output',
  output_format_matches_statement: 'output',
  work_is_shown: 'working'
};

/**
 * Which box of a case the current feedback is about, so the page can mark it:
 * a round 6 note found the feedback named the problem but left the student to
 * guess which box to change.
 */
export function casePartFor(focusId: string | undefined): 'input' | 'output' | 'working' | null {
  return (focusId && CASE_PART[focusId]) || null;
}
