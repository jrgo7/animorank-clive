/**
 * The prompt renderers: Jinja templates from the YAML, rendered with nunjucks.
 *
 * The templates stay in `content/phases/*.yaml` and `content/base/{nudge,nudge_code}.yaml`
 * as authored; this module supplies the context and the few Jinja behaviours
 * nunjucks does not share (the `tojson` filter, Jinja's `truncate`, and comment /
 * trailing-newline handling). The environment is configured `trimBlocks` +
 * `lstripBlocks` + no autoescaping to match `prompts.jinja_env()` in
 * `clive-userflow/src/clive/prompts.py`.
 */
import nunjucks from 'nunjucks';
import { textArtifact, textPrior, type CaseRow, type PriorArtifact } from '../artifact';
import type { FailingCriterion } from '../criteria';
import type { FunctionDef } from '../problem';
import type { CriterionDoc } from './load';
import { NUDGE_CODE_DOC, NUDGE_DOC, type PhaseDoc } from './load';

export const NUDGE_SYSTEM = NUDGE_DOC.system_prompt;
export const NUDGE_CODE_SYSTEM = NUDGE_CODE_DOC.system_prompt;

/** What every template reads as the problem. */
export interface ProblemForPrompt {
  slug: string;
  title: string;
  statement: string;
  starter_code: string;
  public_test_cases: { input: string; output: string }[];
  reference_solution: string;
  /** The functions the problem asks for, when it is a function problem; empty otherwise. */
  functions: FunctionDef[];
}

/**
 * The rung of the hint ladder a nudge is written at: a `hint` points to where to
 * look, a `prompt` asks for the one missing piece. The answer itself is never a rung.
 */
export type NudgeLevel = 'hint' | 'prompt';

/** One earlier nudge in a phase (or step): what the student was told, about which requirement, at which level. */
export interface HistoryTurn {
  attempt: number;
  level: NudgeLevel;
  focus_id: string;
  nudge: string;
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
  if (problem.functions?.length) {
    out.function_signatures = problem.functions.map(
      (fn) => `${fn.returnType} ${fn.name}(${fn.parameters.map((p) => `${p.type} ${p.name}`).join(', ')})`
    );
  }
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
    /** The student's Case 1, shown as YOUR CASE 1 when Case 2 is judged (see `steps.compareCase`). */
    compareCase?: CaseRow;
  }
): string {
  return render(phase.user_template, {
    problem: problemForTemplate(context.problem),
    artifact: textArtifact(context.artifact),
    artifact_fields: phase.artifact_fields,
    criteria_to_judge: context.criteria,
    attempt: context.attempt,
    prior_artifacts: priorForTemplate(context.priorArtifacts),
    // Absent, never empty, when there is no Case 1 to show: the block is guarded.
    compare_case: context.compareCase
  });
}

/**
 * The nudge's user message: one requirement (`focus`, chosen by the caller), the
 * level to write at, and the earlier feedback on that requirement alone.
 */
export function renderNudgePrompt(context: {
  phase: PhaseDoc;
  problem: ProblemForPrompt;
  artifact: Record<string, unknown>;
  focus: FailingCriterion;
  level: NudgeLevel;
  attempt: number;
  priorArtifacts: PriorArtifact[];
  /** Earlier nudges on `focus` only, oldest first. */
  history: HistoryTurn[];
}): string {
  return render(NUDGE_DOC.user_template, {
    phase: { id: context.phase.phase, label: context.phase.label, task_description: context.phase.task_description },
    problem: problemForTemplate(context.problem),
    artifact: textArtifact(context.artifact),
    artifact_fields: context.phase.artifact_fields,
    focus: context.focus,
    level: context.level,
    attempt: context.attempt,
    prior_artifacts: priorForTemplate(context.priorArtifacts),
    // `undefined`, never `[]`, for the guarded block: nunjucks treats an empty array as truthy.
    history: context.history.length ? context.history : undefined
  });
}

/** The code nudge's run: compile errors, or the public cases and how many hidden ones failed. */
export interface CodeRunForPrompt {
  compiled: boolean;
  compilerOutput: string;
  cases: { input: string; expected: string; actual: string; passed: boolean }[];
  hiddenFailed: number;
}

/** One earlier reply about the code, at the level it came at. */
export interface CodeHistoryTurn {
  level: NudgeLevel;
  situation: string;
  focus: string;
  nudge: string;
}

export function renderCodeNudgePrompt(context: {
  problem: ProblemForPrompt;
  code: string;
  run: CodeRunForPrompt;
  priorArtifacts: PriorArtifact[];
  history: CodeHistoryTurn[];
  attempt: number;
  level: NudgeLevel;
  /** For a prompt: the situation and place its hint settled on. */
  fixed?: { situation: string; focus: string };
}): string {
  return render(NUDGE_CODE_DOC.user_template, {
    problem: problemForTemplate(context.problem),
    code: context.code,
    run: context.run,
    prior_artifacts: priorForTemplate(context.priorArtifacts),
    // `undefined`, never `[]`: nunjucks treats an empty array as truthy.
    history: context.history.length ? context.history : undefined,
    attempt: context.attempt,
    level: context.level,
    situation: context.fixed?.situation ?? '',
    focus: context.fixed?.focus ?? ''
  });
}
