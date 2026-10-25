/**
 * Turning AnimoRank's Run/Submit results into what the code-feedback call may see,
 * and keeping only the newest reply when Runs overlap.
 */
import { describe, expect, it } from 'vitest';
import { implementReached, LatestOnly, shouldAsk, toCodeRun } from './codeFeedback';

const intValue = (value: string) => ({ type: 'int', options: {}, data: { value } });

function stdioResult(input: string, expected: string, actual: string, success: boolean) {
  return {
    success,
    testCaseInfo: { public: true, type: 'stdio', data: { input, output: expected } },
    runInfo: { expected, actual }
  };
}

function functionResult(args: string[], expected: string, actual: string, success: boolean) {
  return {
    success,
    testCaseInfo: {
      public: true,
      type: 'function',
      data: { parameters: args.map((v) => ({ name: '', value: intValue(v) })) }
    },
    runInfo: {
      comparisons: [{ symbol: 'return', expected: intValue(expected), actual: intValue(actual), result: success }]
    }
  };
}

const hidden = (success: boolean) => ({ success, testCaseInfo: { public: false } });

describe('toCodeRun', () => {
  it('reports a compile failure with the compiler output and no cases', () => {
    const compileError = {
      success: false,
      testCaseInfo: { public: true, type: 'function', data: {} },
      runInfo: { failure: 'compile_error' },
      compilerOutput: "error: expected ';' before 'if'"
    };
    expect(toCodeRun([compileError, hidden(false)])).toEqual({
      compiled: false,
      compilerOutput: "error: expected ';' before 'if'",
      cases: [],
      hiddenFailed: 0
    });
  });

  it('keeps public cases and counts hidden failures without their contents', () => {
    const run = toCodeRun([
      stdioResult('4 6', '24', '24', true),
      stdioResult('2 3', '6', '5', false),
      hidden(true),
      hidden(false)
    ]);
    expect(run.compiled).toBe(true);
    expect(run.cases).toEqual([
      { input: '4 6', expected: '24', actual: '24', passed: true },
      { input: '2 3', expected: '6', actual: '5', passed: false }
    ]);
    expect(run.hiddenFailed).toBe(1);
  });

  it('renders a function case as its arguments and the values returned', () => {
    expect(toCodeRun([functionResult(['612', '123450002'], '1', '0', false)]).cases).toEqual([
      { input: '612, 123450002', expected: '1', actual: '0', passed: false }
    ]);
  });
});

describe('shouldAsk', () => {
  it('asks when anything failed, and not when everything passed', () => {
    expect(shouldAsk([stdioResult('1', '1', '1', true), hidden(false)])).toBe(true);
    expect(shouldAsk([stdioResult('1', '1', '1', true), hidden(true)])).toBe(false);
    expect(shouldAsk([])).toBe(false);
  });
});

describe('LatestOnly', () => {
  it('drops a reply that arrives after a newer request was made', async () => {
    const latest = new LatestOnly();
    let releaseFirst: (v: string) => void = () => {};
    const first = latest.run(() => new Promise<string>((resolve) => (releaseFirst = resolve)));
    const second = latest.run(async () => 'second');
    expect(await second).toEqual({ current: true, value: 'second' });
    releaseFirst('first');
    expect(await first).toEqual({ current: false, value: 'first' });
  });
});

describe('review fixes', () => {
  it('reads a function case’s values from the hydrated TypeValues the page holds', () => {
    // What hydrateResults leaves in runInfo: class instances whose own field is `.value`,
    // serialising back to `{ type, data: { value } }`.
    const hydrated = (value: string) => ({
      value: { value },
      toJSON: () => ({ type: 'int', options: {}, data: { value } })
    });
    const result = {
      success: false,
      testCaseInfo: { public: true, type: 'function', data: { parameters: [{ value: intValue('612') }] } },
      runInfo: { comparisons: [{ symbol: 'return', expected: hydrated('1'), actual: hydrated('0'), result: false }] }
    };
    expect(toCodeRun([result]).cases[0]).toMatchObject({ expected: '1', actual: '0' });
  });

  it('recognises a stdio program that did not compile by its compiler output', () => {
    const result = {
      success: false,
      testCaseInfo: { public: true, type: 'stdio', data: { input: '1', output: '1' } },
      runInfo: { expected: '1', actual: '' },
      compilerOutput: "main.c:3: error: expected ';'"
    };
    expect(toCodeRun([result])).toMatchObject({ compiled: false, compilerOutput: "main.c:3: error: expected ';'" });
  });

  it('asks for Implement feedback once Implement is reached, whichever phase is open', () => {
    expect(implementReached([{ unlocked: true }, { unlocked: true }, { unlocked: true }, { unlocked: true }])).toBe(
      true
    );
    expect(implementReached([{ unlocked: true }, { unlocked: true }, { unlocked: true }, { unlocked: false }])).toBe(
      false
    );
  });
});
