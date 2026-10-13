/**
 * The entries CLive records into the practice session's history
 * (`TelemetryService.record` → `/api/updateHistory`).
 *
 * The vocabulary follows the prototype's own `logEvent` events and its
 * server-side `submit`/`stuck` records, so an analysis over a session reads the
 * same things here as it did there. What each entry's `data` holds:
 *
 * - `CLIVE_PROBLEM_LOAD` — `{ problem, restored }`: the solve page opened for a
 *   problem, and whether saved CLive work was found for it.
 * - `CLIVE_PHASE_OPEN` — `{ phase, via }`: a phase was opened; `via` is `track`
 *   (its tile in the phase strip) or `continue` (the way-on button).
 * - `CLIVE_PROBLEM_READ` — `{ phase }`: the statement alone was left behind and
 *   the first question opened.
 * - `CLIVE_CASE_ADDED`, `CLIVE_CASE_REMOVED` — `{ phase, cases }`: the number of
 *   cases then in play.
 * - `CLIVE_SUBMIT` — `{ phase, step, attempt, passed, blocking, advisory_unmet,
 *   missing_ids }`: one submission and what the judge ruled. `step` is the field
 *   a per-step phase submitted, or null.
 * - `CLIVE_STUCK` — `{ phase, field, statement }`: one "what are you stuck on?"
 *   ask. The reply's feedback is not recorded; the diagnosis is on the server's
 *   log line.
 */
export const CLIVE_EVENT = {
  problemLoad: 'CLIVE_PROBLEM_LOAD',
  phaseOpen: 'CLIVE_PHASE_OPEN',
  problemRead: 'CLIVE_PROBLEM_READ',
  caseAdded: 'CLIVE_CASE_ADDED',
  caseRemoved: 'CLIVE_CASE_REMOVED',
  submit: 'CLIVE_SUBMIT',
  stuck: 'CLIVE_STUCK'
} as const;
