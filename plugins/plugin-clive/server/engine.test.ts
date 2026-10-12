/**
 * The engine's behavior, with a fake provider and a fake executor — no network,
 * no Judge0. Ported contract-by-contract from the prototype's `judge.py`,
 * `nudge.py`, `hint.py`, `reference_check.py` and `steps.py`.
 */
import { describe, expect, it } from 'vitest';
import { CodeExecutor } from '$lib/executor';
import type { ExecutionRequest, ExecutionResult } from '$lib/executor/types';
import { phaseDoc, rubricDoc } from './content/load';
import { JudgeError } from './content/errors';
import { hint } from './hint';
import { judge } from './judge';
import { nudge } from './nudge';
import type { Provider } from './providers';
import { check, judgeWithChecks, outputsMatch } from './referenceCheck';
import { cut, isPerStep } from './steps';
import type { ProblemForPrompt } from './content/templates';

const PROBLEM: ProblemForPrompt = {
  slug: 'fixture',
  title: 'Fixture',
  statement: 'Read two numbers and print their product.',
  public_test_cases: [{ input: '4 6', output: '24' }],
  starter_code: '',
  reference_solution: ''
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

  it('rejects when nothing is blocking', async () => {
    const passing = verdicts.map((v) => ({ ...v, verdict: 'PASS' as const }));
    await expect(nudge(phase, PROBLEM, CASES_ARTIFACT, criteria, passing, 1, [], [], fakeProvider({}))).rejects.toThrow(
      /Nothing is blocking/
    );
  });
});

describe('hint', () => {
  const phase = phaseDoc('problem_definition');
  const criteria = rubricDoc('problem_definition').criteria;

  it('points at an advisory criterion and returns its text', async () => {
    const provider = fakeProvider({ criterion_id: 'input_order_stated', diagnosis: 'd', hint: 'h' });
    const result = await hint(phase, PROBLEM, {}, criteria, 1, [], [], provider);
    expect(result.criterion_text).toBe(criteria.find((c) => c.id === 'input_order_stated')?.text);
  });

  it('rejects a criterion id that is not advisory', async () => {
    const provider = fakeProvider({ criterion_id: 'novel_wording', diagnosis: 'd', hint: 'h' });
    await expect(hint(phase, PROBLEM, {}, criteria, 1, [], [], provider)).rejects.toThrow(/was not offered/);
  });

  it('rejects a phase with no advisory criteria', async () => {
    const gatingOnly = criteria.filter((c) => c.gate === 'gating');
    await expect(hint(phase, PROBLEM, {}, gatingOnly, 1, [], [], fakeProvider({}))).rejects.toThrow(
      /no advisory criteria/
    );
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
