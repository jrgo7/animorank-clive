/**
 * The engine's behavior, with a fake provider and a fake executor — no network,
 * no Judge0. Ported contract-by-contract from the prototype's `judge.py`,
 * `nudge.py`, `reference_check.py`, `grade.py` and `steps.py`; the hint ladder
 * (`pickFocus`, the leak check) is this plugin's own.
 */
import { describe, expect, it, vi } from 'vitest';
import { CodeExecutor } from '$lib/executor';
import type { ExecutionRequest, ExecutionResult } from '$lib/executor/types';
import { phaseDoc, rubricDoc } from './content/load';
import { JudgeError } from './content/errors';
import { failingGates } from './criteria';
import { judge } from './judge';
import * as nudgeModule from './nudge';
import { findLeak, nudge, pickFocus } from './nudge';
import { codeNudge, findCodeLeak, type CodeNudgeRequest, type CodeRun } from './codeNudge';
import type { Provider } from './providers';
import {
  caseStdin,
  check,
  functionArgs,
  functionHarness,
  judgeWithChecks,
  outputsMatch,
  type CheckResult
} from './referenceCheck';
import { cut, isPerStep } from './steps';
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

  it('judges at the effort CLIVE_JUDGE_EFFORT names, when it is set', async () => {
    vi.stubEnv('CLIVE_JUDGE_EFFORT', 'low');
    const efforts: string[] = [];
    const base = fakeProvider({ verdicts: [] });
    const provider: Provider = {
      ...base,
      judgeJson: async (options) => {
        efforts.push(options.effort);
        return base.judgeJson(options);
      }
    };
    await judge(phase, PROBLEM, artifact, criteria, 1, [], provider);
    expect(efforts).toEqual(['low']);
    vi.unstubAllEnvs();
  });

  it('rejects a phase with no criteria', async () => {
    await expect(judge(phase, PROBLEM, artifact, [], 1, [], fakeProvider({ verdicts: [] }))).rejects.toThrow(
      /no criteria yet/
    );
  });
});

/** A provider that answers each call with the next reply in turn, and keeps every user message it was sent. */
function scripted(...replies: unknown[]): { provider: Provider; users: string[] } {
  const users: string[] = [];
  return {
    users,
    provider: {
      ...fakeProvider({}),
      judgeJson: async (options) => {
        users.push(options.user);
        return { parsed: replies.shift(), model: 'fake-model', inputTokens: 0, outputTokens: 0 };
      }
    }
  };
}

const verdict = (criterion_id: string, result: 'PASS' | 'FAIL', evidence = '') => ({
  criterion_id,
  verdict: result,
  evidence,
  confidence: 'high' as const
});

describe('pickFocus', () => {
  it('picks the first failing requirement in rubric order, whatever order the judge answered in', () => {
    const criteria = rubricDoc('problem_definition').criteria;
    const verdicts = [
      verdict('constraints_noted', 'FAIL'),
      verdict('output_types', 'FAIL'),
      verdict('input_types', 'FAIL'),
      verdict('novel_wording', 'PASS'),
      verdict('summary_is_correct', 'PASS')
    ];
    expect(pickFocus(criteria, verdicts)?.id).toBe('input_types');
  });

  it('picks a required requirement before an optional one written above it', () => {
    const design = rubricDoc('algorithm_design').criteria;
    const optional = design.find((c) => c.id === 'values_are_tracked')!;
    const required = design.find((c) => c.id === 'traceable_on_own_case')!;
    expect([optional.gate, required.gate]).toEqual(['advisory', 'gating']);
    const verdicts = [verdict('values_are_tracked', 'FAIL'), verdict('traceable_on_own_case', 'FAIL')];
    expect(pickFocus([optional, required], verdicts)?.id).toBe('traceable_on_own_case');
    // An optional failure alone is never nudged.
    expect(pickFocus([optional, required], [verdict('values_are_tracked', 'FAIL')])).toBeNull();
  });

  it('in Cases, picks only from the step being submitted', () => {
    // Made required here so only the per-step cut, not the gate, keeps it out of Case 1.
    const criteria = rubricDoc('case_design').criteria.map((c) =>
      c.id === 'worked_out_differently' ? { ...c, gate: 'gating' as const } : c
    );
    const artifact = { normal_cases: [{ input: '4 6', output: '25', working: '4 * 6' }], edge_cases: [] };
    const verdicts = [verdict('worked_out_differently', 'FAIL'), verdict('outputs_are_correct', 'FAIL')];
    const caseOne = cut(phaseDoc('case_design'), artifact, criteria, 'normal_cases');
    expect(pickFocus(caseOne.criteria, verdicts)?.id).toBe('outputs_are_correct');
    const caseTwo = cut(phaseDoc('case_design'), artifact, criteria, 'edge_cases');
    expect(pickFocus(caseTwo.criteria, verdicts)?.id).toBe('outputs_are_correct');
    expect(pickFocus(caseTwo.criteria, [verdict('worked_out_differently', 'FAIL')])?.id).toBe('worked_out_differently');
  });
});

describe('the level of a nudge', () => {
  it('is no longer read from the history: a submit always hints, and "I\'m stuck" asks for the prompt', () => {
    expect('levelFor' in nudgeModule).toBe(false);
  });
});

describe('nudge', () => {
  const phase = phaseDoc('case_design');
  const criteria = rubricDoc('case_design').criteria;
  const verdicts = [
    verdict('case_is_concrete', 'PASS', '4 6'),
    verdict('work_is_shown', 'FAIL', '4 * 6'),
    verdict('outputs_are_correct', 'FAIL'),
    verdict('worked_out_differently', 'FAIL', '24')
  ];
  const failing = failingGates(criteria, verdicts);
  const request = (provider: Provider, overrides: Partial<Parameters<typeof nudge>[0]> = {}) => ({
    phase,
    problem: PROBLEM,
    artifact: CASES_ARTIFACT,
    focus: failing[0],
    failing,
    level: 'hint' as const,
    provider,
    ...overrides
  });

  it('returns the level, the requirement it was given, and every failing gate in rubric order', async () => {
    const { provider } = scripted({ reason: 'Restates the answer.', nudge: 'Which numbers did you multiply?' });
    const result = await nudge(request(provider));

    expect(result).toMatchObject({
      level: 'hint',
      focus_id: 'work_is_shown',
      focus_text: criteria.find((c) => c.id === 'work_is_shown')?.text,
      focus_not_met: criteria.find((c) => c.id === 'work_is_shown')?.not_met,
      reason: 'Restates the answer.',
      nudge: 'Which numbers did you multiply?',
      leak_blocked: false,
      leaks: []
    });
    // The advisory failure is never in `failing`; the model chose nothing.
    expect(result.failing.map((f) => f.id)).toEqual(['work_is_shown', 'outputs_are_correct']);
    expect(result).not.toHaveProperty('situation');
    expect(result).not.toHaveProperty('summary');
  });

  it('shows the model only its one requirement, at the level asked', async () => {
    const { provider, users } = scripted({ reason: 'r', nudge: 'n' });
    await nudge(
      request(provider, {
        level: 'prompt',
        history: [{ attempt: 1, level: 'hint', focus_id: 'work_is_shown', nudge: 'Which numbers?' }]
      })
    );
    expect(users[0]).toContain('[work_is_shown]');
    expect(users[0]).not.toContain('[outputs_are_correct]');
    expect(users[0]).toContain('LEVEL\nprompt');
    expect(users[0]).toContain('- attempt 1, hint: Which numbers?');
  });
});

describe('the leak check', () => {
  const phase = phaseDoc('case_design');
  const criteria = rubricDoc('case_design').criteria;
  const failing = failingGates(criteria, [verdict('outputs_are_correct', 'FAIL', 'Case 1')]);
  /** A reference check that ran Case 1 and printed `actual`; the student claimed `claimed`. */
  const checked = (actual: string, claimed = '25'): CheckResult => ({
    status: 'checked',
    verdict: claimed === actual ? 'PASS' : 'FAIL',
    wrong: claimed === actual ? [] : ['Case 1'],
    outside: [],
    rows: [
      { label: 'Case 1', input: '4 6', claimed, actual: `${actual}\n`, outcome: claimed === actual ? 'right' : 'wrong' }
    ]
  });
  const request = (provider: Provider, referenceCheck: CheckResult | null) => ({
    phase,
    problem: PROBLEM,
    artifact: CASES_ARTIFACT,
    focus: failing[0],
    failing,
    level: 'prompt' as const,
    provider,
    referenceCheck
  });

  it('asks once more when a reply gives away the reference output, then blocks it', async () => {
    const { provider, users } = scripted(
      { reason: 'r', nudge: 'Is it 24?' },
      { reason: 'r', nudge: 'Check it: 4 times 6 is 24.' }
    );
    const result = await nudge(request(provider, checked('24')));

    expect(users).toHaveLength(2);
    // The second ask names what was given away, without repeating the value itself.
    const note = users[1].slice(users[0].length);
    expect(note).toContain('expected output');
    expect(note).not.toContain('24');
    expect(result.nudge).toBe('');
    expect(result.leak_blocked).toBe(true);
    expect(result.leaks).toHaveLength(2);
  });

  it('keeps the second reply when it no longer gives anything away', async () => {
    const { provider, users } = scripted(
      { reason: 'r', nudge: 'Is it 24?' },
      { reason: 'r', nudge: 'What is 4 groups of 6?' }
    );
    const result = await nudge(request(provider, checked('24')));
    expect(users).toHaveLength(2);
    expect(result).toMatchObject({ nudge: 'What is 4 groups of 6?', leak_blocked: false });
    expect(result.leaks).toHaveLength(1);
  });

  it('does not check a single-character output', async () => {
    const { provider, users } = scripted({ reason: 'r', nudge: 'Is it 7?' });
    const result = await nudge(request(provider, checked('7')));
    expect(users).toHaveLength(1);
    expect(result).toMatchObject({ nudge: 'Is it 7?', leak_blocked: false, leaks: [] });
  });

  it('matches the output as a whole token only', () => {
    expect(findLeak('case_design', 'Is it 24?', checked('24'))).not.toBeNull();
    expect(findLeak('case_design', 'What about 240, or 1.24, or 24.5?', checked('24'))).toBeNull();
    expect(findLeak('case_design', 'Would it print yes?', checked('YES'))).not.toBeNull();
  });

  it('never counts a value the student already wrote and got right', () => {
    expect(findLeak('case_design', 'How did you get 24?', checked('24', '24'))).toBeNull();
  });

  it('catches C code in a Problem or Design nudge', () => {
    for (const text of [
      'Try printf("%d", n)?',
      'Would scanf (" %c", &c) read it?',
      'What does int total = 0 do?',
      'Set total to 0;',
      'Is it for (i = 0; ...)?',
      'What about while (n > 0)?',
      'What if (n < 0) holds?',
      'Wrap it in { }?'
    ]) {
      expect(findLeak('algorithm_design', text, null), text).not.toBeNull();
      expect(findLeak('problem_definition', text, null), text).not.toBeNull();
    }
    for (const text of [
      'Which C type can hold a number like 87.5?',
      'What is the total before the first score is added?\nWhich step gives it that value?',
      'Section 1: _ + _ + _ = _'
    ]) {
      expect(findLeak('algorithm_design', text, null), text).toBeNull();
    }
  });

  it('asks again when a Design nudge holds code', async () => {
    const design = rubricDoc('algorithm_design').criteria;
    const designFailing = failingGates(design, [verdict('values_are_tracked', 'FAIL'), verdict('not_c_code', 'FAIL')]);
    const { provider, users } = scripted(
      { reason: 'r', nudge: 'Start with int total = 0?' },
      { reason: 'r', nudge: 'What is the total before anything is added?' }
    );
    const result = await nudge({
      phase: phaseDoc('algorithm_design'),
      problem: PROBLEM,
      artifact: { steps: [{ text: 'Add each score to the total.', level: 0 }] },
      focus: designFailing[0],
      failing: designFailing,
      level: 'hint',
      provider
    });
    expect(users).toHaveLength(2);
    expect(users[1].slice(users[0].length)).toContain('C code');
    expect(result.nudge).toBe('What is the total before anything is added?');
  });
});

describe('reference check', () => {
  it('compares values, rounding to the coarser precision', () => {
    expect(outputsMatch('63.3', '63.33')).toBe(true);
    expect(outputsMatch('63.4', '63.33')).toBe(false);
    expect(outputsMatch('  Yes ', 'YES')).toBe(true);
    expect(outputsMatch('Yes', '1')).toBe(false);
  });

  it('ignores a label written before the output, as students write them', () => {
    expect(outputsMatch('Output: 1', '1\n')).toBe(true);
    expect(outputsMatch('Expected output: 602002110', '602002110')).toBe(true);
    expect(outputsMatch('Output: 2', '1')).toBe(false);
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

  it('drops input labels, whose digits are not arguments', () => {
    expect(functionArgs('Input: 812\nInput: 602002110', SUM)).toBe('812 602002110\n');
    expect(functionArgs('Input1: 812\nInput2: 602002110', SUM)).toBe('812 602002110\n');
    expect(functionArgs('Input1: 812', SUM)).toBeNull();
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

  it('is unavailable, not broken, when it cannot tell which of several functions the student writes', async () => {
    const two = { ...SUM, id: 'g', name: 'g' };
    const problem = {
      ...PROBLEM,
      reference_solution: 'int f(int a,int b){return 1;} int g(int a,int b){return 2;}',
      functions: [SUM, two]
    };
    const phase = phaseDoc('case_design');
    const criteria = rubricDoc('case_design').criteria;
    const verdicts = criteria
      .filter((c) => c.check !== 'reference')
      .map((c) => ({ criterion_id: c.id, verdict: 'PASS', evidence: '', confidence: 'high' }));
    const result = await judgeWithChecks(phase, problem, CASES_ARTIFACT, criteria, 1, [], fakeProvider({ verdicts }));
    expect(result.referenceCheck).toMatchObject({ status: 'unavailable' });
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
        { criterion_id: 'worked_out_differently', verdict: 'PASS', evidence: '', confidence: 'high' }
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
        { criterion_id: 'worked_out_differently', verdict: 'PASS', evidence: '', confidence: 'high' }
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
    expect(step.criteria.map((c) => c.id)).toEqual(
      criteria.filter((c) => (c.fields ?? []).includes('normal_cases')).map((c) => c.id)
    );
    expect(step.criteria.every((c) => c.fields?.join() === 'normal_cases')).toBe(true);
    // `worked_out_differently` names Case 2 alone.
    expect(step.criteria.map((c) => c.id)).not.toContain('worked_out_differently');
    expect(cut(phase, CASES_ARTIFACT, criteria, 'edge_cases').criteria.map((c) => c.id)).toContain(
      'worked_out_differently'
    );
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

  /** A code nudge at `hint` on the failing run, with whatever the test changes. */
  const ask = (provider: Provider, overrides: Partial<CodeNudgeRequest> = {}) =>
    codeNudge({
      problem: PROBLEM,
      code: '',
      run: RUN_FAILING,
      priorArtifacts: [],
      history: [],
      attempt: 1,
      level: 'hint',
      provider,
      ...overrides
    });

  it('returns the situation and feedback the model chose, at the level asked, with nothing leaked', async () => {
    const { provider, users } = capturing(REPLY);
    expect(await ask(provider, { code: 'int main(void){}' })).toEqual({
      ...REPLY,
      level: 'hint',
      leaks: [],
      leak_blocked: false
    });
    expect(users[0]).toContain('LEVEL\nhint');
    expect(users[0]).not.toContain('SITUATION\n');
  });

  it('writes a prompt to the situation and place the hint settled on, whatever the model says', async () => {
    const { provider, users } = capturing({ ...REPLY, situation: 'other', focus: 'somewhere else' });
    const result = await ask(provider, {
      level: 'prompt',
      fixed: { situation: 'departs_from_plan', focus: 'the loop that adds each digit' }
    });

    expect(result).toMatchObject({
      level: 'prompt',
      situation: 'departs_from_plan',
      focus: 'the loop that adds each digit'
    });
    expect(users[0]).toContain('LEVEL\nprompt');
    expect(users[0]).toContain('SITUATION\ndeparts_from_plan');
    expect(users[0]).toContain('FOCUS\nthe loop that adds each digit');
  });

  it('shows the model each earlier reply with its level', async () => {
    const { provider, users } = capturing(REPLY);
    await ask(provider, {
      history: [
        { level: 'hint', situation: 'departs_from_plan', focus: 'step 2', nudge: 'Follow section two.' },
        { level: 'prompt', situation: 'departs_from_plan', focus: 'step 2', nudge: 'Where does nSum start?' }
      ]
    });
    expect(users[0]).toContain('- hint, [departs_from_plan] at step 2: Follow section two.');
    expect(users[0]).toContain('- prompt, [departs_from_plan] at step 2: Where does nSum start?');
  });

  it('reads a reply with no situation as other', async () => {
    const noSituation: Partial<typeof REPLY> = { ...REPLY };
    delete noSituation.situation;
    const { provider } = capturing(noSituation);
    expect((await ask(provider)).situation).toBe('other');
  });

  it('turns a situation the Implement phase does not list into other', async () => {
    const { provider } = capturing({ ...REPLY, situation: 'banana' });
    expect((await ask(provider)).situation).toBe('other');
  });

  it('calls a failing case’s result what the program gave, not what it printed', async () => {
    const { provider, users } = capturing(REPLY);
    await ask(provider);
    expect(users[0]).toContain('expected "1", got "0"');
  });

  it('shows the compiler errors when the program did not compile', async () => {
    const { provider, users } = capturing(REPLY);
    const run: CodeRun = {
      compiled: false,
      compilerOutput: "error: expected ';' before 'if'",
      cases: [],
      hiddenFailed: 0
    };
    await ask(provider, { run });
    expect(users[0]).toContain('COMPILER ERRORS');
    expect(users[0]).toContain("expected ';' before 'if'");
  });

  it('a program that did not compile is the syntax situation, whatever the model says', async () => {
    const { provider, users } = capturing({ ...REPLY, situation: 'far_from_plan' });
    const run: CodeRun = { compiled: false, compilerOutput: 'error: expected expression', cases: [], hiddenFailed: 0 };
    expect((await ask(provider, { code: 'int x = ;', run })).situation).toBe('syntax_following_plan');
    expect(users[0]).toContain('the situation is syntax_following_plan');
  });

  it('tells the model only how many hidden cases failed', async () => {
    const { provider, users } = capturing(REPLY);
    await ask(provider, { run: { ...RUN_FAILING, hiddenFailed: 1 } });
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
    await ask(provider, { problem });
    expect(users[0]).toContain('int checkSecretCode(int nAlice, int nGuest)');
  });

  describe('leak check', () => {
    const CODE =
      'int sum(int n)\n{\n    int nSum = 0;\n    for (int i = 0; i < n; i++)\n        nSum = nSum + i;\n    return nSum;\n}';

    /** Code feedback replies with these lines, in turn. */
    const scriptedCode = (...nudges: string[]) =>
      scripted(...nudges.map((nudge) => ({ ...REPLY, situation: 'departs_from_plan', nudge })));

    it('catches C the student did not write, and lets plain words through', () => {
      for (const text of [
        'Add total = 0;',
        'Try for (i = 0; i < 3; i++) instead.',
        'What about while (n > 0)?',
        'Is it if (digit > 5)?',
        'Use printf("%d", total) at the end.',
        'Read it with scanf(" %c", &c).',
        'Print it with %.2f.'
      ]) {
        expect(findCodeLeak(text, CODE), text).not.toBeNull();
      }
      for (const text of [
        'Which step of your plan starts the sum?',
        'If you follow section two through your plan, what should it start at?',
        'For each digit, what does your loop add?',
        'About 50% of the examples pass.',
        'Look at `nSum` inside your loop.'
      ]) {
        expect(findCodeLeak(text, CODE), text).toBeNull();
      }
    });

    it('lets a reply quote one of the student’s own lines exactly', () => {
      expect(findCodeLeak('Look at `nSum = nSum + i;` inside your loop.', CODE)).toBeNull();
      expect(findCodeLeak('Your loop starts with `for (int i = 0; i < n; i++)`.', CODE)).toBeNull();
      expect(findCodeLeak('This line runs every time:\nnSum = nSum + i;', CODE)).toBeNull();
      // Quoted, but not what they wrote.
      expect(findCodeLeak('Change it to `nSum = nSum + 2 * i;`.', CODE)).not.toBeNull();
    });

    it('asks again when a reply writes C, naming it, at either level', async () => {
      for (const level of ['hint', 'prompt'] as const) {
        const { provider, users } = scriptedCode('Write nSum = 0;', 'Where does nSum get its first value?');
        const result = await ask(provider, {
          code: CODE,
          level,
          fixed: level === 'prompt' ? { situation: 'departs_from_plan', focus: 'the loop' } : undefined
        });

        expect(users, level).toHaveLength(2);
        expect(users[1].slice(users[0].length), level).toContain('C code');
        expect(result, level).toMatchObject({
          nudge: 'Where does nSum get its first value?',
          leaks: ['C code: a line ending in a semicolon'],
          leak_blocked: false
        });
      }
    });

    it('gives no reply text when both replies write C, keeping the summary and the focus', async () => {
      const { provider } = scriptedCode('Write nSum = 0;', 'Use printf("%d", nSum).');
      const result = await ask(provider, { code: CODE });

      expect(result).toMatchObject({ nudge: '', leak_blocked: true, summary: REPLY.summary, focus: REPLY.focus });
      expect(result.leaks).toHaveLength(2);
    });

    it('does not ask again for a reply that quotes the student’s own line', async () => {
      const { provider, users } = scriptedCode('Look at `nSum = nSum + i;`: which value does it add?');
      const result = await ask(provider, { code: CODE });
      expect(users).toHaveLength(1);
      expect(result.leaks).toEqual([]);
    });
  });
});
