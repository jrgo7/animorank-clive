/**
 * The situations a student can be in, per phase: what the feedback calls decide
 * first and answer to. Ids and meanings are the spec's tables
 * (`docs/superpowers/specs/2026-10-25-situation-feedback-design.md`); every list ends
 * with `other`, so a model is never forced into a wrong box.
 */
export const SITUATIONS = {
  problem_definition: [
    'wrote_code',
    'meaning_not_type',
    'program_not_function',
    'pictures_dialogue',
    'copied_statement',
    'missing_detail',
    'other'
  ],
  case_design: [
    'not_a_case',
    'rule_not_worked',
    'wrong_answer',
    'right_answer_wrong_reason',
    'wrong_shape_input',
    'restates_example',
    'low_effort',
    'other'
  ],
  algorithm_design: ['restates_problem', 'not_traceable', 'wrote_c', 'missing_input_or_output', 'other'],
  implement: ['syntax_following_plan', 'departs_from_plan', 'plan_is_wrong', 'far_from_plan', 'other']
} as const satisfies Record<string, readonly string[]>;

/** `id` when the phase lists it, `other` otherwise: an unexpected answer is never an error. */
export function situationOr(phase: string, id: string): string {
  const listed: readonly string[] = (SITUATIONS as Record<string, readonly string[]>)[phase] ?? [];
  return listed.includes(id) ? id : 'other';
}
