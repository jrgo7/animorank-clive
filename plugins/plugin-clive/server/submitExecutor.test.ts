/**
 * `submit` called directly, as a script does, with an executor of the caller's
 * choosing: the reference check must run on that executor, not look for the
 * platform's own.
 */
import { expect, it, vi } from 'vitest';
import type { CodeExecutor } from '$lib/executor';
import { submit } from './routes';

vi.mock('./problem', () => ({
  loadCLiveProblem: async () => ({
    slug: 'fixture',
    title: 'Fixture',
    statement: 'Read two numbers and print their product.',
    starter_code: '',
    public_test_cases: [{ input: '4 6', output: '24' }],
    reference_solution: 'int main(void) { return 0; }',
    functions: []
  })
}));

vi.mock('./providers', () => ({
  getProvider: () => ({
    name: 'fake',
    defaultModel: 'fake-model',
    apiKeyEnv: 'UNUSED',
    modelPrefixes: ['fake-'],
    ownsModel: () => true,
    hasApiKey: () => true,
    judgeJson: async () => ({
      parsed: {
        verdicts: ['case_is_concrete', 'work_is_shown', 'output_format_matches_statement'].map((criterion_id) => ({
          criterion_id,
          verdict: 'PASS',
          evidence: '',
          confidence: 'high'
        }))
      },
      model: 'fake-model',
      inputTokens: 0,
      outputTokens: 0
    })
  })
}));

it('submit runs the reference check on the executor it is handed', async () => {
  const execute = vi.fn(async () => ({
    processOutputs: [
      { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') },
      { exitCode: 0, stdout: Buffer.from('35'), stderr: Buffer.from('') }
    ]
  }));
  const { response, record } = await submit(
    {
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      phase: 'case_design',
      problemId: 'p',
      step: 'normal_cases',
      artifact: { normal_cases: [{ input: '5 7', output: '35', working: '5 * 7 = 35.' }] },
      attempt: 1,
      priorArtifacts: [],
      history: []
    },
    { execute } as unknown as CodeExecutor
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect((record.reference_check as { status: string }).status).toBe('checked');
  expect(response.passed).toBe(true);
});
