/**
 * The nudge call: one requirement, one rung of the hint ladder.
 *
 * Ported from `clive-userflow/src/clive/nudge.py` (the judged nudge) and reworked
 * for the hint ladder: the caller picks the requirement ({@link pickFocus}, the
 * first failing gate in rubric order) and the level (a failed submit always gets a
 * `hint`; "I'm stuck" asks for a `prompt` on that submission), and the model writes
 * that rung for that requirement alone. Its sibling for
 * Implement's code, `nudge_code`, lives in `codeNudge.ts`.
 */
import { type PriorArtifact } from './artifact';
import { failingGates, type FailingCriterion } from './criteria';
import { JudgeError } from './content/errors';
import { NUDGE_DOC, type CriterionDoc, type PhaseDoc } from './content/load';
import { jsonSchemaText, NudgeSchema } from './content/schema';
import {
  renderNudgePrompt,
  NUDGE_SYSTEM,
  type HistoryTurn,
  type NudgeLevel,
  type ProblemForPrompt
} from './content/templates';
import type { Verdict } from './judge';
import { callModel } from './llmCalls';
import { getProvider, type Provider } from './providers';

export type { NudgeLevel };

export interface NudgeOutcome {
  level: NudgeLevel;
  focus_id: string;
  focus_text: string;
  /** The focused criterion's `not_met` line — the one the student sees just above the nudge. */
  focus_not_met: string;
  /** For the research log only: what the model thinks is behind the failure. */
  reason: string;
  /** What the student reads. */
  nudge: string;
  /** Every failing gating criterion, in rubric order — computed here, never taken from the model. */
  failing: { id: string; text: string }[];
}

/**
 * The requirement a failed submit is about: the first failing gating criterion in
 * rubric order (`criteria` as applied, so a reference fallback's downgrade counts),
 * or null when nothing gating failed. Advisory criteria are never nudged.
 */
export function pickFocus(criteria: CriterionDoc[], verdicts: Verdict[]): FailingCriterion | null {
  return failingGates(criteria, verdicts)[0] ?? null;
}

interface NudgeRequest {
  phase: PhaseDoc;
  problem: ProblemForPrompt;
  artifact: Record<string, unknown>;
  /** The requirement to write about, with its verdict's evidence: {@link pickFocus}'s choice. */
  focus: FailingCriterion;
  /** Every failing gating criterion, in rubric order, for the page's count. */
  failing: FailingCriterion[];
  level: NudgeLevel;
  attempt?: number;
  priorArtifacts?: PriorArtifact[];
  /** Earlier turns on `focus` only, oldest first. */
  history?: HistoryTurn[];
  provider?: Provider;
  /** What the live reasoning window calls this call; `nudge · <level>` by default. */
  liveLabel?: string;
}

export async function nudge(request: NudgeRequest): Promise<NudgeOutcome> {
  const { phase, focus, level } = request;

  // The nudge document pins no model, so the provider is chosen from the phase's own
  // model id -- that is the provider the judge just used, and it keeps the two halves of
  // one phase on one provider even when CLIVE_PROVIDER is unset.
  const chosen = request.provider ?? getProvider({ model: phase.model.id });
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, ` +
        'then restart the server.'
    );
  }
  const user = renderNudgePrompt({
    phase,
    problem: request.problem,
    artifact: request.artifact,
    focus,
    level,
    attempt: request.attempt ?? 1,
    priorArtifacts: request.priorArtifacts ?? [],
    history: request.history ?? []
  });

  const result = await callModel(
    chosen,
    'nudge',
    {
      system: NUDGE_SYSTEM,
      user,
      model: chosen.defaultModel,
      maxOutputTokens: NUDGE_DOC.model?.max_output_tokens ?? 2000,
      effort: NUDGE_DOC.model?.effort ?? 'medium',
      schema: NudgeSchema,
      schemaText: jsonSchemaText(NudgeSchema)
    },
    request.liveLabel ?? `nudge · ${level}`
  );
  const reply = NudgeSchema.parse(result.parsed);

  return {
    level,
    focus_id: focus.id,
    focus_text: focus.text,
    focus_not_met: focus.not_met ?? '',
    reason: reply.reason,
    nudge: reply.nudge,
    failing: request.failing.map((c) => ({ id: c.id, text: c.text }))
  };
}
