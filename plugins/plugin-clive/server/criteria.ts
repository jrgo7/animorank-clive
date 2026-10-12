/**
 * The rubric helpers, ported from `clive-userflow/src/clive/prompts.py:776-800`.
 *
 * A criterion's gate decides whether a FAIL holds the student in the phase:
 * `gating` does, `advisory` is reported but never blocks. Both helpers take the
 * criteria list as applied — the caller must pass the list `judgeWithChecks`
 * returned, not the one it was handed, because a reference-check fallback
 * downgrades a criterion's gate in that list.
 */
import type { CriterionDoc } from './content/load';
import type { Verdict } from './judge';

/** A criterion the judge failed and the student must meet to leave the phase. */
export interface FailingCriterion extends CriterionDoc {
  evidence?: string;
  confidence?: string;
}

/** The advisory subset a hint may point at. */
export function advisoryCriteria(criteria: CriterionDoc[]): CriterionDoc[] {
  return criteria.filter((c) => c.gate === 'advisory');
}

/** The gating criteria the judge failed, in rubric order, with the judge's evidence attached. */
export function failingGates(criteria: CriterionDoc[], verdicts: Verdict[]): FailingCriterion[] {
  const byId = new Map(verdicts.map((v) => [v.criterion_id, v]));
  const out: FailingCriterion[] = [];
  for (const criterion of criteria) {
    if (criterion.gate === 'advisory') continue;
    const verdict = byId.get(criterion.id);
    if (verdict?.verdict !== 'FAIL') continue;
    out.push({ ...criterion, evidence: verdict.evidence, confidence: verdict.confidence });
  }
  return out;
}
