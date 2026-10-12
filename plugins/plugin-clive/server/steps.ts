/**
 * Per-step judging, ported from `clive-userflow/src/clive/steps.py`.
 *
 * A `judge: per_step` phase (Cases) is submitted one field at a time: `cut`
 * narrows the phase, the artifact and the criteria to that one step, so
 * submitting Case 1 judges Case 1 alone.
 */
import type { ArtifactValue } from './artifact';
import { JudgeError } from './content/errors';
import type { CriterionDoc, PhaseDoc } from './content/load';

export function isPerStep(phase: PhaseDoc): boolean {
  return phase.judge === 'per_step';
}

export interface CutPhase {
  phase: PhaseDoc;
  artifact: Record<string, ArtifactValue>;
  criteria: CriterionDoc[];
}

export function cut(
  phase: PhaseDoc,
  artifact: Record<string, unknown> | null | undefined,
  criteria: CriterionDoc[],
  step: string
): CutPhase {
  const ids = phase.artifact_fields.map((f) => f.id);
  if (!ids.includes(step)) {
    throw new JudgeError(
      `Phase '${phase.phase}' is judged one step at a time; step must be one of ${ids.join(', ')}, ` + `not '${step}'.`
    );
  }
  return {
    phase: { ...phase, artifact_fields: phase.artifact_fields.filter((f) => f.id === step) },
    artifact: { [step]: (artifact ?? {})[step] as ArtifactValue },
    criteria: criteria.filter((c) => (c.fields ?? []).includes(step)).map((c) => ({ ...c, fields: [step] }))
  };
}
