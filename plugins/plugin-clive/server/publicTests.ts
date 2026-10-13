/**
 * The public test run a stuck ask is grounded in, for a phase gated by the
 * compiler (Implement).
 *
 * Ported from the `gate: tests` branch of `student.stuck`: the model sees how the
 * student's program does on the public cases — the ones they can already see — so
 * it never questions a calculation that works. Hidden cases are never run for
 * this, and the run's detail never leaves the prompt.
 */
import type { CodeExecutor } from '$lib/executor';
import { defaultExecutor, normaliseOutput, runProgram } from './program';

export interface PublicCaseResult {
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  /** `ok`, `timeout` or `error`, the word the template prints. */
  status: string;
}

export interface PublicTestRun {
  compiled: boolean;
  cases: PublicCaseResult[];
  /** True when no public case failed — vacuously true with none, as the template's own check was. */
  all_public_passed: boolean;
}

/** Run `code` against every public case; the executor recompiles per case, as the app's own runs do. */
export async function publicTestRun(
  code: string,
  publicCases: readonly { input: string; output: string }[],
  executor?: CodeExecutor
): Promise<PublicTestRun> {
  const runner = executor ?? (await defaultExecutor());
  const results: PublicCaseResult[] = [];

  for (const testCase of publicCases) {
    const run = await runProgram(runner, code, testCase.input);
    if (!run.compiled) {
      return { compiled: false, cases: [], all_public_passed: true };
    }
    const actual = run.stdout;
    results.push({
      input: testCase.input,
      expected: testCase.output,
      actual,
      passed: run.exitCode === 0 && normaliseOutput(actual) === normaliseOutput(testCase.output),
      status: run.exitCode === undefined ? 'timeout' : run.exitCode === 0 ? 'ok' : 'error'
    });
  }

  return { compiled: true, cases: results, all_public_passed: results.every((r) => r.passed) };
}
