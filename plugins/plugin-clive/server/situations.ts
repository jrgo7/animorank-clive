/**
 * The situations a student can be in, for the one feedback call that still decides
 * one first: Implement's code feedback (`codeNudge.ts`). Ids and meanings are the
 * spec's table (`docs/superpowers/specs/2026-10-25-situation-feedback-design.md`);
 * the list ends with `other`, so a model is never forced into a wrong box.
 *
 * Problem, Cases and Design had lists here too until the hint ladder (nudge v9),
 * where code picks the requirement and the level instead.
 */
export const SITUATIONS = {
  implement: ['syntax_following_plan', 'departs_from_plan', 'plan_is_wrong', 'far_from_plan', 'other']
} as const satisfies Record<string, readonly string[]>;

/** `id` when the phase lists it, `other` otherwise: an unexpected answer is never an error. */
export function situationOr(phase: string, id: string): string {
  const listed: readonly string[] = (SITUATIONS as Record<string, readonly string[]>)[phase] ?? [];
  return listed.includes(id) ? id : 'other';
}
