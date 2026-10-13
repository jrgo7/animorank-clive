/**
 * The stuck call: the student says what they find hard; one diagnosis, one reply.
 *
 * Ported from `clive-userflow/src/clive/stuck.py`. Sibling of the judge and the
 * nudge and built the same way — this module renders the prompt, hands it to the
 * provider, and validates the reply.
 *
 * The two fields have different readers: `diagnosis` names the idea the student
 * lacks and is for the researcher only (the route logs it; the page never gets
 * it), because naming it outright is often the answer itself. `feedback` is what
 * the student reads. The model is never shown the rubric: the student may ask
 * before anything has been judged.
 */
import { type PriorArtifact } from './artifact';
import { JudgeError } from './content/errors';
import { STUCK_DOC, type FieldDoc, type PhaseDoc } from './content/load';
import { jsonSchemaText, StuckSchema } from './content/schema';
import {
  renderStuckPrompt,
  STUCK_SYSTEM,
  type ProblemForPrompt,
  type PublicTestRun,
  type StuckTurn
} from './content/templates';
import { getProvider, type Provider } from './providers';

export interface StuckOutcome {
  /** For the researcher, logged and never shown: names the idea the student lacks. */
  diagnosis: string;
  /** One to three short lines to the student, toward that idea. Never the answer. */
  feedback: string;
}

export async function stuck(
  phase: PhaseDoc,
  problem: ProblemForPrompt,
  artifact: Record<string, unknown>,
  statement: string,
  field?: FieldDoc,
  priorArtifacts: PriorArtifact[] = [],
  history: StuckTurn[] = [],
  tests?: PublicTestRun,
  provider?: Provider
): Promise<StuckOutcome> {
  // Chosen from the phase's model id, for the reason `nudge` gives: one phase, one
  // provider, whatever CLIVE_PROVIDER says.
  const chosen = provider ?? getProvider({ model: phase.model.id });
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, ` +
        'then restart the server.'
    );
  }
  const user = renderStuckPrompt({ phase, problem, artifact, field, statement, priorArtifacts, history, tests });

  const result = await chosen.judgeJson({
    system: STUCK_SYSTEM,
    user,
    model: chosen.defaultModel,
    maxOutputTokens: STUCK_DOC.model?.max_output_tokens ?? 2000,
    effort: STUCK_DOC.model?.effort ?? 'medium',
    schema: StuckSchema,
    schemaText: jsonSchemaText(StuckSchema)
  });

  const parsed = StuckSchema.parse(result.parsed);
  return { diagnosis: parsed.diagnosis, feedback: parsed.feedback };
}
