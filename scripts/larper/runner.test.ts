import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CodeExecutor } from '$lib/executor';
import type { CodeRun } from '../../plugins/plugin-clive/server/codeNudge';
import type { ProblemForPrompt } from '../../plugins/plugin-clive/server/content/templates';
import { callModel } from '../../plugins/plugin-clive/server/llmCalls';
import type { Provider } from '../../plugins/plugin-clive/server/providers';
import { localExecutor } from './localExecutor';
import { runAnswer, runCode, type Deps } from './runner';
import type { Answer, Category, Expect, PhaseId, Result } from './types';

const PROBLEM: ProblemForPrompt = {
  slug: 'p',
  title: 'Product',
  statement: 'Read two whole numbers and print their product.',
  starter_code: '',
  public_test_cases: [
    { input: '4 6', output: '24' },
    { input: '2 3', output: '6' }
  ],
  reference_solution: '',
  functions: []
};

const FUNCTION_PROBLEM: ProblemForPrompt = {
  ...PROBLEM,
  public_test_cases: [{ input: 'product(4, 6)', output: '24' }],
  functions: [
    {
      id: 'f',
      name: 'product',
      parameters: [
        { name: 'a', type: 'int' },
        { name: 'b', type: 'int' }
      ],
      returnType: 'int'
    }
  ]
};

const PRIOR = [{ label: 'Problem', fields: [{ label: 'Summary', value: 's' }] }];
const GOOD_RUN: CodeRun = {
  compiled: true,
  compilerOutput: '',
  cases: [{ input: '4 6', expected: '24', actual: '24', passed: true }],
  hiddenFailed: 0
};
const BROKEN_RUN: CodeRun = { compiled: false, compilerOutput: "error: expected ';'", cases: [], hiddenFailed: 0 };

const category = (id: string, expect: Expect | null = null): Category => ({ id, name: id, writes: 'w', expect });
const answer = (phase: PhaseId, cat: string, artifact: Record<string, unknown>): Answer => ({
  problemId: 'p',
  phase,
  category: cat,
  variant: 1,
  artifact,
  writtenBy: 'larper'
});

const BLOCKED = {
  response: {
    passed: false,
    verdicts: [
      { criterion_id: 'novel_wording', verdict: 'FAIL', gate: 'gating' },
      { criterion_id: 'input_types', verdict: 'PASS', gate: 'gating' },
      { criterion_id: 'input_order_stated', verdict: 'FAIL', gate: 'advisory' }
    ],
    missing_ids: [],
    advisory_unmet: ['input_order_stated'],
    nudge: {
      situation: 'copied_statement',
      nudge: 'How would you say it to a classmate?',
      focus_id: 'novel_wording',
      focus_fields: ['summary']
    }
  },
  record: { kept: true }
};
const PASSED = {
  response: { passed: true, verdicts: [], missing_ids: [], advisory_unmet: ['follows_own_design'] },
  record: {}
};

function deps(over: Partial<Record<keyof Deps, unknown>> = {}) {
  return {
    submit: vi.fn(async () => BLOCKED),
    codeNudge: vi.fn(async () => ({
      situation: 'syntax_following_plan',
      summary: '',
      focus: 'line 3',
      nudge: 'Look at line 3.'
    })),
    runCode: vi.fn(async () => GOOD_RUN),
    executor: {} as CodeExecutor,
    ...over
  } as unknown as Deps & {
    submit: ReturnType<typeof vi.fn>;
    codeNudge: ReturnType<typeof vi.fn>;
    runCode: ReturnType<typeof vi.fn>;
  };
}

const PROBLEM_ANSWER = answer('problem_definition', 'copied_from_summary', { summary: 's', inputs: 'i', outputs: 'o' });

it('a blocked submit is reported with what failed, the situation and the feedback', async () => {
  const d = deps();
  const r = await runAnswer(PROBLEM_ANSWER, category('copied_from_summary'), PROBLEM, PRIOR, d);
  expect(r).toMatchObject({
    pass: 1,
    blocked: true,
    failed: ['novel_wording'],
    advisoryUnmet: ['input_order_stated'],
    situation: 'copied_statement',
    feedback: 'How would you say it to a classmate?',
    focusFields: ['summary'],
    offCategory: false,
    matches: null,
    record: { kept: true }
  });
  expect(r.error).toBeUndefined();
  const [body, executor] = d.submit.mock.calls[0];
  expect(body).toMatchObject({
    phase: 'problem_definition',
    problemId: 'p',
    artifact: PROBLEM_ANSWER.artifact,
    attempt: 1,
    priorArtifacts: PRIOR,
    history: []
  });
  expect(body.step).toBeUndefined();
  expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(executor).toBe(d.executor);
});

it('an answer that passes has no situation and no feedback', async () => {
  const r = await runAnswer(
    PROBLEM_ANSWER,
    category('control'),
    PROBLEM,
    [],
    deps({ submit: vi.fn(async () => PASSED) })
  );
  expect(r).toMatchObject({ blocked: false, failed: [], situation: null, feedback: '' });
});

it('Cases is submitted as Case 1', async () => {
  const d = deps();
  await runAnswer(answer('case_design', 'abstract', { normal_cases: [] }), category('abstract'), PROBLEM, PRIOR, d);
  expect(d.submit.mock.calls[0][0].step).toBe('normal_cases');
});

it('feedback that could not be written is reported beside the verdicts', async () => {
  const noNudge = { response: { ...BLOCKED.response, nudge: undefined, nudge_error: 'model down' }, record: {} };
  const r = await runAnswer(PROBLEM_ANSWER, category('x'), PROBLEM, [], deps({ submit: vi.fn(async () => noNudge) }));
  expect(r.blocked).toBe(true);
  expect(r.failed).toEqual(['novel_wording']);
  expect(r.error).toContain('model down');
});

it('Implement code that passes the examples goes to the plan review', async () => {
  const d = deps({ submit: vi.fn(async () => PASSED) });
  const a = answer('implement', 'correct_ignores_plan', { code: 'CODE' });
  const r = await runAnswer(a, category('correct_ignores_plan'), PROBLEM, PRIOR, d);
  expect(d.runCode).toHaveBeenCalledWith(PROBLEM, 'CODE', d.executor);
  expect(d.codeNudge).not.toHaveBeenCalled();
  expect(d.submit.mock.calls[0][0]).toMatchObject({ phase: 'implement', code: 'CODE', priorArtifacts: PRIOR });
  expect(r).toMatchObject({
    blocked: false,
    advisoryUnmet: ['follows_own_design'],
    observed: { compiled: true, publicPassed: true },
    offCategory: false
  });
});

it('Implement code that does not compile goes to the code feedback', async () => {
  const d = deps({ runCode: vi.fn(async () => BROKEN_RUN) });
  const a = answer('implement', 'compile_error', { code: 'CODE' });
  const r = await runAnswer(a, category('compile_error'), PROBLEM, PRIOR, d);
  expect(d.submit).not.toHaveBeenCalled();
  expect(d.codeNudge).toHaveBeenCalledWith(PROBLEM, 'CODE', BROKEN_RUN, PRIOR, [], 1);
  expect(r).toMatchObject({
    blocked: true,
    failed: [],
    situation: 'syntax_following_plan',
    feedback: 'Look at line 3.',
    observed: { compiled: false, publicPassed: false },
    offCategory: false
  });
});

it('Implement code that compiles but fails an example goes to the code feedback', async () => {
  const failing: CodeRun = { ...GOOD_RUN, cases: [{ input: '4 6', expected: '24', actual: '10', passed: false }] };
  const d = deps({ runCode: vi.fn(async () => failing) });
  const r = await runAnswer(answer('implement', 'control', { code: 'C' }), category('control'), PROBLEM, [], d);
  expect(d.codeNudge).toHaveBeenCalled();
  expect(r).toMatchObject({ blocked: true, observed: { compiled: true, publicPassed: false }, offCategory: true });
});

it('a compile-error answer whose code compiles is off-category', async () => {
  const d = deps({ submit: vi.fn(async () => PASSED) });
  const r = await runAnswer(
    answer('implement', 'compile_error', { code: 'C' }),
    category('compile_error'),
    PROBLEM,
    [],
    d
  );
  expect(r.offCategory).toBe(true);
});

it('the repeat is a second attempt that carries the first feedback', async () => {
  const d = deps();
  const first = await runAnswer(PROBLEM_ANSWER, category('x'), PROBLEM, [], d);
  const second = await runAnswer(PROBLEM_ANSWER, category('x'), PROBLEM, [], d, first);
  expect(second.pass).toBe(2);
  expect(d.submit.mock.calls[1][0]).toMatchObject({
    attempt: 2,
    history: [
      {
        attempt: 1,
        situation: 'copied_statement',
        focus_id: 'novel_wording',
        nudge: 'How would you say it to a classmate?'
      }
    ]
  });
});

it('the repeat of code feedback carries the first reply', async () => {
  const d = deps({ runCode: vi.fn(async () => BROKEN_RUN) });
  const a = answer('implement', 'compile_error', { code: 'C' });
  const first = await runAnswer(a, category('compile_error'), PROBLEM, [], d);
  await runAnswer(a, category('compile_error'), PROBLEM, [], d, first);
  expect(d.codeNudge.mock.calls[1].slice(4)).toEqual([
    [{ situation: 'syntax_following_plan', focus: 'line 3', nudge: 'Look at line 3.' }],
    2
  ]);
});

it('a submit that throws becomes an errored row, not a thrown error', async () => {
  const d = deps({ submit: vi.fn(async () => Promise.reject(new Error('provider down'))) });
  const r = await runAnswer(PROBLEM_ANSWER, category('x'), PROBLEM, [], d);
  expect(r).toMatchObject({ blocked: null, error: 'provider down', situation: null, matches: null });
});

it('an answer the larper could not write is not submitted', async () => {
  const d = deps();
  const r = await runAnswer({ ...PROBLEM_ANSWER, artifact: {}, error: 'bad reply' }, category('x'), PROBLEM, [], d);
  expect(d.submit).not.toHaveBeenCalled();
  expect(r).toMatchObject({ blocked: null, error: 'bad reply' });
});

it.each<[string, Expect, boolean]>([
  ['blocks, as expected', { blocks: true }, true],
  ['blocks, when it should not', { blocks: false }, false],
  ['a required point that failed', { fails: ['novel_wording'] }, true],
  ['an optional point that is unmet', { fails: ['input_order_stated'] }, true],
  ['a point that did not fail', { fails: ['input_types'] }, false],
  ['one of the acceptable situations', { situations: ['other', 'copied_statement'] }, true],
  ['none of the acceptable situations', { situations: ['missing_detail'] }, false],
  ['every key agreeing', { blocks: true, fails: ['novel_wording'], situations: ['copied_statement'] }, true],
  ['one key disagreeing', { blocks: true, fails: ['novel_wording'], situations: ['other'] }, false]
])('an expectation is compared: %s', async (_name, expectation, matches) => {
  const r = await runAnswer(PROBLEM_ANSWER, category('x', expectation), PROBLEM, [], deps());
  expect(r.matches).toBe(matches);
});

it('an errored row is never compared with its expectation', async () => {
  const d = deps({ submit: vi.fn(async () => Promise.reject(new Error('down'))) });
  const r: Result = await runAnswer(PROBLEM_ANSWER, category('x', { blocks: true }), PROBLEM, [], d);
  expect(r.matches).toBeNull();
});

it('keeps which model CLive used and what each call cost', async () => {
  const provider = {
    name: 'fake',
    defaultModel: 'fake-model',
    apiKeyEnv: 'UNUSED',
    modelPrefixes: [],
    ownsModel: () => true,
    hasApiKey: () => true,
    judgeJson: async () => ({ parsed: {}, model: 'fake-model-2', inputTokens: 5, outputTokens: 7 })
  } as Provider;
  const submitting = vi.fn(async () => {
    await callModel(provider, 'judge', {
      system: 's',
      user: 'THE WHOLE PROMPT',
      model: 'fake-model',
      maxOutputTokens: 10,
      effort: 'low',
      schema: z.object({}),
      schemaText: '{}'
    });
    return PASSED;
  });
  const r = await runAnswer(PROBLEM_ANSWER, category('control'), PROBLEM, [], deps({ submit: submitting }));
  expect(r.calls).toMatchObject([{ purpose: 'judge', model: 'fake-model-2', input_tokens: 5, output_tokens: 7 }]);
  expect(JSON.stringify(r.calls)).not.toContain('THE WHOLE PROMPT');
});

it('says so when CLive left a requirement unjudged', async () => {
  const missing = { response: { ...PASSED.response, passed: false, missing_ids: ['input_types'] }, record: {} };
  const r = await runAnswer(PROBLEM_ANSWER, category('x'), PROBLEM, [], deps({ submit: vi.fn(async () => missing) }));
  expect(r.blocked).toBe(true);
  expect(r.error).toMatch(/input_types/);
});

// These compile C on this machine; a machine without gcc skips them.
const gcc = spawnSync('gcc', ['--version']).status === 0;

const CORRECT =
  '#include <stdio.h>\nint main(void)\n{\n  int a, b;\n  scanf("%d %d", &a, &b);\n  printf("%d\\n", a * b);\n  return 0;\n}\n';

it.skipIf(!gcc)('runCode compiles a program and runs it on every example', async () => {
  const run = await runCode(PROBLEM, CORRECT, localExecutor);
  expect(run.compiled).toBe(true);
  expect(run.cases).toEqual([
    { input: '4 6', expected: '24', actual: '24\n', passed: true },
    { input: '2 3', expected: '6', actual: '6\n', passed: true }
  ]);
  expect(run.hiddenFailed).toBe(0);
});

it.skipIf(!gcc)('runCode reports a wrong result as a failed example', async () => {
  const run = await runCode(PROBLEM, CORRECT.replace('a * b', 'a + b'), localExecutor);
  expect(run.compiled).toBe(true);
  expect(run.cases.map((c) => c.passed)).toEqual([false, false]);
});

it.skipIf(!gcc)('runCode reports a program that does not compile, with the compiler output', async () => {
  const run = await runCode(PROBLEM, CORRECT.replace('int a, b;', 'int a, b'), localExecutor);
  expect(run.compiled).toBe(false);
  expect(run.compilerOutput).toMatch(/error/);
  expect(run.cases).toEqual([]);
});

it.skipIf(!gcc)('runCode calls the function a function problem asks for', async () => {
  const run = await runCode(FUNCTION_PROBLEM, 'int product(int a, int b)\n{\n  return a * b;\n}\n', localExecutor);
  expect(run.compiled).toBe(true);
  expect(run.cases).toEqual([{ input: 'product(4, 6)', expected: '24', actual: '24\n', passed: true }]);
});

it.skipIf(!gcc)('runCode reads the arguments of an example whose function name has a digit in it', async () => {
  const problem: ProblemForPrompt = {
    ...FUNCTION_PROBLEM,
    public_test_cases: [{ input: 'sum2(3, 4)', output: '7' }],
    functions: [{ ...FUNCTION_PROBLEM.functions[0], name: 'sum2' }]
  };
  const run = await runCode(problem, 'int sum2(int a, int b)\n{\n  return a + b;\n}\n', localExecutor);
  expect(run.cases.map((c) => c.passed)).toEqual([true]);
});

it.skipIf(!gcc)('runCode passes a letter to a function that takes one', async () => {
  const problem: ProblemForPrompt = {
    ...FUNCTION_PROBLEM,
    public_test_cases: [
      { input: "isVowel('a')", output: '1' },
      { input: 'isVowel(b)', output: '0' }
    ],
    functions: [{ id: 'f', name: 'isVowel', parameters: [{ name: 'c', type: 'char' }], returnType: 'int' }]
  };
  const code = "int isVowel(char c)\n{\n  return c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u';\n}\n";
  const run = await runCode(problem, code, localExecutor);
  expect(run.cases.map((c) => c.passed)).toEqual([true, true]);
});
