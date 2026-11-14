/**
 * One larper answer through CLive, as the page would send it, and what came back.
 *
 * Problem, Cases and Design go to the plugin's own `submit`. Implement takes the two
 * paths the page takes: code that compiles and passes the examples goes to `submit`
 * for the review against the plan; anything else goes to the code feedback.
 *
 * Nothing here throws: a row that cannot be run is a result carrying `error`, so one
 * bad answer or one failed model call never loses the rest of a run.
 */
import type { CodeExecutor } from '$lib/executor';
import type { PriorArtifact } from '../../plugins/plugin-clive/server/artifact';
import type { codeNudge, CodeRun } from '../../plugins/plugin-clive/server/codeNudge';
import type { ProblemForPrompt } from '../../plugins/plugin-clive/server/content/templates';
import { normaliseOutput, runProgram } from '../../plugins/plugin-clive/server/program';
import { functionArgs, functionHarness } from '../../plugins/plugin-clive/server/referenceCheck';
import type { submit } from '../../plugins/plugin-clive/server/routes';
import type { Answer, Category, Result } from './types';

export interface Deps {
  submit: typeof submit;
  codeNudge: typeof codeNudge;
  runCode: typeof runCode;
  executor: CodeExecutor;
}

/** No practice session is written to; the schema only wants the shape. */
const NO_SESSION = '00000000-0000-4000-8000-000000000000';

/**
 * Compile `code` and run it on the problem's examples. For a function problem the
 * code is given the `main` the reference check gives the reference solution. Hidden
 * test cases are not available to a script, so `hiddenFailed` is always 0.
 */
export async function runCode(problem: ProblemForPrompt, code: string, executor: CodeExecutor): Promise<CodeRun> {
  const functions = problem.functions ?? [];
  if (functions.length > 1) throw new Error('The problem defines several functions; the larper can run only one.');
  const fn = functions[0];
  const program = fn ? functionHarness(code, fn) : code;
  if (program === null) throw new Error(`The function ${fn.name} has a type the larper cannot call.`);

  const cases: CodeRun['cases'] = [];
  for (const example of problem.public_test_cases) {
    const stdin = fn ? functionArgs(example.input, fn) : example.input;
    if (stdin === null)
      throw new Error(`The example '${example.input}' could not be read as the function's arguments.`);
    const run = await runProgram(executor, program, stdin);
    if (!run.compiled) return { compiled: false, compilerOutput: run.compileError, cases: [], hiddenFailed: 0 };
    cases.push({
      input: example.input,
      expected: example.output,
      actual: run.stdout,
      passed: run.exitCode === 0 && normaliseOutput(run.stdout) === normaliseOutput(example.output)
    });
  }
  if (!cases.length) {
    // No example to run: still learn whether it compiles.
    const run = await runProgram(executor, program, '');
    if (!run.compiled) return { compiled: false, compilerOutput: run.compileError, cases: [], hiddenFailed: 0 };
  }
  return { compiled: true, compilerOutput: '', cases, hiddenFailed: 0 };
}

function matches(category: Category, result: Result): boolean | null {
  const want = category.expect;
  if (!want || result.blocked === null) return null;
  if (want.blocks !== undefined && want.blocks !== result.blocked) return false;
  const unmet = new Set([...result.failed, ...result.advisoryUnmet]);
  if ((want.fails ?? []).some((id) => !unmet.has(id))) return false;
  if (want.situations && !(result.situation !== null && want.situations.includes(result.situation))) return false;
  return true;
}

/** Whether the code did what its category needs, where that can be told by running it. */
function offCategory(answer: Answer, compiled: boolean, publicPassed: boolean): boolean {
  if (answer.phase !== 'implement') return false;
  if (answer.category === 'compile_error') return compiled;
  if (answer.category === 'control' || answer.category === 'correct_ignores_plan') return !(compiled && publicPassed);
  return false;
}

export async function runAnswer(
  answer: Answer,
  category: Category,
  problem: ProblemForPrompt,
  prior: PriorArtifact[],
  deps: Deps,
  earlier?: Result
): Promise<Result> {
  const t0 = performance.now();
  const result: Result = {
    answer,
    pass: earlier ? 2 : 1,
    blocked: null,
    failed: [],
    advisoryUnmet: [],
    situation: null,
    feedback: '',
    focusFields: [],
    observed: {},
    offCategory: false,
    matches: null,
    record: null,
    ms: 0
  };
  const attempt = earlier ? 2 : 1;

  const viaSubmit = async (code?: string) => {
    const history =
      earlier && earlier.situation !== null
        ? [
            {
              attempt: 1,
              situation: earlier.situation,
              focus_id: earlier.focusId ?? '',
              nudge: earlier.feedback
            }
          ]
        : [];
    const { response, record } = await deps.submit(
      {
        sessionId: NO_SESSION,
        phase: answer.phase,
        problemId: answer.problemId,
        artifact: answer.artifact,
        attempt,
        priorArtifacts: prior,
        step: answer.phase === 'case_design' ? 'normal_cases' : undefined,
        code,
        history
      },
      deps.executor
    );
    result.blocked = !response.passed;
    result.failed = response.verdicts
      .filter((v) => v.verdict === 'FAIL' && v.gate !== 'advisory')
      .map((v) => v.criterion_id);
    result.advisoryUnmet = response.advisory_unmet;
    result.situation = response.nudge?.situation ?? null;
    result.feedback = response.nudge?.nudge ?? '';
    result.focusFields = response.nudge?.focus_fields ?? [];
    result.focusId = response.nudge?.focus_id;
    result.record = record;
    if (response.nudge_error) result.error = `CLive could not write feedback: ${response.nudge_error}`;
  };

  try {
    if (answer.error) throw new Error(answer.error);
    if (answer.phase !== 'implement') {
      await viaSubmit();
    } else {
      const code = String(answer.artifact.code ?? '');
      const run = await deps.runCode(problem, code, deps.executor);
      const publicPassed = run.compiled && run.cases.every((c) => c.passed);
      result.observed = { compiled: run.compiled, publicPassed };
      result.offCategory = offCategory(answer, run.compiled, publicPassed);
      if (publicPassed) {
        await viaSubmit(code);
      } else {
        const before = earlier?.record as { focus?: string } | null | undefined;
        const history =
          earlier && earlier.situation !== null
            ? [{ situation: earlier.situation, focus: before?.focus ?? '', nudge: earlier.feedback }]
            : [];
        const reply = await deps.codeNudge(problem, code, run, prior, history, attempt);
        result.blocked = true;
        result.situation = reply.situation;
        result.feedback = reply.nudge;
        result.record = reply;
      }
    }
  } catch (error) {
    result.blocked = null;
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.matches = matches(category, result);
  result.ms = Math.round(performance.now() - t0);
  return result;
}
