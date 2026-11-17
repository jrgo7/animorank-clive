/**
 * ============================================================================
 *  TEMPORARY LOCAL-DEV ACCESS BYPASS — DO NOT PUSH TO PROD.
 * ============================================================================
 *
 * While on, any Google account may sign in, every signed-in user may read and
 * edit every problem set, problem (hidden ones included) and test case, and
 * students may use the teacher-only actions — regardless of TeacherList,
 * ProblemSetCollaborator, Subscription or `is_global`.
 *
 * Every site it switches off is tagged `DEV_ACCESS_BYPASS`. Before pushing,
 * revert them all and delete this file:
 *
 *   git grep -n DEV_ACCESS_BYPASS
 *
 * As a backstop it is on only under `npm run dev`: `dev` is false in a
 * production build and in `npm run preview` (which the Playwright suite runs
 * against), and Vitest runs in mode `test`, so the unit tests still exercise
 * the real checks.
 */
import { dev } from '$app/environment';

export const DEV_ACCESS_BYPASS = dev && import.meta.env.MODE === 'development';

/** The access `clause` for a Prisma `where`, or no restriction at all while the bypass is on. */
export function unlessDevBypass<T extends object>(clause: T): T | Record<string, never> {
  return DEV_ACCESS_BYPASS ? {} : clause;
}
