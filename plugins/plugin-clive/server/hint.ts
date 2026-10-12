/**
 * The hint call: one advisory criterion, one place to think next.
 *
 * Ported from `clive-userflow/src/clive/hint.py`. Advisory criteria only: a hint
 * is asked for before any submission has been judged, so naming the requirement
 * a student is failing would tell them what they are failing before anything
 * ruled on it.
 */
import { type PriorArtifact } from './artifact';
import { advisoryCriteria } from './criteria';
import { JudgeError } from './content/errors';
import { HINT_DOC, type CriterionDoc, type PhaseDoc } from './content/load';
import { HintSchema, jsonSchemaText } from './content/schema';
import { renderHintPrompt, HINT_SYSTEM, type HistoryTurn, type ProblemForPrompt } from './content/templates';
import { getProvider, type Provider } from './providers';

export interface HintOutcome {
  criterion_id: string;
  criterion_text: string;
  diagnosis: string;
  hint: string;
}

export async function hint(
  phase: PhaseDoc,
  problem: ProblemForPrompt,
  artifact: Record<string, unknown>,
  criteria: CriterionDoc[],
  attempt = 1,
  priorArtifacts: PriorArtifact[] = [],
  history: HistoryTurn[] = [],
  provider?: Provider
): Promise<HintOutcome> {
  const advisory = advisoryCriteria(criteria);
  if (advisory.length === 0) {
    throw new JudgeError(
      'This phase has no advisory criteria, so there is nothing to hint at. A hint points at ' +
        'optional depth, never at a requirement the student is failing.'
    );
  }

  // Chosen from the phase's model id, for the reason `nudge` gives: one phase, one
  // provider, whatever CLIVE_PROVIDER says.
  const chosen = provider ?? getProvider({ model: phase.model.id });
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, ` +
        'then restart the server.'
    );
  }
  const user = renderHintPrompt({ phase, problem, artifact, criteria: advisory, attempt, priorArtifacts, history });

  const result = await chosen.judgeJson({
    system: HINT_SYSTEM,
    user,
    model: chosen.defaultModel,
    maxOutputTokens: HINT_DOC.model?.max_output_tokens ?? 2000,
    effort: HINT_DOC.model?.effort ?? 'medium',
    schema: HintSchema,
    schemaText: jsonSchemaText(HintSchema)
  });
  const parsed = HintSchema.parse(result.parsed);

  const offered = advisory.map((c) => c.id);
  if (!offered.includes(parsed.criterion_id)) {
    throw new JudgeError(
      `The hint names criterion '${parsed.criterion_id}', which was not offered. Expected one of: ` +
        `${offered.join(', ')}.`
    );
  }

  return {
    criterion_id: parsed.criterion_id,
    criterion_text: advisory.find((c) => c.id === parsed.criterion_id)?.text ?? '',
    diagnosis: parsed.diagnosis,
    hint: parsed.hint
  };
}
