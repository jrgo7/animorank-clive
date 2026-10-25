/**
 * What a failing Run or Submit becomes before CLive's code-feedback call sees it.
 *
 * A hidden case reaches the page as `{ success, testCaseInfo: { public: false } }`
 * and nothing more; it is only ever counted here, so no request can carry its
 * contents.
 */
import type { CodeRun } from './api';

interface Value {
  data?: { value?: unknown };
}

interface AnyResult {
  success: boolean;
  testCaseInfo: { public: boolean; type?: string; data?: unknown };
  runInfo?: unknown;
  compilerOutput?: string;
}

/** The most compiler output a code-feedback request carries (the route's own limit). */
const COMPILER_OUTPUT_MAX = 20000;

/**
 * A function argument or return value as text. Test case data is plain JSON
 * (`{ data: { value } }`), but the page hydrates run results into `TypeValue`
 * instances, which serialise back to that shape through `toJSON`.
 */
function valueText(v: (Value & { toJSON?: () => unknown }) | undefined): string {
  const plain = (typeof v?.toJSON === 'function' ? v.toJSON() : v) as Value | undefined;
  return String(plain?.data?.value ?? '');
}

function caseOf(result: AnyResult): CodeRun['cases'][number] {
  const info = result.testCaseInfo;
  if (info.type === 'function') {
    const data = info.data as { parameters?: { value?: Value }[] } | undefined;
    const ret = (
      result.runInfo as { comparisons?: { symbol?: string; expected?: Value; actual?: Value }[] } | undefined
    )?.comparisons?.find((c) => c.symbol === 'return');
    // A run that crashed or was stopped has no comparison to read: say so instead of sending blanks.
    const failure = (result.runInfo as { failure?: string } | undefined)?.failure;
    return {
      input: (data?.parameters ?? []).map((p) => valueText(p.value)).join(', '),
      expected: valueText(ret?.expected),
      actual: failure ? `(${failure})` : valueText(ret?.actual),
      passed: result.success
    };
  }
  const data = info.data as { input?: unknown; output?: unknown } | undefined;
  const run = result.runInfo as { expected?: unknown; actual?: unknown } | undefined;
  return {
    input: String(data?.input ?? ''),
    expected: String(run?.expected ?? data?.output ?? ''),
    actual: String(run?.actual ?? ''),
    passed: result.success
  };
}

/** The run as the code-feedback call sees it: compile errors, or the public cases and a hidden count. */
export function toCodeRun(results: readonly unknown[]): CodeRun {
  const all = results as AnyResult[];
  // A function case marks a failed compile in `runInfo.failure`; a stdio case only
  // carries the compiler's output.
  const failedToCompile = all.find(
    (r) =>
      (r.runInfo as { failure?: string } | undefined)?.failure === 'compile_error' ||
      (typeof r.compilerOutput === 'string' && r.compilerOutput.trim() !== '')
  );
  if (failedToCompile) {
    // The first errors are the ones that matter, and the route refuses more than 20 000 characters.
    const output = failedToCompile.compilerOutput ?? '';
    const kept =
      output.length > COMPILER_OUTPUT_MAX ? `${output.slice(0, COMPILER_OUTPUT_MAX - 20)}\n… (cut short)` : output;
    return { compiled: false, compilerOutput: kept, cases: [], hiddenFailed: 0 };
  }
  return {
    compiled: true,
    compilerOutput: '',
    cases: all.filter((r) => r.testCaseInfo?.public !== false).map(caseOf),
    hiddenFailed: all.filter((r) => r.testCaseInfo?.public === false && !r.success).length
  };
}

/** Whether the student has reached Implement: feedback on their code follows them back to earlier phases. */
export function implementReached(phases: readonly { unlocked: boolean }[]): boolean {
  return phases[phases.length - 1]?.unlocked === true;
}

/** Whether a Run or Submit gets code feedback: a model to ask, Implement reached, and something failed. */
export function wantsCodeFeedback(
  phases: readonly { unlocked: boolean }[],
  hasApiKey: boolean,
  results: readonly { success: boolean }[]
): boolean {
  return hasApiKey && implementReached(phases) && shouldAsk(results);
}

/** Whether a Run or Submit is worth answering: anything at all failed. */
export function shouldAsk(results: readonly { success: boolean }[]): boolean {
  return results.some((r) => !r.success);
}

/**
 * Runs requests so that only the newest one's reply counts: a Run made while an
 * earlier Run's feedback is still on its way supersedes it.
 */
export class LatestOnly {
  private latest = 0;

  async run<T>(work: () => Promise<T>): Promise<{ current: boolean; value: T }> {
    const id = ++this.latest;
    const value = await work();
    return { current: id === this.latest, value };
  }

  /** Make any request still on its way stale, so its reply is dropped. */
  cancel(): void {
    this.latest += 1;
  }
}
