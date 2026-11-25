/**
 * Feedback one thing at a time, on the question it is about: ported from
 * `clive-userflow/src/clive/studio/static/student.html` (`fieldStates`,
 * `startHere`, `renderFieldFeedback` and the question tabs' marks).
 */
import { describe, expect, it } from 'vitest';
import * as feedback from './windows/feedback';
import {
  MORE_TO_FIX,
  canEscalate,
  fieldFeedback,
  fieldMark,
  fieldStates,
  keptTurns,
  levelFor,
  migrateTurns,
  startHere
} from './windows/feedback';
import type { JudgeResult, Verdict } from './windows/cliveSession.svelte';

const FIELDS = ['summary', 'inputs', 'outputs'];

function verdict(id: string, fields: string[], overrides: Partial<Verdict> = {}): Verdict {
  return {
    criterion_id: id,
    criterion_text: `${id} text`,
    not_met: `${id} not met`,
    verdict: 'FAIL',
    gate: 'gating',
    explain: `${id} explain`,
    recheck: [],
    outside_rules: [],
    fields,
    ...overrides
  };
}

function result(verdicts: Verdict[], overrides: Partial<JudgeResult> = {}): JudgeResult {
  const blocking = verdicts.filter((v) => v.verdict === 'FAIL' && v.gate !== 'advisory');
  return {
    passed: blocking.length === 0,
    verdicts,
    missing_ids: [],
    advisory_unmet: verdicts.filter((v) => v.verdict === 'FAIL' && v.gate === 'advisory').map((v) => v.criterion_id),
    ...overrides
  };
}

/** A failed Problem submit: Inputs misses two requirements, Outputs one, and the nudge picked `constraints_noted`. */
function failedProblem(): JudgeResult {
  return result(
    [
      verdict('novel_wording', ['summary'], { verdict: 'PASS' }),
      verdict('constraints_noted', ['inputs']),
      verdict('input_types', ['inputs']),
      verdict('output_types', ['outputs']),
      // Problem has no optional point since criteria v10, so Design's stands in for one here
      // and below: the page reads a point's question and gate from the verdict, not its id.
      verdict('values_are_tracked', ['inputs'], { gate: 'advisory' })
    ],
    {
      nudge: {
        level: 'hint',
        nudge: 'What values can each input take?',
        focus_id: 'constraints_noted',
        focus_text: 'Every constraint on the inputs is written down.',
        focus_not_met: 'You should write down every constraint the problem puts on the inputs.',
        focus_fields: ['inputs'],
        failing: [
          { id: 'constraints_noted', text: 'constraints' },
          { id: 'input_types', text: 'types' },
          { id: 'output_types', text: 'outputs' }
        ]
      }
    }
  );
}

describe('each question’s failures', () => {
  it('groups the failing requirements by the question they are about, required and optional apart', () => {
    const states = fieldStates(failedProblem());
    expect(states.inputs.blocking.map((v) => v.criterion_id)).toEqual(['constraints_noted', 'input_types']);
    expect(states.inputs.advisory.map((v) => v.criterion_id)).toEqual(['values_are_tracked']);
    expect(states.outputs.blocking.map((v) => v.criterion_id)).toEqual(['output_types']);
    // A question no failing verdict names has no entry, and reads as met.
    expect(states.summary).toBeUndefined();
  });
});

describe('where a failed submit opens', () => {
  it('on the first question the nudge is about', () => {
    expect(startHere(failedProblem(), FIELDS, 0)).toBe(1);
  });

  it('on the first question with a required failure, when no nudge came back', () => {
    const r = { ...failedProblem(), nudge: undefined, nudge_error: 'model down' };
    const outputsOnly = { ...r, verdicts: r.verdicts.filter((v) => v.criterion_id === 'output_types') };
    expect(startHere(outputsOnly, FIELDS, 0)).toBe(2);
  });

  it('where the student already is, when nothing points anywhere', () => {
    expect(startHere(result([]), FIELDS, 2)).toBe(2);
  });
});

describe('what one question shows', () => {
  it('starts the student on the nudge’s question with its line and the hint', () => {
    expect(fieldFeedback(failedProblem(), 'inputs', false)).toEqual({
      kind: 'start',
      lead: 'You should write down every constraint the problem puts on the inputs.',
      check: null,
      level: 'hint',
      nudge: 'What values can each input take?',
      prompt: null,
      more: true
    });
  });

  it('puts the prompt "I\'m stuck" brought under the hint, on the same card', () => {
    const r = failedProblem();
    r.escalation = { ...r.nudge!, level: 'prompt', nudge: 'Does the problem give a smallest or largest n?' };
    expect(fieldFeedback(r, 'inputs', false)).toMatchObject({
      kind: 'start',
      level: 'hint',
      nudge: 'What values can each input take?',
      prompt: 'Does the problem give a smallest or largest n?'
    });
  });

  it('shows a prompt the submit itself brought as the card’s text, with nothing under it', () => {
    const r = failedProblem();
    r.nudge = { ...r.nudge!, level: 'prompt', nudge: 'Which values of n does the problem allow?' };
    expect(fieldFeedback(r, 'inputs', false)).toMatchObject({
      level: 'prompt',
      nudge: 'Which values of n does the problem allow?',
      prompt: null
    });
  });

  it('reads a result saved before the ladder, with no level, as a hint', () => {
    const r = failedProblem();
    delete r.nudge!.level;
    expect(fieldFeedback(r, 'inputs', false)).toMatchObject({ kind: 'start', level: 'hint' });
  });

  it('words the requirement as something to check when it has no line of its own', () => {
    const r = failedProblem();
    r.nudge!.focus_not_met = '';
    expect(fieldFeedback(r, 'inputs', false)).toMatchObject({
      lead: 'Check this: every constraint on the inputs is written down.'
    });
  });

  it('says the rest will come on the next submit only when something else blocks', () => {
    const r = failedProblem();
    r.verdicts = r.verdicts.filter((v) => v.criterion_id !== 'input_types' && v.criterion_id !== 'output_types');
    expect(fieldFeedback(r, 'inputs', false)).toMatchObject({ kind: 'start', more: false });
  });

  it('shows another failing question its own lines, without the nudge', () => {
    expect(fieldFeedback(failedProblem(), 'outputs', false)).toEqual({ kind: 'fix', lines: ['output_types explain'] });
  });

  it('says what to do with a case a computed verdict failed, never its answer', () => {
    const wrong = result([verdict('outputs_are_correct', ['normal_cases'], { recheck: ['Case 1'] })]);
    const outside = result([verdict('outputs_are_correct', ['normal_cases'], { outside_rules: ['Case 1'] })]);
    expect(fieldFeedback(wrong, 'normal_cases', true)).toEqual({
      kind: 'fix',
      lines: ["The expected output doesn't match the problem's rule. Trace it again."]
    });
    expect(fieldFeedback(outside, 'normal_cases', true)).toEqual({
      kind: 'fix',
      lines: [
        "The program can't use this input. Check that it follows the problem's rules and is typed the way the examples are."
      ]
    });

    // ...and beside the nudge, when the computed verdict is the one it picked.
    wrong.nudge = { ...failedProblem().nudge!, focus_id: 'outputs_are_correct', focus_fields: ['normal_cases'] };
    expect(fieldFeedback(wrong, 'normal_cases', true)).toMatchObject({
      kind: 'start',
      check: "The expected output doesn't match the problem's rule. Trace it again."
    });
  });

  it('keeps optional points back until the submit passes, then offers them as worth a look', () => {
    const optional = verdict('values_are_tracked', ['inputs'], { gate: 'advisory' });
    const failed = result([verdict('output_types', ['outputs']), optional]);
    expect(fieldFeedback(failed, 'inputs', false)).toBeNull();

    expect(fieldFeedback(result([optional]), 'inputs', false)).toEqual({
      kind: 'look',
      points: [{ notMet: 'values_are_tracked not met', explain: 'values_are_tracked explain' }]
    });
  });

  it('says a case passed, and nothing for a question of a phase judged all at once', () => {
    expect(fieldFeedback(result([]), 'normal_cases', true)).toEqual({ kind: 'case_passed' });
    expect(fieldFeedback(result([]), 'summary', false)).toBeNull();
    expect(fieldFeedback(null, 'summary', false)).toBeNull();
  });

  it('says once that more may come', () => {
    expect(MORE_TO_FIX).toBe("There may be other things to fix. Submit again once this one's done and I'll check.");
  });
});

describe('the question tabs', () => {
  it('mark a question that blocks, one that is fine, and one passed with a point worth a look', () => {
    const r = failedProblem();
    expect(fieldMark(r, 'inputs')).toBe('bad');
    expect(fieldMark(r, 'summary')).toBe('ok');
    expect(fieldMark(result([verdict('values_are_tracked', ['inputs'], { gate: 'advisory' })]), 'inputs')).toBe('look');
    expect(fieldMark(null, 'inputs')).toBe('');
  });
});

describe('the hint ladder', () => {
  const turn = (attempt: number, focus_id: string, level: 'hint' | 'prompt' = 'hint') => ({
    attempt,
    level,
    focus_id,
    nudge: `n${attempt}`
  });

  it('puts a requirement at hint until it is escalated, then at prompt for good', () => {
    expect(levelFor([], 'work_is_shown')).toBe('hint');
    expect(levelFor([turn(1, 'work_is_shown'), turn(2, 'work_is_shown')], 'work_is_shown')).toBe('hint');
    const escalated = [
      turn(1, 'work_is_shown'),
      turn(1, 'work_is_shown', 'prompt'),
      turn(2, 'work_is_shown', 'prompt')
    ];
    expect(levelFor(escalated, 'work_is_shown')).toBe('prompt');
    // Another requirement starts at hint.
    expect(levelFor(escalated, 'case_is_concrete')).toBe('hint');
  });

  it('offers "I\'m stuck" only after a failed submit, while its requirement is at hint', () => {
    const hinted = [turn(1, 'work_is_shown')];
    expect(canEscalate(true, hinted, 'work_is_shown')).toBe(true);
    expect(canEscalate(false, hinted, 'work_is_shown')).toBe(false);
    expect(canEscalate(true, [], undefined)).toBe(false);
    expect(canEscalate(true, [...hinted, turn(1, 'work_is_shown', 'prompt')], 'work_is_shown')).toBe(false);
  });

  it('keeps the last twenty turns, and never drops the turn that escalated a requirement', () => {
    const turns = [
      turn(1, 'work_is_shown', 'prompt'),
      ...Array.from({ length: 25 }, (_, i) => turn(i + 2, 'case_is_concrete'))
    ];
    const kept = keptTurns(turns);
    expect(kept).toHaveLength(21);
    expect(kept[0]).toEqual(turn(1, 'work_is_shown', 'prompt'));
    expect(kept.at(-1)).toEqual(turn(26, 'case_is_concrete'));
    expect(levelFor(kept, 'work_is_shown')).toBe('prompt');
    expect(keptTurns(turns.slice(0, 3))).toEqual(turns.slice(0, 3));
  });

  it('reads turns saved before the ladder: the situation goes, and a turn with no level is a hint', () => {
    expect(
      migrateTurns([
        { attempt: 1, situation: 'not_a_case', focus_id: 'case_is_concrete', nudge: 'Real values?' },
        { attempt: 2, level: 'prompt', focus_id: 'case_is_concrete', nudge: 'Which two numbers?' },
        { nudge: 'no focus' },
        'junk'
      ])
    ).toEqual([
      { attempt: 1, level: 'hint', focus_id: 'case_is_concrete', nudge: 'Real values?' },
      { attempt: 2, level: 'prompt', focus_id: 'case_is_concrete', nudge: 'Which two numbers?' }
    ]);
    expect(migrateTurns(undefined)).toEqual([]);
  });

  it('no longer offers help on the third failed submit', () => {
    expect('helpOffered' in feedback).toBe(false);
    expect('HELP_OFFER' in feedback).toBe(false);
  });
});
