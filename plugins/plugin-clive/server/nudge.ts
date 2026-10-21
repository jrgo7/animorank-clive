/**
 * The nudge call: every failing gate acknowledged, one to fix first.
 *
 * Ported from `clive-userflow/src/clive/nudge.py` — the judged nudge only. Its
 * sibling `nudge_code` is not ported: a failing test in the Implement phase is
 * AnimoRank's own Submit flow to nudge on, not this plugin's.
 */
import { type PriorArtifact } from './artifact';
import { failingGates } from './criteria';
import { JudgeError } from './content/errors';
import { NUDGE_DOC, type CriterionDoc, type PhaseDoc } from './content/load';
import { jsonSchemaText, NudgeSchema } from './content/schema';
import { renderNudgePrompt, NUDGE_SYSTEM, type HistoryTurn, type ProblemForPrompt } from './content/templates';
import type { Verdict } from './judge';
import { callModel } from './llmCalls';
import { getProvider, type Provider } from './providers';

export interface NudgeOutcome {
  summary: string;
  focus_id: string;
  focus_text: string;
  /** The focused criterion's `not_met` line — the one the student sees just above the nudge. */
  focus_not_met: string;
  reason: string;
  nudge: string;
  /** Every failing gating criterion, in rubric order — computed here, never taken from the model. */
  failing: { id: string; text: string }[];
}

export async function nudge(
  phase: PhaseDoc,
  problem: ProblemForPrompt,
  artifact: Record<string, unknown>,
  criteria: CriterionDoc[],
  verdicts: Verdict[],
  attempt = 1,
  priorArtifacts: PriorArtifact[] = [],
  history: HistoryTurn[] = [],
  provider?: Provider
): Promise<NudgeOutcome> {
  const failures = failingGates(criteria, verdicts);
  if (failures.length === 0) {
    throw new JudgeError(
      'Nothing is blocking this submission, so there is nothing to nudge about. A nudge names a ' +
        'gating criterion the student failed; advisory criteria are reported with the verdicts and ' +
        'never hold anyone in a phase.'
    );
  }

  // The nudge document pins no model, so the provider is chosen from the phase's own
  // model id -- that is the provider the judge just used, and it keeps the two halves of
  // one phase on one provider even when CLIVE_PROVIDER is unset.
  const chosen = provider ?? getProvider({ model: phase.model.id });
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, ` +
        'then restart the server.'
    );
  }
  const user = renderNudgePrompt({ phase, problem, artifact, failures, attempt, priorArtifacts, history });

  const result = await callModel(chosen, 'nudge', {
    system: NUDGE_SYSTEM,
    user,
    model: chosen.defaultModel,
    maxOutputTokens: NUDGE_DOC.model?.max_output_tokens ?? 2000,
    effort: NUDGE_DOC.model?.effort ?? 'medium',
    schema: NudgeSchema,
    schemaText: jsonSchemaText(NudgeSchema)
  });
  const parsed = NudgeSchema.parse(result.parsed);

  const offered = failures.map((c) => c.id);
  if (!offered.includes(parsed.focus_id)) {
    throw new JudgeError(
      `The nudge names criterion '${parsed.focus_id}', which is not among the failing gating ` +
        `criteria. Expected one of: ${offered.join(', ')}.`
    );
  }

  const focus = failures.find((c) => c.id === parsed.focus_id);
  return {
    summary: parsed.summary,
    focus_id: parsed.focus_id,
    focus_text: focus?.text ?? '',
    focus_not_met: focus?.not_met ?? '',
    reason: parsed.reason,
    nudge: parsed.nudge,
    failing: failures.map((c) => ({ id: c.id, text: c.text }))
  };
}
