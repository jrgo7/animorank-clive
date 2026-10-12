/**
 * The prompt renderers: Jinja templates from the YAML, rendered with nunjucks.
 *
 * The templates stay in `content/phases/*.yaml` and `content/base/{hint,nudge}.yaml`
 * as authored; this module only supplies the context and the one Jinja-ism
 * nunjucks lacks (`tojson`). The environment is configured `trimBlocks` +
 * `lstripBlocks` + no autoescaping to match `prompts.jinja_env()` in
 * `clive-userflow/src/clive/prompts.py:926`.
 */
import nunjucks from 'nunjucks';
import { textArtifact, textPrior, type PriorArtifact } from '../artifact';
import type { FailingCriterion } from '../criteria';
import type { CriterionDoc } from './load';
import { HINT_DOC, NUDGE_DOC, type PhaseDoc } from './load';

export const HINT_SYSTEM = HINT_DOC.system_prompt;
export const NUDGE_SYSTEM = NUDGE_DOC.system_prompt;

/** What every template reads as the problem. */
export interface ProblemForPrompt {
  slug: string;
  title: string;
  statement: string;
  starter_code: string;
  public_test_cases: { input: string; output: string }[];
  reference_solution: string;
}

export interface HistoryTurn {
  role: 'hint';
  text: string;
}

const env = new nunjucks.Environment(null, {
  autoescape: false,
  trimBlocks: true,
  lstripBlocks: true,
  throwOnUndefined: false
});

// Jinja's `tojson`; nunjucks has no JSON filter of its own.
env.addFilter('tojson', (value: unknown) => JSON.stringify(value));

function render(template: string, context: object): string {
  return env.renderString(jinjaSource(template), context);
}

/**
 * The template as Jinja2 would compile it. Two differences from nunjucks are
 * corrected here rather than in the YAML, so the authored templates stay shared
 * with the prototype:
 *
 * - Jinja's `lstrip_blocks`/`trim_blocks` also apply to comment tags; nunjucks
 *   leaves a full-line `{# ... #}`'s indentation and newline behind, so it is
 *   removed here (with its line), as Jinja would.
 * - Jinja's `keep_trailing_newline` defaults to false and drops one trailing
 *   newline from the source; nunjucks keeps it.
 */
function jinjaSource(template: string): string {
  const withoutComments = template.replace(/^[ \t]*\{#[\s\S]*?#\}[ \t]*\r?\n/gm, '');
  return withoutComments.endsWith('\n') ? withoutComments.slice(0, -1) : withoutComments;
}

/**
 * The problem as a template may see it: the reference solution and hidden cases
 * are stripped (`prompts._problem_for_template`), and an empty public-case list
 * is omitted rather than passed as `[]` — nunjucks, unlike Jinja, treats `[]` as
 * truthy, so the guard `{% if problem.public_test_cases %}` would fire on it.
 */
function problemForTemplate(problem: ProblemForPrompt): Record<string, unknown> {
  const out: Record<string, unknown> = {
    slug: problem.slug,
    title: problem.title,
    statement: problem.statement,
    starter_code: problem.starter_code
  };
  if (problem.public_test_cases.length) out.public_test_cases = problem.public_test_cases;
  return out;
}

/** The guarded carry-forward block: absent, not empty, when there is nothing to carry. */
function priorForTemplate(priorArtifacts: PriorArtifact[]): unknown {
  return priorArtifacts.length ? textPrior(priorArtifacts) : undefined;
}

export function renderPhasePrompt(
  phase: PhaseDoc,
  context: {
    problem: ProblemForPrompt;
    artifact: Record<string, unknown>;
    criteria: CriterionDoc[];
    attempt: number;
    priorArtifacts: PriorArtifact[];
  }
): string {
  return render(phase.user_template, {
    problem: problemForTemplate(context.problem),
    artifact: textArtifact(context.artifact),
    artifact_fields: phase.artifact_fields,
    criteria_to_judge: context.criteria,
    attempt: context.attempt,
    prior_artifacts: priorForTemplate(context.priorArtifacts)
  });
}

export function renderHintPrompt(context: {
  phase: PhaseDoc;
  problem: ProblemForPrompt;
  artifact: Record<string, unknown>;
  criteria: CriterionDoc[];
  attempt: number;
  priorArtifacts: PriorArtifact[];
  history: HistoryTurn[];
}): string {
  return render(HINT_DOC.user_template, {
    phase: { label: context.phase.label, task_description: context.phase.task_description },
    problem: problemForTemplate(context.problem),
    artifact: textArtifact(context.artifact),
    artifact_fields: context.phase.artifact_fields,
    criteria: context.criteria,
    attempt: context.attempt,
    prior_artifacts: priorForTemplate(context.priorArtifacts),
    history: context.history.length ? context.history : undefined
  });
}

export function renderNudgePrompt(context: {
  phase: PhaseDoc;
  problem: ProblemForPrompt;
  artifact: Record<string, unknown>;
  failures: FailingCriterion[];
  attempt: number;
  priorArtifacts: PriorArtifact[];
  history: HistoryTurn[];
}): string {
  return render(NUDGE_DOC.user_template, {
    phase: { label: context.phase.label, task_description: context.phase.task_description },
    problem: problemForTemplate(context.problem),
    artifact: textArtifact(context.artifact),
    artifact_fields: context.phase.artifact_fields,
    failures: context.failures,
    attempt: context.attempt,
    prior_artifacts: priorForTemplate(context.priorArtifacts),
    history: context.history.length ? context.history : undefined
  });
}
