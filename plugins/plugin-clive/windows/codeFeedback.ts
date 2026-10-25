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

const valueText = (v: Value | undefined) => String(v?.data?.value ?? '');

function caseOf(result: AnyResult): CodeRun['cases'][number] {
  const info = result.testCaseInfo;
  if (info.type === 'function') {
    const data = info.data as { parameters?: { value?: Value }[] } | undefined;
    const ret = (
      result.runInfo as { comparisons?: { symbol?: string; expected?: Value; actual?: Value }[] } | undefined
    )?.comparisons?.find((c) => c.symbol === 'return');
    return {
      input: (data?.parameters ?? []).map((p) => valueText(p.value)).join(', '),
      expected: valueText(ret?.expected),
      actual: valueText(ret?.actual),
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
  const failedToCompile = all.find((r) => (r.runInfo as { failure?: string } | undefined)?.failure === 'compile_error');
  if (failedToCompile) {
    return { compiled: false, compilerOutput: failedToCompile.compilerOutput ?? '', cases: [], hiddenFailed: 0 };
  }
  return {
    compiled: true,
    compilerOutput: '',
    cases: all.filter((r) => r.testCaseInfo?.public !== false).map(caseOf),
    hiddenFailed: all.filter((r) => r.testCaseInfo?.public === false && !r.success).length
  };
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
}
