/**
 * The prompt renderers: Jinja templates from the YAML, rendered with nunjucks.
 *
 * The templates stay in `content/phases/*.yaml` and `content/base/{nudge,stuck}.yaml`
 * as authored; this module supplies the context and the few Jinja behaviours
 * nunjucks does not share (the `tojson` filter, Jinja's `truncate`, and comment /
 * trailing-newline handling). The environment is configured `trimBlocks` +
 * `lstripBlocks` + no autoescaping to match `prompts.jinja_env()` in
 * `clive-userflow/src/clive/prompts.py`.
 */
import nunjucks from 'nunjucks';
import { textArtifact, textPrior, type PriorArtifact } from '../artifact';
import type { FailingCriterion } from '../criteria';
import type { CriterionDoc, FieldDoc } from './load';
import { NUDGE_DOC, STUCK_DOC, type PhaseDoc } from './load';

export const NUDGE_SYSTEM = NUDGE_DOC.system_prompt;
export const STUCK_SYSTEM = STUCK_DOC.system_prompt;

/** What every template reads as the problem. */
export interface ProblemForPrompt {
  slug: string;
  title: string;
  statement: string;
  starter_code: string;
  public_test_cases: { input: string; output: string }[];
  reference_solution: string;
}

/** One earlier turn of the nudge's conversation seam. */
export interface HistoryTurn {
  role: 'hint';
  text: string;
}

/** One earlier stuck ask in a phase and the reply to it, oldest first. */
export interface StuckTurn {
  statement: string;
  feedback: string;
}

/** The public test run a stuck ask in a tests-gated phase is grounded in. */
export interface PublicTestRun {
  compiled: boolean;
  cases: { input: string; expected: string; actual: string; passed: boolean; status: string }[];
  all_public_passed: boolean;
}

const env = new nunjucks.Environment(null, {
  autoescape: false,
  trimBlocks: true,
  lstripBlocks: true,
  throwOnUndefined: false
});

// Jinja's `tojson` is wired to `json.dumps`, which nunjucks' own filters do not
// provide. `json.dumps` defaults to `ensure_ascii=True`, so every non-ASCII
// character becomes a `\uXXXX` escape (a Filipino word in an artifact reaches the
// model escaped); `JSON.stringify` keeps it. The templates pass strings only,
// where that escaping is the sole difference.
env.addFilter('tojson', (value: unknown) => {
  const json = JSON.stringify(value) ?? 'null';
  if (typeof value !== 'string') return json;
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
});

/**
 * Jinja's `truncate`, which nunjucks' own differs from in two ways: Jinja leaves a
 * string shorter than `length + leeway` untouched, and it cuts to `length -
 * len(end)` characters. Registered so the templates keep the filter they were
 * written with.
 */
env.addFilter('truncate', (value: unknown, length = 255, killwords = false, end = '...') => {
  const text = String(value ?? '');
  const limit = Number(length) || 0;
  const suffix = String(end ?? '');
  const leeway = 5; // Jinja's `truncate.leeway` default.
  if (text.length <= limit + leeway) return text;
  let cut = text.slice(0, Math.max(0, limit - suffix.length));
  if (!killwords) {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace !== -1) cut = cut.slice(0, lastSpace);
  }
  return cut + suffix;
});

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

export function renderStuckPrompt(context: {
  phase: PhaseDoc;
  problem: ProblemForPrompt;
  artifact: Record<string, unknown>;
  field?: FieldDoc;
  statement: string;
  priorArtifacts: PriorArtifact[];
  history: StuckTurn[];
  tests?: PublicTestRun;
}): string {
  return render(STUCK_DOC.user_template, {
    // `undefined`, never `[]`, for the guarded blocks: nunjucks treats an empty array as truthy.
    tests: context.tests,
    phase: { label: context.phase.label, task_description: context.phase.task_description },
    problem: problemForTemplate(context.problem),
    artifact: textArtifact(context.artifact),
    artifact_fields: context.phase.artifact_fields,
    field: context.field,
    statement: context.statement,
    prior_artifacts: priorForTemplate(context.priorArtifacts),
    history: context.history.length ? context.history : undefined
  });
}
