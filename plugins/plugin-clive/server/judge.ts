/**
 * The judge call: one phase, one artifact, one verdict per criterion.
 *
 * Ported from `clive-userflow/src/clive/judge.py`. This module renders the
 * prompt, hands it to the provider (picked from the phase's `model.id`, falling
 * back to `CLIVE_PROVIDER`), and audits the reply.
 */
import { textArtifact, type PriorArtifact } from './artifact';
import { JudgeError } from './content/errors';
import { JUDGE_JSON_SCHEMA_TEXT, type CriterionDoc, type PhaseDoc } from './content/load';
import { JudgeResultSchema, type ModelVerdict } from './content/schema';
import { renderPhasePrompt, type ProblemForPrompt } from './content/templates';
import { callModel, noteJudgeChecks } from './llmCalls';
import { getProvider, type Provider } from './providers';

export { JudgeError };

export interface Verdict {
  criterion_id: string;
  verdict: 'PASS' | 'FAIL';
  evidence: string;
  confidence: 'low' | 'medium' | 'high';
  /** Whether the evidence span appears in the artifact; set by {@link judge}. */
  evidence_found?: boolean;
  /** `reference` when the register computed it instead of a model. */
  source?: 'judge' | 'reference';
  /** For a computed verdict: the rows to trace again. */
  wrong?: string[];
  /** For a computed verdict: the rows whose input the problem does not allow. */
  outside_rules?: string[];
}

export interface JudgeOutcome {
  verdicts: Verdict[];
  missing_ids: string[];
  unexpected_ids: string[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Collapse whitespace so an evidence quote that differs only in wrapping still matches. */
function normalise(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Check each evidence span actually appears in the artifact. The prompt requires
 * verbatim quotation, so a quote that is not there means the model asserted
 * rather than observed. An empty quote is not a fabrication and audits clean.
 */
export function auditEvidence(verdicts: ModelVerdict[], artifact: Record<string, unknown>): Record<string, boolean> {
  const haystack = normalise(Object.values(textArtifact(artifact)).join(' '));
  const out: Record<string, boolean> = {};
  for (const verdict of verdicts) {
    out[verdict.criterion_id] = !verdict.evidence.trim() || haystack.includes(normalise(verdict.evidence));
  }
  return out;
}

export async function judge(
  phase: PhaseDoc,
  problem: ProblemForPrompt,
  artifact: Record<string, unknown>,
  criteria: CriterionDoc[],
  attempt = 1,
  priorArtifacts: PriorArtifact[] = [],
  provider?: Provider
): Promise<JudgeOutcome> {
  if (criteria.length === 0) {
    throw new JudgeError('This phase has no criteria yet. Add at least one before running.');
  }

  const chosen = provider ?? getProvider({ model: phase.model.id });
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, ` +
        'then restart the server.'
    );
  }
  const model = phase.model.id || chosen.defaultModel;
  const user = renderPhasePrompt(phase, { problem, artifact, criteria, attempt, priorArtifacts });

  const result = await callModel(chosen, 'judge', {
    system: phase.system_prompt,
    user,
    model,
    maxOutputTokens: phase.model.max_output_tokens ?? 4000,
    effort: phase.model.effort ?? 'medium',
    schema: JudgeResultSchema,
    schemaText: JUDGE_JSON_SCHEMA_TEXT
  });
  const judged = JudgeResultSchema.parse(result.parsed);

  const quoted = auditEvidence(judged.verdicts, artifact);
  const asked = criteria.map((c) => c.id);
  const returned = judged.verdicts.map((v) => v.criterion_id);
  const missingIds = asked.filter((id) => !returned.includes(id));
  const unexpectedIds = returned.filter((id) => !asked.includes(id));
  noteJudgeChecks({
    missing_ids: missingIds,
    unexpected_ids: unexpectedIds,
    evidence_not_found: returned.filter((id) => !quoted[id])
  });

  return {
    verdicts: judged.verdicts.map((v) => ({ ...v, evidence_found: quoted[v.criterion_id] })),
    missing_ids: missingIds,
    unexpected_ids: unexpectedIds,
    model: result.model,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
  };
}
