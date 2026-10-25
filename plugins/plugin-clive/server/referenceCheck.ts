/**
 * The Cases correctness criterion, computed rather than judged.
 *
 * Ported from `clive-userflow/src/clive/reference_check.py`. `outputs_are_correct`
 * asks whether each output a student claims is right for its input; this runs
 * each case row through the problem's `reference_solution` in the app's own
 * executor (Judge0) and compares the claimed output with what the reference
 * prints.
 *
 * Two rules from the prototype hold here: the reference's output never reaches a
 * model or the student (a failing verdict names rows only), and a reference that
 * cannot run never gates — it hands the criterion back to the judge as advisory.
 * A reference exits with status {@link OUT_OF_RULES_EXIT} on input the problem's
 * rules do not allow.
 */
import type { CodeExecutor } from '$lib/executor';
import { caseRows } from './artifact';
import type { CriterionDoc, PhaseDoc } from './content/load';
import type { ProblemForPrompt } from './content/templates';
import { judge, type JudgeOutcome, type Verdict } from './judge';
import type { PriorArtifact } from './artifact';
import { defaultExecutor, normaliseOutput, runProgram, type ProgramRun } from './program';
import type { Provider } from './providers';
import type { FunctionDef } from './problem';

/** The exit status a reference solution uses for input its problem does not allow. */
export const OUT_OF_RULES_EXIT = 3;

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function decimals(token: string): number {
  return token.includes('.') ? token.split('.', 2)[1].length : 0;
}

/** `token` scaled by `10^places` and rounded half-up, as an integer string. */
function quantize(token: string, places: number): string {
  const negative = token.startsWith('-');
  const body = token.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = body.split('.', 2);
  const kept = (fraction + '0'.repeat(places)).slice(0, places);
  let scaled = BigInt((whole || '0') + kept);
  if (Number(fraction[places] ?? '0') >= 5) scaled += 1n;
  return `${negative && scaled !== 0n ? '-' : ''}${scaled}`;
}

function sameToken(a: string, b: string): boolean {
  if (NUMBER.test(a) && NUMBER.test(b)) {
    // Precision is `output_format_matches_statement`'s to judge, so round both to the
    // coarser of the two: 63.3 claims the same value as 63.33, 63.4 does not.
    const places = Math.min(decimals(a), decimals(b));
    return quantize(a, places) === quantize(b, places);
  }
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether a claimed output is the same value as the reference's. Format —
 * precision, leading zeros, casing — is left to the advisory format criterion,
 * so a different word is a different value: "Yes" is not "1".
 */
export function outputsMatch(claimed: string, actual: string): boolean {
  const a = normaliseOutput(claimed).split(/\s+/).filter(Boolean);
  const b = normaliseOutput(actual).split(/\s+/).filter(Boolean);
  return a.length === b.length && a.every((token, i) => sameToken(token, b[i]));
}

interface RefRow {
  label: string;
  input: string;
  claimed: string;
  actual?: string;
  outcome: 'right' | 'wrong' | 'out_of_rules' | 'error' | 'missing_output';
  status?: string;
}

export type CheckResult =
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'checked'; verdict: 'PASS' | 'FAIL'; wrong: string[]; outside: string[]; rows: RefRow[] };

/** Every non-blank case row, labelled by its position on the page. */
function collectRows(phase: PhaseDoc, artifact: Record<string, unknown>): RefRow[] {
  const out: RefRow[] = [];
  for (const field of phase.artifact_fields) {
    if (field.kind !== 'cases') continue;
    const rows = caseRows(artifact?.[field.id]) ?? [];
    const name = field.label || field.id;
    rows.forEach((row, index) => {
      if (![row.input, row.output, row.working].some((v) => v.trim())) return;
      out.push({
        // A field that holds one case (a stepped Cases phase) is named by its own label.
        label: rows.length === 1 ? name : `Case ${index + 1} in ${name}`,
        input: row.input,
        claimed: row.output,
        outcome: 'missing_output'
      });
    });
  }
  return out;
}

/** How each C type the harness can call is read from stdin and printed. */
const IO: Record<string, { read: string; print: string }> = {
  int: { read: '%d', print: '%d' },
  long: { read: '%ld', print: '%ld' },
  float: { read: '%f', print: '%g' },
  double: { read: '%lf', print: '%g' },
  char: { read: ' %c', print: '%c' }
};

/**
 * A function problem's reference with a `main` that reads each argument from
 * stdin, calls the function, and prints what it returns — so a student's case row
 * can be run through it like a program's. The reference is returned unchanged when
 * it already has a `main`; `null` when a type is one the harness cannot read.
 */
export function functionHarness(reference: string, fn: FunctionDef): string | null {
  if (/\bmain\s*\(/.test(reference)) return reference;
  if (fn.parameters.some((p) => !IO[p.type])) return null;
  if (fn.returnType !== 'void' && !IO[fn.returnType]) return null;
  const vars = fn.parameters.map(
    (p, i) => `  ${p.type} a${i};\n  if (scanf("${IO[p.type].read}", &a${i}) != 1) return 3;`
  );
  const call = `${fn.name}(${fn.parameters.map((_, i) => `a${i}`).join(', ')})`;
  const body = fn.returnType === 'void' ? `  ${call};` : `  printf("${IO[fn.returnType].print}\\n", ${call});`;
  return `${reference}\n\n#include <stdio.h>\nint main(void)\n{\n${vars.join('\n')}\n${body}\n  return 0;\n}\n`;
}

/** A case row as stdin: commas or any run of whitespace between values become one space. */
export function caseStdin(input: string): string {
  return `${input.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ')}\n`;
}

const NUMBER_TOKEN = /[-+]?\d+(?:\.\d+)?/g;

/**
 * A function case row as stdin for the generated `main`, or `null` when its
 * values cannot be read. Students write the arguments in several forms --
 * `612, 123456789`, `checkSecretCode(612, 123456789)`, `nAlice = 612, ...`, a
 * nine-digit number grouped as `123,456,789` -- so the numbers are pulled out
 * rather than split on commas. A row with the wrong number of values is not
 * computable: the criterion falls back to the judge, rather than calling the
 * student's case out of the rules.
 */
export function functionArgs(input: string, fn: FunctionDef): string | null {
  if (fn.parameters.some((p) => p.type === 'char')) return caseStdin(input);
  const ungrouped = input.replace(/\d{1,3}(?:,\d{3})+(?!\d)/g, (m) => m.replace(/,/g, ''));
  const numbers = ungrouped.match(NUMBER_TOKEN) ?? [];
  return numbers.length === fn.parameters.length ? `${numbers.join(' ')}\n` : null;
}

/**
 * Run the student's rows through the problem's reference solution. `status` is
 * `unavailable` or `error` when nothing can be computed, else `checked`.
 */
export async function check(
  phase: PhaseDoc,
  artifact: Record<string, unknown>,
  referenceSolution: string,
  executor?: CodeExecutor,
  fn?: FunctionDef
): Promise<CheckResult> {
  let reference = referenceSolution ?? '';
  if (!reference.trim()) {
    return { status: 'unavailable', reason: 'This problem has no reference solution.' };
  }
  if (fn) {
    const wrapped = functionHarness(reference, fn);
    if (wrapped === null) {
      return { status: 'unavailable', reason: 'The reference is a function whose types CLive cannot call.' };
    }
    reference = wrapped;
  }

  const prose = phase.artifact_fields
    .filter((f) => f.kind === 'cases' && typeof artifact?.[f.id] === 'string' && (artifact[f.id] as string).trim())
    .map((f) => f.label || f.id);
  if (prose.length) {
    return { status: 'unavailable', reason: `${prose.join(', ')} holds free text, not case rows.` };
  }

  const rows = collectRows(phase, artifact);
  const toRun = rows.filter((r) => r.claimed.trim());

  if (toRun.length) {
    let runner: CodeExecutor;
    try {
      runner = executor ?? (await defaultExecutor());
    } catch (error) {
      return { status: 'error', reason: `The reference could not run: ${describe(error)}` };
    }
    for (const row of toRun) {
      let outcome: ProgramRun;
      try {
        const stdin = fn ? functionArgs(row.input, fn) : row.input;
        if (stdin === null) {
          return {
            status: 'unavailable',
            reason: `${row.label}: its values could not be read as the function's arguments.`
          };
        }
        outcome = await runProgram(runner, reference, stdin);
      } catch (error) {
        return { status: 'error', reason: `The reference could not run: ${describe(error)}` };
      }
      if (!outcome.compiled) {
        return { status: 'error', reason: `The reference solution did not compile: ${outcome.compileError}` };
      }
      row.actual = outcome.stdout;
      if (outcome.exitCode === 0) {
        row.outcome = outputsMatch(row.claimed, outcome.stdout) ? 'right' : 'wrong';
      } else if (outcome.exitCode === OUT_OF_RULES_EXIT) {
        row.outcome = 'out_of_rules';
      } else {
        row.outcome = 'error';
      }
    }
  }

  const wrong = rows.filter((r) => r.outcome === 'wrong' || r.outcome === 'missing_output').map((r) => r.label);
  const outside = rows.filter((r) => r.outcome === 'out_of_rules').map((r) => r.label);
  return { status: 'checked', verdict: wrong.length || outside.length ? 'FAIL' : 'PASS', wrong, outside, rows };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface JudgedWithChecks extends JudgeOutcome {
  /** The criteria as applied — a reference fallback's downgrade lives here. Read gates from this. */
  criteria: CriterionDoc[];
  referenceCheck: CheckResult | null;
}

/**
 * The function the student writes, for a function problem: the only one defined,
 * or else the one the starter code names outside the slots the student edits.
 * Undefined when it cannot be told, which leaves the reference run as a program.
 */
function studentFunction(problem: ProblemForPrompt): FunctionDef | undefined {
  const fns = problem.functions ?? [];
  if (fns.length <= 1) return fns[0];
  const fixed = problem.starter_code.replace(/%slot[^%]*%[\s\S]*?%endslot[^%]*%/g, '');
  const named = fns.filter((f) => new RegExp(`\\b${f.name}\\s*\\(`).test(fixed));
  return named.length === 1 ? named[0] : undefined;
}

/**
 * `judge()`, with each `check: reference` criterion computed instead where it
 * can be. When the reference cannot be computed, that criterion is downgraded to
 * advisory in the returned `criteria` — callers must take gates from there, not
 * from the list they passed in.
 */
export async function judgeWithChecks(
  phase: PhaseDoc,
  problem: ProblemForPrompt,
  artifact: Record<string, unknown>,
  criteria: CriterionDoc[],
  attempt = 1,
  priorArtifacts: PriorArtifact[] = [],
  provider?: Provider,
  executor?: CodeExecutor
): Promise<JudgedWithChecks> {
  const checkedIds = criteria.filter((c) => c.check === 'reference').map((c) => c.id);
  if (checkedIds.length === 0) {
    const result = await judge(phase, problem, artifact, criteria, attempt, priorArtifacts, provider);
    return { ...result, criteria, referenceCheck: null };
  }

  const ref = await check(phase, artifact, problem.reference_solution, executor, studentFunction(problem));
  const computed = ref.status === 'checked';

  const applied: CriterionDoc[] = criteria.map((c) =>
    checkedIds.includes(c.id) && !computed ? { ...c, gate: 'advisory' } : c
  );
  const toJudge = applied.filter((c) => !(computed && checkedIds.includes(c.id)));

  const result = await judge(phase, problem, artifact, toJudge, attempt, priorArtifacts, provider);

  if (computed) {
    // In rubric order, so the page reads the same whichever path ruled.
    const byId = new Map(result.verdicts.map((v) => [v.criterion_id, v]));
    for (const id of checkedIds) {
      byId.set(id, {
        criterion_id: id,
        verdict: ref.verdict,
        evidence: [
          ...ref.wrong,
          ...ref.outside.map(
            (label) => `${label}: the input cannot be read as written, or the problem's rules do not allow it`
          )
        ].join('; '),
        confidence: 'high',
        evidence_found: true,
        source: 'reference',
        wrong: ref.wrong,
        outside_rules: ref.outside
      } satisfies Verdict);
    }
    result.verdicts = applied.filter((c) => byId.has(c.id)).map((c) => byId.get(c.id) as Verdict);
  }

  return { ...result, criteria: applied, referenceCheck: ref };
}
