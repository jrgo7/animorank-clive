/**
 * The plugin's HTTP surface: `POST /submit`, `POST /stuck` and `GET /boot`,
 * served under `/plugin-api/clive` (the plugin's id; see `src/lib/server/index.ts`).
 *
 * These are the counterpart of the prototype's `/api/student/{submit,stuck}` in
 * `clive-userflow/src/clive/studio/student.py`. The rubric reaches the browser
 * only attached to a verdict here, the reference check's row detail (which holds
 * the reference's own output) is never put in a response, and the stuck call's
 * diagnosis — which often names the answer — goes to the log instead.
 */
import { ServerAPI } from '$lib/server/serverAPI';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { JudgeError } from './content/errors';
import { phaseDoc, rubricDoc, type CriterionDoc } from './content/load';
import type { PublicTestRun } from './content/templates';
import { judge, type JudgeOutcome, type Verdict } from './judge';
import { nudge } from './nudge';
import { loadCLiveProblem } from './problem';
import { getProvider } from './providers';
import { publicTestRun } from './publicTests';
import { judgeWithChecks } from './referenceCheck';
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
  phase: z.string(),
  problemId: z.string(),
  artifact: artifactSchema.default({}),
  attempt: z.number().int().positive().default(1),
  priorArtifacts: priorArtifactsSchema.default([]),
  step: z.string().optional(),
  code: z.string().optional()
});

const stuckSchema = z.object({
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
}

interface SubmitResponse {
  passed: boolean;
  verdicts: ResponseVerdict[];
  missing_ids: string[];
  advisory_unmet: string[];
  nudge?: {
    summary: string;
    nudge: string;
    reason: string;
    focus_id: string;
    focus_not_met: string;
    failing: { id: string; text: string }[];
  };
  nudge_error?: string;
}

function toResponseVerdicts(verdicts: Verdict[], criteria: CriterionDoc[]): ResponseVerdict[] {
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
      recheck: v.source === 'reference' && v.verdict === 'FAIL' ? (v.wrong ?? []) : []
    };
  });
}

/** A `check: reference` verdict names rows to trace, never their answers. */
async function submit(body: z.infer<typeof submitSchema>): Promise<SubmitResponse> {
  const phase = phaseDoc(body.phase);
  const problem = await loadCLiveProblem(body.problemId);
  let criteria = rubricDoc(body.phase).criteria;
  let artifact: Record<string, unknown> = body.artifact;
  let phaseForJudge = phase;

  if (phase.phase === 'implement') {
    // The compiler gate is AnimoRank's own Submit flow; by the time the client
    // enables this button the code already passes, so the judge only reviews it
    // against the plan, and every Implement criterion is advisory.
    const code = body.code ?? (typeof artifact.code === 'string' ? artifact.code : '');
    artifact = { code };
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
        body.priorArtifacts
      );
      response.nudge = {
        summary: n.summary,
        nudge: n.nudge,
        reason: n.reason,
        focus_id: n.focus_id,
        focus_not_met: n.focus_not_met,
        failing: n.failing
      };
    } catch (error) {
      if (!(error instanceof JudgeError)) throw error;
      response.nudge_error = error.message;
    }
  }

  return response;
}

class CLiveAPI extends ServerAPI {
  public async fastifyPlugin(): Promise<FastifyPluginCallback> {
    return (app) => {
      app.get('/boot', async (_request, reply) => reply.send({ hasApiKey: getProvider().hasApiKey() }));

      app.post('/submit', async (request, reply) => {
        const parsed = submitSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        try {
          return reply.send(await submit(parsed.data));
        } catch (error) {
          return handle(reply, error);
        }
      });

      app.post('/stuck', async (request, reply) => {
        const parsed = stuckSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 'Could not read the request.', 400);
        try {
          const body = parsed.data;
          const statement = body.statement.trim().slice(0, STATEMENT_MAX);
          if (!statement) throw new JudgeError('Say what you are having trouble with first.');
          const phase = phaseDoc(body.phase);
          const problem = await loadCLiveProblem(body.problemId);
          const field = phase.artifact_fields.find((f) => f.id === body.fieldId);
          // In a tests-gated phase the model first sees how the program does on the public
          // cases -- the ones the student can already see -- so it never questions a
          // calculation that works. Hidden cases are never run for this.
          let tests: PublicTestRun | undefined;
          if (phase.gate === 'tests') {
            const code = body.code ?? (typeof body.artifact.code === 'string' ? body.artifact.code : '');
            try {
              tests = await publicTestRun(code, problem.public_test_cases);
            } catch {
              tests = undefined;
            }
          }
          const got = await stuck(
            phase,
            problem,
            body.artifact,
            statement,
            field,
            body.priorArtifacts,
            body.history,
            tests
          );
          // The diagnosis names the idea the student lacks, which is often the answer itself:
          // it goes to the log, and the page receives the feedback alone.
          request.log.info({ phase: phase.phase, diagnosis: got.diagnosis }, 'CLive stuck diagnosis');
          return reply.send({ feedback: got.feedback });
        } catch (error) {
          return handle(reply, error);
        }
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
