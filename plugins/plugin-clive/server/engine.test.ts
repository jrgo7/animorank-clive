/**
 * The engine's behavior, with a fake provider and a fake executor — no network,
 * no Judge0. Ported contract-by-contract from the prototype's `judge.py`,
 * `nudge.py`, `stuck.py`, `reference_check.py`, `grade.py` and `steps.py`.
 */
import { describe, expect, it } from 'vitest';
import { CodeExecutor } from '$lib/executor';
import type { ExecutionRequest, ExecutionResult } from '$lib/executor/types';
import { phaseDoc, rubricDoc } from './content/load';
import { JudgeError } from './content/errors';
import { judge } from './judge';
import { nudge } from './nudge';
import { codeNudge, type CodeRun } from './codeNudge';
import type { Provider } from './providers';
import { publicTestRun } from './publicTests';
import { caseStdin, check, functionArgs, functionHarness, judgeWithChecks, outputsMatch } from './referenceCheck';
import { cut, isPerStep } from './steps';
import { stuck } from './stuck';
import type { ProblemForPrompt } from './content/templates';

const PROBLEM: ProblemForPrompt = {
  slug: 'fixture',
  title: 'Fixture',
  statement: 'Read two numbers and print their product.',
  public_test_cases: [{ input: '4 6', output: '24' }],
  starter_code: '',
  reference_solution: '',
  functions: []
};

function fakeProvider(parsed: unknown): Provider {
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    apiKeyEnv: 'UNUSED',
    modelPrefixes: ['fake-'],
    ownsModel: (id) => id.startsWith('fake-'),
    hasApiKey: () => true,
    judgeJson: async () => ({ parsed, model: 'fake-model', inputTokens: 3, outputTokens: 5 })
  };
}

type FakeRun = (_request: ExecutionRequest) => ExecutionResult;

class FakeExecutor extends CodeExecutor {
  private readonly run: FakeRun;
  public constructor(run: FakeRun) {
    super();
    this.run = run;
  }
  public async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return this.run(request);
  }
}

function execution(compileExit: number, runExit: number, stdout: string): ExecutionResult {
  return {
    processOutputs: [
      { exitCode: compileExit, stdout: Buffer.from(''), stderr: Buffer.from(compileExit ? 'boom' : '') },
      { exitCode: runExit, stdout: Buffer.from(stdout), stderr: Buffer.from('') }
    ],
    fileOutputs: []
  };
}

const CASES_ARTIFACT = { normal_cases: [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }] };

describe('judge', () => {
  const phase = phaseDoc('problem_definition');
  const criteria = rubricDoc('problem_definition').criteria;
  const artifact = { summary: 'Print the product of two numbers.', inputs: '4 6.', outputs: 'The product.' };

  it('audits each evidence span against the artifact and flags missing verdicts', async () => {
    const provider = fakeProvider({
      verdicts: [
        { criterion_id: 'novel_wording', verdict: 'PASS', evidence: 'Print the product', confidence: 'high' },
        // An empty quote is not a fabrication, so it audits clean.
        { criterion_id: 'invented', verdict: 'FAIL', evidence: '', confidence: 'low' },
        { criterion_id: 'input_types', verdict: 'FAIL', evidence: 'a span that is not there', confidence: 'low' }
      ]
    });
    const result = await judge(phase, PROBLEM, artifact, criteria, 1, [], provider);

    expect(result.verdicts.find((v) => v.criterion_id === 'novel_wording')?.evidence_found).toBe(true);
    expect(result.verdicts.find((v) => v.criterion_id === 'invented')?.evidence_found).toBe(true);
    expect(result.verdicts.find((v) => v.criterion_id === 'input_types')?.evidence_found).toBe(false);
    expect(result.missing_ids).not.toContain('novel_wording');
    expect(result.missing_ids).toContain('output_types');
    expect(result.unexpected_ids).toEqual(['invented']);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
  });

  it('rejects a phase with no criteria', async () => {
    await expect(judge(phase, PROBLEM, artifact, [], 1, [], fakeProvider({ verdicts: [] }))).rejects.toThrow(
      /no criteria yet/
    );
  });
});

describe('nudge', () => {
  const phase = phaseDoc('case_design');
  const criteria = rubricDoc('case_design').criteria;
  const verdicts = [
    { criterion_id: 'case_is_concrete', verdict: 'PASS' as const, evidence: '4 6', confidence: 'high' as const },
    { criterion_id: 'work_is_shown', verdict: 'FAIL' as const, evidence: '4 * 6', confidence: 'high' as const },
    { criterion_id: 'outputs_are_correct', verdict: 'FAIL' as const, evidence: '', confidence: 'low' as const },
    {
      criterion_id: 'output_format_matches_statement',
      verdict: 'FAIL' as const,
      evidence: '24',
      confidence: 'high' as const
    }
  ];

  it('returns the failing gating criteria in rubric order, never the model’s list', async () => {
    const provider = fakeProvider({ summary: 's', focus_id: 'work_is_shown', reason: 'r', nudge: 'n' });
    const result = await nudge(phase, PROBLEM, CASES_ARTIFACT, criteria, verdicts, 1, [], [], provider);

    // The advisory failure is not offered, and `failing` is the gating set only.
    expect(result.failing.map((f) => f.id)).toEqual(['work_is_shown', 'outputs_are_correct']);
    expect(result.focus_text).toBe(criteria.find((c) => c.id === 'work_is_shown')?.text);
  });

  it('rejects a focus_id that is not among the failing gating criteria', async () => {
    const provider = fakeProvider({
      summary: 's',
      focus_id: 'output_format_matches_statement',
      reason: 'r',
      nudge: 'n'
    });
    await expect(nudge(phase, PROBLEM, CASES_ARTIFACT, criteria, verdicts, 1, [], [], provider)).rejects.toThrow(
      /not among the failing gating criteria/
    );
  });

  it('returns the situation the model decided the student is in', async () => {
    const provider = fakeProvider({
      situation: 'rule_not_worked',
      summary: 's',
      focus_id: 'work_is_shown',
      reason: 'r',
      nudge: 'n'
    });
    const result = await nudge(phase, PROBLEM, CASES_ARTIFACT, criteria, verdicts, 1, [], [], provider);
    expect(result.situation).toBe('rule_not_worked');
  });

  it('turns a situation the phase does not list into other', async () => {
    const provider = fakeProvider({
      situation: 'plan_is_wrong',
      summary: 's',
      focus_id: 'work_is_shown',
      reason: 'r',
      nudge: 'n'
    });
    const result = await nudge(phase, PROBLEM, CASES_ARTIFACT, criteria, verdicts, 1, [], [], provider);
    expect(result.situation).toBe('other');
  });

  it('rejects when nothing is blocking', async () => {
    const passing = verdicts.map((v) => ({ ...v, verdict: 'PASS' as const }));
    await expect(nudge(phase, PROBLEM, CASES_ARTIFACT, criteria, passing, 1, [], [], fakeProvider({}))).rejects.toThrow(
      /Nothing is blocking/
    );
  });
});

describe('stuck', () => {
  const phase = phaseDoc('case_design');

  it('returns the feedback for the student and the diagnosis for the researcher', async () => {
    const provider = fakeProvider({
      diagnosis: 'Does not connect “leftover” with a remainder.',
      feedback: 'How many fit?\nWhat is left over?'
    });
    const result = await stuck(
      phase,
      PROBLEM,
      CASES_ARTIFACT,
      'I do not get the leftover.',
      undefined,
      [],
      [],
      undefined,
      provider
    );

    expect(result.feedback).toBe('How many fit?\nWhat is left over?');
    expect(result.diagnosis).toBe('Does not connect “leftover” with a remainder.');
  });

  it('passes the public test results and earlier asks into the prompt', async () => {
    let seen = '';
    const provider: Provider = {
      ...fakeProvider({ diagnosis: 'd', feedback: 'f' }),
      judgeJson: async (options) => {
        seen = options.user;
        return { parsed: { diagnosis: 'd', feedback: 'f' }, model: 'fake-model', inputTokens: 0, outputTokens: 0 };
      }
    };
    const tests = {
      compiled: true,
      cases: [{ input: '3', expected: '6', actual: '7', passed: false, status: 'ok' }],
      all_public_passed: false
    };
    const field = phase.artifact_fields.find((f) => f.id === 'normal_cases');
    await stuck(
      phase,
      PROBLEM,
      CASES_ARTIFACT,
      'I am stuck on the output.',
      field,
      [],
      [{ statement: 'Is my input right?', feedback: 'Which value first?' }],
      tests,
      provider
    );

    expect(seen).toContain('PUBLIC TEST RESULTS');
    expect(seen).toContain('printed "7" — FAIL');
    expect(seen).toContain('STUDENT IS ON');
    expect(seen).toContain('- student: Is my input right?');
    expect(seen).toContain('STUDENT SAYS');
  });
});

describe('public test run', () => {
  const cases = [
    { input: '3', output: '6' },
    { input: '1', output: '1' }
  ];

  it('passes each case whose output matches, ignoring trailing whitespace', async () => {
    const run = await publicTestRun('x', cases, new FakeExecutor(() => execution(0, 0, '6\n')));
    expect(run.compiled).toBe(true);
    expect(run.cases.map((c) => c.passed)).toEqual([true, false]);
    expect(run.all_public_passed).toBe(false);
  });

  it('says every public case passes when they all do', async () => {
    const run = await publicTestRun('x', [cases[0]], new FakeExecutor(() => execution(0, 0, '6  \n')));
    expect(run.all_public_passed).toBe(true);
  });

  it('does not forgive leading whitespace, as the app’s own grading does not', async () => {
    const run = await publicTestRun('x', [cases[0]], new FakeExecutor(() => execution(0, 0, ' 6\n')));
    expect(run.all_public_passed).toBe(false);
  });

  it('reports a program that did not compile, and a run that was stopped', async () => {
    const broken = await publicTestRun('x', cases, new FakeExecutor(() => execution(1, 0, '')));
    expect(broken).toMatchObject({ compiled: false, cases: [] });

    const stopped = await publicTestRun('x', [cases[0]], new FakeExecutor(() => execution(0, undefined as never, '')));
    expect(stopped.cases[0].status).toBe('timeout');
    expect(stopped.all_public_passed).toBe(false);
  });
});

describe('reference check', () => {
  it('compares values, rounding to the coarser precision', () => {
    expect(outputsMatch('63.3', '63.33')).toBe(true);
    expect(outputsMatch('63.4', '63.33')).toBe(false);
    expect(outputsMatch('  Yes ', 'YES')).toBe(true);
    expect(outputsMatch('Yes', '1')).toBe(false);
  });

  it('checks each row, reporting the wrong ones by label', async () => {
    const phase = phaseDoc('case_design');
    const pass = await check(
      phase,
      CASES_ARTIFACT,
      'int main(void){return 0;}',
      new FakeExecutor(() => execution(0, 0, '24\n'))
    );
    expect(pass).toMatchObject({ status: 'checked', verdict: 'PASS', wrong: [] });

    const fail = await check(
      phase,
      CASES_ARTIFACT,
      'int main(void){return 0;}',
      new FakeExecutor(() => execution(0, 0, '25\n'))
    );
    expect(fail).toMatchObject({ status: 'checked', verdict: 'FAIL', wrong: ['Case 1'] });
  });

  it('treats exit 3 as out of rules and a compile failure as an error', async () => {
    const phase = phaseDoc('case_design');
    const outside = await check(phase, CASES_ARTIFACT, 'x', new FakeExecutor(() => execution(0, 3, '')));
    expect(outside).toMatchObject({ status: 'checked', verdict: 'FAIL', outside: ['Case 1'] });

    const broken = await check(phase, CASES_ARTIFACT, 'x', new FakeExecutor(() => execution(1, 0, '')));
    expect(broken).toMatchObject({ status: 'error' });
  });

  const SUM = {
    id: 'f',
    name: 'f',
    parameters: [
      { name: 'a', type: 'int' },
      { name: 'b', type: 'int' }
    ],
    returnType: 'int'
  };

  it('wraps a function reference in a main that reads its arguments and prints what it returns', () => {
    const code = functionHarness('int f(int a, int b){return a+b;}', SUM) ?? '';
    expect(code).toContain('int f(int a, int b){return a+b;}');
    expect(code).toContain('main(');
    expect(code.match(/scanf\("%d", &/g)).toHaveLength(2);
    expect(code).toContain('printf("%d\\n", f(');
  });

  it('cannot wrap a function whose parameter type it does not know', () => {
    expect(
      functionHarness('int f(char *s){return 0;}', { ...SUM, parameters: [{ name: 's', type: 'char *' }] })
    ).toBeNull();
  });

  it('leaves a reference that already has a main as it is', () => {
    const own = 'int f(int a,int b){return a+b;}\nint main(void){return 0;}';
    expect(functionHarness(own, SUM)).toBe(own);
  });

  it('reads a case row typed with commas or extra spaces', () => {
    expect(caseStdin('612, 123456789')).toBe('612 123456789\n');
    expect(caseStdin('  1\n 2 ')).toBe('1 2\n');
  });

  it('runs a function reference through its generated main, on the row as typed', async () => {
    const seen: { code: string; stdin: string }[] = [];
    const executor = new FakeExecutor((request) => {
      seen.push({
        code: request.files[0].content.toString('utf8'),
        stdin: request.processes[1].stdin?.toString('utf8') ?? ''
      });
      return execution(0, 0, '1\n');
    });
    const artifact = { normal_cases: [{ input: '612, 123456789', output: '1', working: 'w' }] };
    const result = await check(phaseDoc('case_design'), artifact, 'int f(int a, int b){return 1;}', executor, SUM);
    expect(result).toMatchObject({ status: 'checked', verdict: 'PASS' });
    expect(seen[0].code).toContain('main(');
    expect(seen[0].stdin).toBe('612 123456789\n');
  });

  it('is unavailable for a function it cannot call', async () => {
    const fn = { ...SUM, parameters: [{ name: 's', type: 'char *' }] };
    const result = await check(phaseDoc('case_design'), CASES_ARTIFACT, 'int f(char *s){return 0;}', undefined, fn);
    expect(result).toMatchObject({ status: 'unavailable' });
  });

  it('reads a function case row in the forms students write it', () => {
    expect(functionArgs('612, 123,456,002', SUM)).toBe('612 123456002\n');
    expect(functionArgs('checkSecretCode(612, 123456002)', SUM)).toBe('612 123456002\n');
    expect(functionArgs('nAlice = 612, nGuest = 123456002', SUM)).toBe('612 123456002\n');
    expect(functionArgs('612', SUM)).toBeNull();
  });

  it('cannot compute a function case whose values it cannot read, rather than calling it out of rules', async () => {
    const artifact = { normal_cases: [{ input: '612', output: '1', working: 'w' }] };
    const result = await check(
      phaseDoc('case_design'),
      artifact,
      'int f(int a, int b){return 1;}',
      new FakeExecutor(() => execution(0, 3, '')),
      SUM
    );
    expect(result).toMatchObject({ status: 'unavailable' });
  });

  it('is unavailable without a reference solution', async () => {
    const result = await check(phaseDoc('case_design'), CASES_ARTIFACT, '', undefined);
    expect(result).toMatchObject({ status: 'unavailable' });
  });

  it('downgrades a reference criterion to advisory when the reference cannot run', async () => {
    const phase = phaseDoc('case_design');
    const criteria = rubricDoc('case_design').criteria;
    const provider = fakeProvider({
      verdicts: [
        { criterion_id: 'case_is_concrete', verdict: 'FAIL', evidence: '', confidence: 'low' },
        { criterion_id: 'work_is_shown', verdict: 'PASS', evidence: '', confidence: 'high' },
        { criterion_id: 'output_format_matches_statement', verdict: 'PASS', evidence: '', confidence: 'high' }
      ]
    });
    const result = await judgeWithChecks(phase, PROBLEM, CASES_ARTIFACT, criteria, 1, [], provider, undefined);

    const applied = result.criteria.find((c) => c.id === 'outputs_are_correct');
    expect(applied?.gate).toBe('advisory');
    expect(result.referenceCheck).toMatchObject({ status: 'unavailable' });
    // A FAIL on the downgraded criterion does not block, and its gate reaches the verdict.
    expect(result.verdicts.find((v) => v.criterion_id === 'case_is_concrete')?.verdict).toBe('FAIL');
  });

  it('computes the reference verdict, in rubric order, when it can run', async () => {
    const phase = phaseDoc('case_design');
    const criteria = rubricDoc('case_design').criteria;
    const provider = fakeProvider({
      verdicts: [
        { criterion_id: 'case_is_concrete', verdict: 'PASS', evidence: '', confidence: 'high' },
        { criterion_id: 'work_is_shown', verdict: 'PASS', evidence: '', confidence: 'high' },
        { criterion_id: 'output_format_matches_statement', verdict: 'PASS', evidence: '', confidence: 'high' }
      ]
    });
    const result = await judgeWithChecks(
      phase,
      { ...PROBLEM, reference_solution: 'int main(void){return 0;}' },
      CASES_ARTIFACT,
      criteria,
      1,
      [],
      provider,
      new FakeExecutor(() => execution(0, 0, '24\n'))
    );

    const computed = result.verdicts.find((v) => v.criterion_id === 'outputs_are_correct');
    expect(computed).toMatchObject({ verdict: 'PASS', source: 'reference', evidence_found: true });
    expect(result.verdicts.map((v) => v.criterion_id)).toEqual(criteria.map((c) => c.id));
  });
});

describe('steps.cut', () => {
  it('narrows the phase, artifact and criteria to one step', () => {
    const phase = phaseDoc('case_design');
    const criteria = rubricDoc('case_design').criteria;
    expect(isPerStep(phase)).toBe(true);

    const step = cut(phase, CASES_ARTIFACT, criteria, 'normal_cases');
    expect(step.phase.artifact_fields.map((f) => f.id)).toEqual(['normal_cases']);
    expect(Object.keys(step.artifact)).toEqual(['normal_cases']);
    expect(step.criteria.length).toBe(criteria.length);
    expect(step.criteria.every((c) => c.fields?.join() === 'normal_cases')).toBe(true);
  });

  it('rejects an unknown step', () => {
    const phase = phaseDoc('case_design');
    expect(() => cut(phase, {}, rubricDoc('case_design').criteria, 'nope')).toThrow(JudgeError);
  });
});

describe('code nudge', () => {
  const RUN_FAILING: CodeRun = {
    compiled: true,
    compilerOutput: '',
    cases: [{ input: 'checkSecretCode(612, 123450002)', expected: '1', actual: '0', passed: false }],
    hiddenFailed: 0
  };
  const REPLY = {
    situation: 'plan_is_wrong',
    summary: 'One case fails.',
    focus: 'your plan',
    nudge: 'Line one\nLine two'
  };

  function capturing(parsed: unknown): { provider: Provider; users: string[] } {
    const users: string[] = [];
    const base = fakeProvider(parsed);
    return {
      users,
      provider: {
        ...base,
        judgeJson: async (options) => {
          users.push(options.user);
          return base.judgeJson(options);
        }
      }
    };
  }

  it('returns the situation and feedback the model chose', async () => {
    const { provider } = capturing(REPLY);
    expect(await codeNudge(PROBLEM, 'int main(void){}', RUN_FAILING, [], [], 1, provider)).toEqual(REPLY);
  });

  it('reads a reply with no situation as other', async () => {
    const { situation: _omit, ...noSituation } = REPLY;
    const { provider } = capturing(noSituation);
    expect((await codeNudge(PROBLEM, '', RUN_FAILING, [], [], 1, provider)).situation).toBe('other');
  });

  it('turns a situation the Implement phase does not list into other', async () => {
    const { provider } = capturing({ ...REPLY, situation: 'banana' });
    expect((await codeNudge(PROBLEM, '', RUN_FAILING, [], [], 1, provider)).situation).toBe('other');
  });

  it('shows the compiler errors when the program did not compile', async () => {
    const { provider, users } = capturing(REPLY);
    const run: CodeRun = {
      compiled: false,
      compilerOutput: "error: expected ';' before 'if'",
      cases: [],
      hiddenFailed: 0
    };
    await codeNudge(PROBLEM, '', run, [], [], 1, provider);
    expect(users[0]).toContain('COMPILER ERRORS');
    expect(users[0]).toContain("expected ';' before 'if'");
  });

  it('tells the model only how many hidden cases failed', async () => {
    const { provider, users } = capturing(REPLY);
    await codeNudge(PROBLEM, '', { ...RUN_FAILING, hiddenFailed: 1 }, [], [], 1, provider);
    expect(users[0]).toContain('1 case the student has not seen');
  });

  it('shows a function problem its signature', async () => {
    const { provider, users } = capturing(REPLY);
    const problem = {
      ...PROBLEM,
      functions: [
        {
          id: 'f',
          name: 'checkSecretCode',
          parameters: [
            { name: 'nAlice', type: 'int' },
            { name: 'nGuest', type: 'int' }
          ],
          returnType: 'int'
        }
      ]
    };
    await codeNudge(problem, '', RUN_FAILING, [], [], 1, provider);
    expect(users[0]).toContain('int checkSecretCode(int nAlice, int nGuest)');
  });
});
