/**
 * The entries the CLive page records into the practice session's history
 * (`TelemetryService.record` → `/api/updateHistory`).
 *
 * The vocabulary follows the prototype's own `logEvent` events, so an analysis
 * over a session reads the same things here as it did there. The prototype's
 * server-side records are written by this plugin's server into the same history
 * (see `../server/sessionLog.ts`): `CLIVE_SUBMIT` (the work judged, the
 * reference check, every verdict with its evidence, the nudge), `CLIVE_STUCK`
 * (the ask, the diagnosis and the reply), `CLIVE_LLM_CALL` (one per model call)
 * and `CLIVE_ERROR` (a submit or stuck ask that failed). What each page entry's
 * `data` holds:
 *
 * - `CLIVE_PROBLEM_LOAD` — `{ problem, restored, phase }`: the solve page opened
 *   for a problem, whether saved CLive work was found for it, and the phase it
 *   resumed in. One per page load, so it also marks where each sitting starts.
 * - `CLIVE_PHASE_OPEN` — `{ phase, via }`: a phase was opened; `via` is `track`
 *   (its tile in the phase strip) or `continue` (the way-on button).
 * - `CLIVE_PROBLEM_READ` — `{ phase }`: the statement alone was left behind and
 *   the first question opened.
 * - `CLIVE_CASE_ADDED`, `CLIVE_CASE_REMOVED` — `{ phase, cases }`: the number of
 *   cases then in play.
 * - `CLIVE_LIVE_CHECK_READY` — `{ load_ms }`: clangd in the student's browser
 *   answered its handshake, and how long it took; `CLIVE_LIVE_CHECK_FAILED` —
 *   `{ reason }`: it could not start, or gave up after three unanswered checks.
 *   A session with neither never ran live checking (the switch, or no vendored
 *   clangd on the machine serving the plugin).
 * - `CLIVE_LIVE_CHECK` — `{ problem, diagnostics }`: the set of squiggles
 *   changed, as `[{ line, kind }]` — never the code, which the next run or
 *   submit already records.
 * - `CLIVE_LIVE_RAW_TOGGLE` — `{ on }`: the "show the compiler's own words" box.
 */
export const CLIVE_EVENT = {
  problemLoad: 'CLIVE_PROBLEM_LOAD',
  phaseOpen: 'CLIVE_PHASE_OPEN',
  problemRead: 'CLIVE_PROBLEM_READ',
  caseAdded: 'CLIVE_CASE_ADDED',
  caseRemoved: 'CLIVE_CASE_REMOVED',
  liveCheckReady: 'CLIVE_LIVE_CHECK_READY',
  liveCheckFailed: 'CLIVE_LIVE_CHECK_FAILED',
  liveCheck: 'CLIVE_LIVE_CHECK',
  liveRawToggle: 'CLIVE_LIVE_RAW_TOGGLE'
} as const;
