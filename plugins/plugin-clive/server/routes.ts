/**
 * The plugin's HTTP surface: `POST /submit`, `POST /stuck`, `POST /log-check`
 * and `GET /boot`, served under `/plugin-api/clive` (the plugin's id; see
 * `src/lib/server/index.ts`).
 *
 * These are the counterpart of the prototype's `/api/student/{submit,stuck}` in
 * `clive-userflow/src/clive/studio/student.py`. The rubric reaches the browser
 * only attached to a verdict here, the reference check's row detail (which holds
 * the reference's own output) is never put in a response, and the stuck call's
 * diagnosis — which often names the answer — goes to the session log instead.
 *
 * Each submit and stuck ask is recorded in the practice session's history, as
 * the prototype's `_logged` recorded it in the participant's file: one entry per
 * model call, then the record itself — or, when the request failed, an error
 * entry. So a request is only served for the signed-in student's own practice
 * session on that problem.
 */
import { requestUserId, ServerAPI } from '$lib/server/serverAPI';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { JudgeError } from './content/errors';
import { phaseDoc, rubricDoc, type CriterionDoc } from './content/load';
import type { PublicTestRun } from './content/templates';
import { judge, type JudgeOutcome, type Verdict } from './judge';
import { liveTable } from './live';
import { captureLlmCalls } from './llmCalls';
import { codeNudge } from './codeNudge';
import { eventsAfter, watching } from './liveFeed';
import { livePage } from './livePage';
import { nudge } from './nudge';
import { loadCLiveProblem } from './problem';
import { getProvider } from './providers';
import { publicTestRun } from './publicTests';
import { judgeWithChecks, type CheckResult } from './referenceCheck';
import {
  checkSessionLog,
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
import { cut, isPerStep } from './steps';
import { stuck } from './stuck';

/** The longest statement the model is handed; the page caps its box at the same length. */
const STATEMENT_MAX = 1000;

const artifactSchema = z.record(z.string(), z.unknown());
const priorArtifactsSchema = z.array(
  z.object({
    label: z.string(),
    fields: z.array(z.object({ label: z.string(), value: z.unknown() }))
  })
);

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
  /** Earlier nudges in this phase (or step), oldest first; only the last few are shown to the model. */
  history: z
    .array(z.object({ attempt: z.number(), situation: z.string(), focus_id: z.string(), nudge: z.string() }))
    .max(50)
    .default([])
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

const stuckSchema = z.object({
  /** The practice session the request is recorded in; it must be the caller's. */
  sessionId: z.uuid(),
  phase: z.string(),
  problemId: z.string(),
  artifact: artifactSchema.default({}),
  attempt: z.number().int().positive().default(1),
  priorArtifacts: priorArtifactsSchema.default([]),
  statement: z.string().default(''),
  /** The field the student is on, when the phase shows exactly one. */
  fieldId: z.string().nullish(),
  /** Earlier asks in this phase and the replies, oldest first. */
  history: z.array(z.object({ statement: z.string(), feedback: z.string() })).default([]),
  code: z.string().optional()
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

interface SubmitResponse {
  passed: boolean;
  verdicts: ResponseVerdict[];
  missing_ids: string[];
  advisory_unmet: string[];
  nudge?: {
    situation: string;
    summary: string;
    nudge: string;
    reason: string;
    focus_id: string;
    focus_text: string;
    focus_not_met: string;
    /** The questions the focused requirement is about: the first is the one the page opens on. */
    focus_fields: string[];
    failing: { id: string; text: string }[];
  };
  nudge_error?: string;
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
 * The student's work a submit or stuck ask is about: for Implement the code from
 * AnimoRank's editor, sent beside the artifact (the artifact's own copy can be
 * stale, or never filled in), the artifact otherwise.
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

  if (phase.phase === 'implement') {
    // The compiler gate is AnimoRank's own Submit flow; by the time the client
    // enables this button the code already passes, so the judge only reviews it
    // against the plan, and every Implement criterion is advisory.
    artifact = studentWork(body);
  } else if (isPerStep(phase)) {
    if (!body.step) {
      throw new JudgeError(`Phase '${phase.phase}' is judged one step at a time; a step is required.`);
    }
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
      body.priorArtifacts
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

  if (blocking.length) {
    // In the same call, so no page can show a failure without its guidance. A nudge
    // that fails is reported beside verdicts that stand on their own.
    try {
      const n = await nudge(
        phaseForJudge,
        problem,
        artifact,
        applied,
        outcome.verdicts,
        body.attempt,
        body.priorArtifacts,
        body.history.slice(-HISTORY_KEPT)
      );
      response.nudge = {
        situation: n.situation,
        summary: n.summary,
        nudge: n.nudge,
        reason: n.reason,
        focus_id: n.focus_id,
        focus_text: n.focus_text,
        focus_not_met: n.focus_not_met,
        focus_fields: applied.find((c) => c.id === n.focus_id)?.fields ?? [],
        failing: n.failing
      };
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

/** A stuck ask: what the model was told the student said, its diagnosis, and the reply the student gets. */
async function askStuck(
  body: z.infer<typeof stuckSchema>
): Promise<{ statement: string; diagnosis: string; feedback: string }> {
  const statement = body.statement.trim().slice(0, STATEMENT_MAX);
  if (!statement) throw new JudgeError('Say what you are having trouble with first.');
  const phase = phaseDoc(body.phase);
  const problem = await loadCLiveProblem(body.problemId);
  const field = phase.artifact_fields.find((f) => f.id === body.fieldId);
  const work = studentWork(body);
  // In a tests-gated phase the model first sees how the program does on the public
  // cases -- the ones the student can already see -- so it never questions a
  // calculation that works. Hidden cases are never run for this.
  let tests: PublicTestRun | undefined;
  if (phase.gate === 'tests') {
    try {
      tests = await publicTestRun(String(work.code ?? ''), problem.public_test_cases);
    } catch {
      tests = undefined;
    }
  }
  const got = await stuck(phase, problem, work, statement, field, body.priorArtifacts, body.history, tests);
  return { statement, diagnosis: got.diagnosis, feedback: got.feedback };
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

      app.post('/stuck', async (request, reply) => {
        const parsed = stuckSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        const body = parsed.data;
        try {
          const refused = await refusal(request, body);
          if (refused) return sendError(reply, refused.message, refused.code);
        } catch (error) {
          return handle(reply, error);
        }

        const asked = {
          phase_id: body.phase,
          problem_id: body.problemId,
          attempt: body.attempt,
          field_id: body.fieldId ?? null,
          statement: body.statement,
          history: body.history,
          artifact: studentWork(body)
        };
        const { calls, result } = await captureLlmCalls(() => watching(body.sessionId, () => askStuck(body)));
        if (!result.ok) {
          await keep(
            request,
            body.sessionId,
            requestEntries('stuck', calls, errorRecord('stuck', asked, result.error))
          );
          return handle(reply, result.error);
        }
        // The diagnosis names the idea the student lacks, which is often the answer itself:
        // it goes to the session log, and the page receives the feedback alone.
        const { statement, diagnosis, feedback } = result.value;
        await keep(
          request,
          body.sessionId,
          requestEntries('stuck', calls, {
            type: SESSION_LOG_TYPES.stuck,
            data: { ...asked, statement, diagnosis, response: { feedback } }
          })
        );
        return reply.send({ feedback });
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
