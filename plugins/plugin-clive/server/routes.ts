/**
 * The plugin's HTTP surface: `POST /submit`, `POST /escalate`, `POST /code-feedback`,
 * `POST /log-check` and `GET /boot`, served under `/plugin-api/clive` (the plugin's
 * id; see `src/lib/server/index.ts`).
 *
 * `/submit` is the counterpart of the prototype's `/api/student/submit` in
 * `clive-userflow/src/clive/studio/student.py`. The rubric reaches the browser
 * only attached to a verdict here, the reference check's row detail (which holds
 * the reference's own output) is never put in a response, and a nudge's reason —
 * which often names the answer — goes to the session log instead.
 *
 * The hint ladder: a failed `/submit` answers with a nudge on the first failing
 * gate in rubric order, at the level its history says (`hint` until the student
 * escalates that requirement, `prompt` after). `/escalate` is the "I'm stuck"
 * button: it raises the last failed submit's requirement to a prompt, built from
 * the server's own record of that submit, never from verdicts the page sends.
 *
 * Each submit and escalation is recorded in the practice session's history, as
 * the prototype's `_logged` recorded it in the participant's file: one entry per
 * model call, then the record itself — or, when the request failed, an error
 * entry. So a request is only served for the signed-in student's own practice
 * session on that problem.
 */
import { requestUserId, ServerAPI } from '$lib/server/serverAPI';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { JudgeError } from './content/errors';
import { phaseDoc, rubricDoc, type CriterionDoc, type PhaseDoc } from './content/load';
import type { HistoryTurn, ProblemForPrompt } from './content/templates';
import { failingGates, type FailingCriterion } from './criteria';
import { judge, type JudgeOutcome, type Verdict } from './judge';
import { liveTable } from './live';
import { captureLlmCalls } from './llmCalls';
import { codeNudge } from './codeNudge';
import { eventsAfter, watching } from './liveFeed';
import { livePage } from './livePage';
import { levelFor, nudge, pickFocus, type NudgeLevel, type NudgeOutcome } from './nudge';
import { loadCLiveProblem } from './problem';
import { getProvider } from './providers';
import { judgeWithChecks, type CheckResult } from './referenceCheck';
import {
  checkSessionLog,
  latestSubmitRecord,
  ownsAnyPracticeSession,
  ownsPracticeSession,
  requestEntries,
  SESSION_LOG_TYPES,
  startNextSession,
  tagParticipant,
  writeSessionLog,
  type RequestKind,
  type SessionLogEntry
} from './sessionLog';
import { compareCase, cut, isPerStep } from './steps';
import type { CaseRow, PriorArtifact } from './artifact';

const artifactSchema = z.record(z.string(), z.unknown());
const priorArtifactsSchema = z.array(
  z.object({
    label: z.string(),
    fields: z.array(z.object({ label: z.string(), value: z.unknown() }))
  })
);

/**
 * Earlier nudges in a phase (or step), oldest first, as the page keeps them. A turn
 * saved before the hint ladder has a `situation` and no `level`: the situation is
 * dropped (zod strips keys it does not name) and the turn reads as a hint.
 */
const historySchema = z
  .array(
    z.object({
      attempt: z.number(),
      level: z.enum(['hint', 'prompt']).default('hint'),
      focus_id: z.string(),
      nudge: z.string()
    })
  )
  .max(50)
  .default([]);

const submitSchema = z.object({
  /** The practice session the request is recorded in; it must be the caller's. */
  sessionId: z.uuid(),
  phase: z.string(),
  problemId: z.string(),
  artifact: artifactSchema.default({}),
  attempt: z.number().int().positive().default(1),
  priorArtifacts: priorArtifactsSchema.default([]),
  step: z.string().optional(),
  code: z.string().optional(),
  /** Every earlier nudge in this phase (or step): the level is read from all of them, the model sees a few. */
  history: historySchema
});

/**
 * "I'm stuck" on a failed submit. Only where to look and what the page has already
 * shown: the work and the verdicts are read from the server's own record of the
 * last submit, and anything else the page sends is dropped unread.
 */
const escalateSchema = z.object({
  /** The practice session the request is recorded in; it must be the caller's. */
  sessionId: z.uuid(),
  phase: z.string(),
  problemId: z.string(),
  step: z.string().optional(),
  attempt: z.number().int().positive().default(1),
  priorArtifacts: priorArtifactsSchema.default([]),
  history: historySchema
});

/** The most earlier replies a feedback call is shown: enough to notice a repeat. */
const HISTORY_KEPT = 5;

const codeFeedbackSchema = z.object({
  /** The practice session the request is recorded in; it must be the caller's. */
  sessionId: z.uuid(),
  problemId: z.string(),
  code: z.string().default(''),
  runType: z.enum(['run', 'submit']),
  attempt: z.number().int().positive().default(1),
  priorArtifacts: priorArtifactsSchema.default([]),
  history: z
    .array(z.object({ situation: z.string(), focus: z.string(), nudge: z.string() }))
    .max(50)
    .default([]),
  // Public cases only: there is no field a hidden case's input or output could arrive in.
  run: z.object({
    compiled: z.boolean(),
    compilerOutput: z.string().max(20000).default(''),
    cases: z
      .array(z.object({ input: z.string(), expected: z.string(), actual: z.string(), passed: z.boolean() }))
      .max(50)
      .default([]),
    hiddenFailed: z.number().int().min(0).default(0)
  })
});

/** The live reasoning window reads the model's thinking: only from the machine the app runs on. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const liveQuerySchema = z.object({ session: z.uuid(), after: z.coerce.number().int().min(0).default(0) });

const participantSchema = z.object({
  /** The session the researcher is in; it must be the caller's. */
  sessionId: z.uuid(),
  problemId: z.string(),
  participant: z.string().trim().min(1).max(100),
  /** Start a fresh session for this participant instead of tagging the current one. */
  next: z.boolean().default(false)
});

const logCheckSchema = z.object({
  /** The practice session whose history the check writes into; it must be the caller's. */
  sessionId: z.uuid(),
  problemId: z.string()
});

interface ResponseVerdict {
  criterion_id: string;
  criterion_text: string;
  /** The line the student reads above the nudge: what to do, in the criterion's own words. */
  not_met: string;
  verdict: 'PASS' | 'FAIL';
  gate: 'gating' | 'advisory';
  explain: string;
  recheck: string[];
  /** For a computed verdict: the rows whose input the problem does not allow, by label. */
  outside_rules: string[];
  /** Which questions this verdict belongs on, in a stepped phase: where the page shows it. */
  fields: string[];
}

/** A nudge as the page receives it, from `/submit` and `/escalate` alike: no reason, no leak detail. */
interface PageNudge {
  level: NudgeLevel;
  nudge: string;
  focus_id: string;
  focus_text: string;
  focus_not_met: string;
  /** The questions the focused requirement is about: the first is the one the page opens on. */
  focus_fields: string[];
  failing: { id: string; text: string }[];
}

interface SubmitResponse {
  passed: boolean;
  verdicts: ResponseVerdict[];
  missing_ids: string[];
  advisory_unmet: string[];
  nudge?: PageNudge;
  nudge_error?: string;
}

/** The page's nudge, from a nudge outcome. */
function pageNudge(n: NudgeOutcome, applied: CriterionDoc[]): PageNudge {
  return {
    level: n.level,
    nudge: n.nudge,
    focus_id: n.focus_id,
    focus_text: n.focus_text,
    focus_not_met: n.focus_not_met,
    focus_fields: applied.find((c) => c.id === n.focus_id)?.fields ?? [],
    failing: n.failing
  };
}

/** The record's nudge: the page's, with what only the researcher reads. */
function recordedNudge(n: NudgeOutcome, applied: CriterionDoc[]) {
  return { ...pageNudge(n, applied), reason: n.reason, leaks: n.leaks, leak_blocked: n.leak_blocked };
}

/**
 * Where a failed submit stands on the ladder: its focus (the first failing gate in
 * rubric order), every failing gate, the focus's level read from the whole history,
 * and the few turns on that focus the model is shown. Null when nothing gating failed.
 */
function ladderFor(applied: CriterionDoc[], verdicts: Verdict[], history: HistoryTurn[]) {
  const focus = pickFocus(applied, verdicts);
  if (!focus) return null;
  return {
    focus,
    failing: failingGates(applied, verdicts),
    // From every turn, before the window below: an escalation must never fall out of it.
    level: levelFor(history, focus.id),
    turns: history.filter((t) => t.focus_id === focus.id).slice(-HISTORY_KEPT)
  };
}

/** What a nudge needs that a submit has already worked out: the phase as judged, and what it judged. */
interface Judged {
  phase: PhaseDoc;
  problem: ProblemForPrompt;
  artifact: Record<string, unknown>;
  applied: CriterionDoc[];
  verdicts: Verdict[];
  referenceCheck: CheckResult | null;
}

/** The nudge for a ladder rung, with the arguments both routes share. */
function nudgeFor(
  judged: Judged,
  ladder: { focus: FailingCriterion; failing: FailingCriterion[]; turns: HistoryTurn[] },
  level: NudgeLevel,
  attempt: number,
  priorArtifacts: PriorArtifact[],
  liveLabel?: string
): Promise<NudgeOutcome> {
  return nudge({
    phase: judged.phase,
    problem: judged.problem,
    artifact: judged.artifact,
    focus: ladder.focus,
    failing: ladder.failing,
    level,
    attempt,
    priorArtifacts,
    history: ladder.turns,
    referenceCheck: judged.referenceCheck,
    liveLabel
  });
}

export function toResponseVerdicts(verdicts: Verdict[], criteria: CriterionDoc[]): ResponseVerdict[] {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  return verdicts.map((v) => {
    const criterion = byId.get(v.criterion_id);
    return {
      criterion_id: v.criterion_id,
      criterion_text: criterion?.text ?? '',
      not_met: criterion?.not_met ?? '',
      verdict: v.verdict,
      gate: criterion?.gate ?? 'gating',
      explain: criterion?.explain ?? '',
      recheck: v.source === 'reference' && v.verdict === 'FAIL' ? (v.wrong ?? []) : [],
      outside_rules: v.verdict === 'FAIL' ? (v.outside_rules ?? []) : [],
      fields: criterion?.fields ?? []
    };
  });
}

/**
 * The student's work a submit is about: for Implement the code from AnimoRank's
 * editor, sent beside the artifact (the artifact's own copy can be stale, or never
 * filled in), the artifact otherwise.
 */
function studentWork(body: {
  phase: string;
  artifact: Record<string, unknown>;
  code?: string;
}): Record<string, unknown> {
  if (body.phase !== 'implement') return body.artifact;
  return { code: body.code ?? (typeof body.artifact.code === 'string' ? body.artifact.code : '') };
}

/**
 * Judge one submission. Returns the page's response and, beside it, the record
 * the session log keeps: the same response with each verdict's evidence, plus
 * the work judged and the reference check, none of which the page receives.
 *
 * A `check: reference` verdict names rows to trace, never their answers.
 */
async function submit(
  body: z.infer<typeof submitSchema>
): Promise<{ response: SubmitResponse; record: Record<string, unknown> }> {
  const phase = phaseDoc(body.phase);
  const problem = await loadCLiveProblem(body.problemId);
  let criteria = rubricDoc(body.phase).criteria;
  let artifact: Record<string, unknown> = body.artifact;
  let phaseForJudge = phase;
  let referenceCheck: CheckResult | null = null;
  let caseOne: CaseRow | undefined;

  if (phase.phase === 'implement') {
    // The compiler gate is AnimoRank's own Submit flow; by the time the client
    // enables this button the code already passes, so the judge only reviews it
    // against the plan, and every Implement criterion is advisory.
    artifact = studentWork(body);
  } else if (isPerStep(phase)) {
    if (!body.step) {
      throw new JudgeError(`Phase '${phase.phase}' is judged one step at a time; a step is required.`);
    }
    // Taken before `cut`, which keeps only the case being submitted.
    caseOne = compareCase(artifact, body.step);
    const cutPhase = cut(phase, artifact, criteria, body.step);
    phaseForJudge = cutPhase.phase;
    artifact = cutPhase.artifact;
    criteria = cutPhase.criteria;
  }

  let outcome: JudgeOutcome;
  let applied: CriterionDoc[];
  if (phase.phase === 'implement') {
    outcome = await judge(phaseForJudge, problem, artifact, criteria, body.attempt, body.priorArtifacts);
    applied = criteria;
  } else {
    const withChecks = await judgeWithChecks(
      phaseForJudge,
      problem,
      artifact,
      criteria,
      body.attempt,
      body.priorArtifacts,
      undefined,
      undefined,
      caseOne
    );
    outcome = withChecks;
    applied = withChecks.criteria;
    referenceCheck = withChecks.referenceCheck;
  }

  const verdicts = toResponseVerdicts(outcome.verdicts, applied);
  const blocking = verdicts.filter((v) => v.verdict === 'FAIL' && v.gate !== 'advisory');
  const advisoryUnmet = verdicts.filter((v) => v.verdict === 'FAIL' && v.gate === 'advisory');

  const response: SubmitResponse = {
    passed: blocking.length === 0 && outcome.missing_ids.length === 0,
    verdicts,
    missing_ids: outcome.missing_ids,
    advisory_unmet: advisoryUnmet.map((v) => v.criterion_id)
  };

  let recorded: ReturnType<typeof recordedNudge> | undefined;
  const ladder = blocking.length ? ladderFor(applied, outcome.verdicts, body.history) : null;
  if (ladder) {
    // In the same call, so no page can show a failure without its guidance. A nudge
    // that fails is reported beside verdicts that stand on their own.
    try {
      const asJudged = { phase: phaseForJudge, problem, artifact, applied, verdicts: outcome.verdicts, referenceCheck };
      const n = await nudgeFor(asJudged, ladder, ladder.level, body.attempt, body.priorArtifacts);
      response.nudge = pageNudge(n, applied);
      recorded = recordedNudge(n, applied);
    } catch (error) {
      if (!(error instanceof JudgeError)) throw error;
      response.nudge_error = error.message;
    }
  }

  const judged = new Map(outcome.verdicts.map((v) => [v.criterion_id, v]));
  const record = {
    phase_id: phase.phase,
    problem_id: body.problemId,
    attempt: body.attempt,
    step: body.step ?? null,
    artifact: studentWork(body),
    reference_check: referenceCheck,
    response: {
      ...response,
      ...(recorded ? { nudge: recorded } : {}),
      verdicts: response.verdicts.map((v) => {
        const verdict = judged.get(v.criterion_id);
        return {
          ...v,
          evidence: verdict?.evidence ?? '',
          evidence_found: verdict?.evidence_found ?? null,
          confidence: verdict?.confidence ?? null,
          source: verdict?.source ?? 'judge',
          outside_rules: verdict?.outside_rules ?? []
        };
      })
    }
  };

  return { response, record };
}

/** Why an escalation may not go ahead: the page's state and the server's record disagree. */
class Conflict extends Error {}

/** A recorded verdict, back as the judge's: what {@link pickFocus} reads. */
function recordedVerdicts(record: Record<string, unknown>): (Verdict & { gate?: string })[] {
  const response = (record.response ?? {}) as { verdicts?: unknown };
  const rows = Array.isArray(response.verdicts) ? (response.verdicts as Record<string, unknown>[]) : [];
  return rows.map((v) => ({
    criterion_id: String(v.criterion_id ?? ''),
    verdict: v.verdict === 'PASS' ? 'PASS' : 'FAIL',
    evidence: typeof v.evidence === 'string' ? v.evidence : '',
    confidence: v.confidence === 'low' || v.confidence === 'medium' ? v.confidence : 'high',
    source: v.source === 'reference' ? 'reference' : 'judge',
    gate: typeof v.gate === 'string' ? v.gate : undefined
  }));
}

/**
 * The prompt for the last failed submit's requirement, built from the server's own
 * record of that submit: its work, its verdicts and its reference check, with the
 * phase cut to its step as it was judged. Throws {@link Conflict} when there is no
 * failed submit to escalate, or its requirement is already at prompt.
 */
async function escalate(
  body: z.infer<typeof escalateSchema>
): Promise<{ response: PageNudge; record: Record<string, unknown> }> {
  const step = body.step ?? null;
  const record = await latestSubmitRecord(body.sessionId, body.phase, step);
  if (!record) throw new Conflict('There is no submission here to get more help on. Submit first.');
  if ((record.response as { passed?: unknown } | undefined)?.passed === true) {
    throw new Conflict('Your last submission here passed, so there is nothing to get more help on.');
  }

  const phase = phaseDoc(body.phase);
  const problem = await loadCLiveProblem(body.problemId);
  let criteria = rubricDoc(body.phase).criteria;
  let artifact = (record.artifact ?? {}) as Record<string, unknown>;
  let phaseForJudge = phase;
  if (isPerStep(phase)) {
    if (!step) throw new JudgeError(`Phase '${phase.phase}' is judged one step at a time; a step is required.`);
    const cutPhase = cut(phase, artifact, criteria, step);
    phaseForJudge = cutPhase.phase;
    artifact = cutPhase.artifact;
    criteria = cutPhase.criteria;
  }
  // The gates as the submit applied them: a reference check that could not run had
  // made its criterion advisory, and the recorded verdicts carry that.
  const verdicts = recordedVerdicts(record);
  const gates = new Map(verdicts.map((v) => [v.criterion_id, v.gate]));
  const applied = criteria.map((c): CriterionDoc => {
    const gate = gates.get(c.id);
    return gate === 'gating' || gate === 'advisory' ? { ...c, gate } : c;
  });

  const ladder = ladderFor(applied, verdicts, body.history);
  if (!ladder) throw new Conflict('Your last submission here has nothing left to fix.');
  if (ladder.level === 'prompt') throw new Conflict('You already have the most specific help for this one.');

  const attempt = typeof record.attempt === 'number' ? record.attempt : body.attempt;
  const judged = {
    phase: phaseForJudge,
    problem,
    artifact,
    applied,
    verdicts,
    referenceCheck: (record.reference_check ?? null) as CheckResult | null
  };
  const n = await nudgeFor(judged, ladder, 'prompt', attempt, body.priorArtifacts, 'escalation · prompt');
  return {
    response: pageNudge(n, applied),
    record: {
      phase_id: phase.phase,
      problem_id: body.problemId,
      step,
      attempt,
      level: n.level,
      focus_id: n.focus_id,
      history: body.history,
      response: recordedNudge(n, applied)
    }
  };
}

/**
 * Why a request may not go ahead, or null when it may: it needs a signed-in
 * user, and the practice session it names must be theirs, on the problem it
 * names, because that is where its record is written.
 */
async function refusal(
  request: FastifyRequest,
  body: { sessionId: string; problemId: string }
): Promise<{ code: number; message: string } | null> {
  const userId = requestUserId(request);
  if (!userId) return { code: 401, message: 'Sign in to use CLive.' };
  if (!(await ownsPracticeSession(userId, body.sessionId, body.problemId))) {
    return { code: 403, message: 'This practice session is not yours.' };
  }
  return null;
}

/**
 * Whether the signed-in user owns a practice session, on any problem: the live
 * window names only the session. Loopback alone is not enough where the bridge
 * cannot tell the client's address.
 */
async function ownsSession(request: FastifyRequest, sessionId: string): Promise<boolean> {
  const userId = requestUserId(request);
  if (!userId) return false;
  return ownsAnyPracticeSession(userId, sessionId);
}

/** The record of a request that failed, with what it asked for. */
function errorRecord(call: RequestKind, asked: Record<string, unknown>, error: unknown) {
  return {
    type: SESSION_LOG_TYPES.error,
    data: { call, ...asked, error: error instanceof Error ? error.message : String(error) }
  };
}

/** Write the session log, never failing the request over it: the student still gets their answer. */
async function keep(request: FastifyRequest, sessionId: string, entries: SessionLogEntry[]): Promise<void> {
  try {
    await writeSessionLog(sessionId, entries);
  } catch (error) {
    request.log.error({ sessionId, err: error }, 'CLive could not write the session log');
  }
}

class CLiveAPI extends ServerAPI {
  public async fastifyPlugin(): Promise<FastifyPluginCallback> {
    return (app) => {
      app.get('/boot', async (_request, reply) =>
        reply.send({ hasApiKey: getProvider().hasApiKey(), live_check: liveTable() })
      );

      // The live reasoning window (Ctrl+Shift+L) and the events it polls. Loopback
      // only: the reasoning weighs requirements the student has not been shown.
      app.get('/live', async (request, reply) => {
        if (!LOOPBACK.has(request.ip)) return sendError(reply, 'Only from the machine CLive runs on.', 403);
        const parsed = liveQuerySchema.safeParse(request.query);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        if (!(await ownsSession(request, parsed.data.session))) {
          return sendError(reply, 'This practice session is not yours.', 403);
        }
        return reply.type('text/html; charset=utf-8').send(livePage(parsed.data.session));
      });

      app.get('/live/events', async (request, reply) => {
        if (!LOOPBACK.has(request.ip)) return sendError(reply, 'Only from the machine CLive runs on.', 403);
        const parsed = liveQuerySchema.safeParse(request.query);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        if (!(await ownsSession(request, parsed.data.session))) {
          return sendError(reply, 'This practice session is not yours.', 403);
        }
        return reply.send(eventsAfter(parsed.data.session, parsed.data.after));
      });

      // The prototype's `/api/student/log-check`: prove the session's history is
      // still writable, before a participant sits down. The check's own entry is
      // the `CLIVE_LOG_CHECK` the researcher reads later.
      app.post('/log-check', async (request, reply) => {
        const parsed = logCheckSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        const body = parsed.data;
        try {
          const refused = await refusal(request, body);
          if (refused) return sendError(reply, refused.message, refused.code);
        } catch (error) {
          return handle(reply, error);
        }
        return reply.send(await checkSessionLog(body.sessionId));
      });

      // The researcher's participant tag (Ctrl+Shift+Y): names who is working in this
      // session, or starts a fresh one for the next participant at a shared machine.
      app.post('/participant', async (request, reply) => {
        const parsed = participantSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        const body = parsed.data;
        try {
          const refused = await refusal(request, body);
          if (refused) return sendError(reply, refused.message, refused.code);
          const target = body.next ? await startNextSession(requestUserId(request)!, body.problemId) : body.sessionId;
          if (!target) return sendError(reply, 'Could not start a new session.', 500);
          await tagParticipant(target, body.participant);
          await writeSessionLog(target, [
            {
              type: SESSION_LOG_TYPES.participant,
              data: body.next
                ? { participant: body.participant, previous_session: body.sessionId }
                : { participant: body.participant },
              timestamp: new Date()
            }
          ]);
          return reply.send({ sessionId: target });
        } catch (error) {
          return handle(reply, error);
        }
      });

      app.post('/submit', async (request, reply) => {
        const parsed = submitSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        const body = parsed.data;
        try {
          const refused = await refusal(request, body);
          if (refused) return sendError(reply, refused.message, refused.code);
        } catch (error) {
          return handle(reply, error);
        }

        const { calls, result } = await captureLlmCalls(() => watching(body.sessionId, () => submit(body)));
        if (!result.ok) {
          const asked = {
            phase_id: body.phase,
            problem_id: body.problemId,
            attempt: body.attempt,
            step: body.step ?? null,
            artifact: studentWork(body)
          };
          await keep(
            request,
            body.sessionId,
            requestEntries('submit', calls, errorRecord('submit', asked, result.error))
          );
          return handle(reply, result.error);
        }
        const { response, record } = result.value;
        await keep(
          request,
          body.sessionId,
          requestEntries('submit', calls, { type: SESSION_LOG_TYPES.submit, data: record })
        );
        return reply.send(response);
      });

      // After a Run or Submit that did not pass: which situation the student is in,
      // and one thing to do next. The page asks for it on its own.
      app.post('/code-feedback', async (request, reply) => {
        const parsed = codeFeedbackSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        const body = parsed.data;
        try {
          const refused = await refusal(request, body);
          if (refused) return sendError(reply, refused.message, refused.code);
        } catch (error) {
          return handle(reply, error);
        }

        const asked = {
          problem_id: body.problemId,
          run_type: body.runType,
          attempt: body.attempt,
          code: body.code,
          run: body.run
        };
        const { calls, result } = await captureLlmCalls(async () =>
          watching(body.sessionId, async () =>
            codeNudge(
              await loadCLiveProblem(body.problemId),
              body.code,
              body.run,
              body.priorArtifacts,
              body.history.slice(-HISTORY_KEPT),
              body.attempt
            )
          )
        );
        if (!result.ok) {
          await keep(
            request,
            body.sessionId,
            requestEntries('code-feedback', calls, errorRecord('code-feedback', asked, result.error))
          );
          return handle(reply, result.error);
        }
        await keep(
          request,
          body.sessionId,
          requestEntries('code-feedback', calls, {
            type: SESSION_LOG_TYPES.codeFeedback,
            data: { ...asked, response: result.value }
          })
        );
        return reply.send(result.value);
      });

      // "I'm stuck" on a failed submit: the same requirement, one rung up, as a prompt.
      app.post('/escalate', async (request, reply) => {
        const parsed = escalateSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        const body = parsed.data;
        try {
          const refused = await refusal(request, body);
          if (refused) return sendError(reply, refused.message, refused.code);
        } catch (error) {
          return handle(reply, error);
        }

        const { calls, result } = await captureLlmCalls(() => watching(body.sessionId, () => escalate(body)));
        if (!result.ok) {
          // A refusal is the page asking at the wrong moment, not a failed request: nothing to record.
          if (result.error instanceof Conflict) return sendError(reply, result.error.message, 409);
          const asked = {
            phase_id: body.phase,
            problem_id: body.problemId,
            step: body.step ?? null,
            attempt: body.attempt,
            history: body.history
          };
          await keep(
            request,
            body.sessionId,
            requestEntries('escalate', calls, errorRecord('escalate', asked, result.error))
          );
          return handle(reply, result.error);
        }
        // The reason often names the answer: it goes to the session log, never to the page.
        const { response, record } = result.value;
        await keep(
          request,
          body.sessionId,
          requestEntries('escalate', calls, { type: SESSION_LOG_TYPES.escalate, data: record })
        );
        return reply.send(response);
      });
    };
  }
}

function sendError(reply: FastifyReply, message: string, code: number) {
  return reply.code(code).send({ error: message });
}

function handle(reply: FastifyReply, error: unknown) {
  if (error instanceof JudgeError) return sendError(reply, error.message, 400);
  return sendError(reply, 'Internal error', 500);
}

export default CLiveAPI;
