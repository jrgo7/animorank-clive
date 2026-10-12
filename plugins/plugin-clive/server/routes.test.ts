/**
 * The plugin's routes, driven through the same Fastify app the app mounts, with
 * the provider and the problem loader mocked so no network or database is
 * touched. Mirrors `src/lib/plugins/healthcheck/healthcheckPlugin.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerAnimoRankAPI } from '$lib/api/server';
import { Server } from '$lib/server';
import CLiveServerPlugin from '../server';

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock('./problem', () => ({
  loadCLiveProblem: async () => ({
    slug: 'fixture',
    title: 'Fixture',
    statement: 'Read two numbers and print their product.',
    starter_code: '',
    public_test_cases: [{ input: '4 6', output: '24' }],
    reference_solution: ''
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
      parsed: state.queue.shift() ?? {},
      model: 'fake-model',
      inputTokens: 0,
      outputTokens: 0
    })
  })
}));

const CASE_VERDICTS = [
  { criterion_id: 'case_is_concrete', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'work_is_shown', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'outputs_are_correct', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'output_format_matches_statement', verdict: 'PASS', evidence: '', confidence: 'high' }
];

const IMPLEMENT_VERDICTS = [
  { criterion_id: 'follows_own_design', verdict: 'FAIL', evidence: '', confidence: 'low' },
  { criterion_id: 'state_matches_design', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'handles_own_edge_cases', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'readable', verdict: 'PASS', evidence: '', confidence: 'high' }
];

/** The registrations are process-wide, so the entry runs once per process. */
let installed: Promise<void> | undefined;
function install(): Promise<void> {
  return (installed ??= new CLiveServerPlugin().init(new ServerAnimoRankAPI('clive')));
}

async function app() {
  await install();
  return new Server().prepareApp();
}

const casesBody = (overrides: Record<string, unknown> = {}) => ({
  phase: 'case_design',
  problemId: 'p',
  artifact: { normal_cases: [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }], edge_cases: [] },
  attempt: 1,
  priorArtifacts: [],
  step: 'normal_cases',
  ...overrides
});

describe('CLive plugin routes', () => {
  beforeEach(() => {
    state.queue = [];
  });

  it('answers /boot', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/plugin-api/clive/boot' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hasApiKey: true });
  });

  it('judges one Cases step and carries no nudge when nothing blocks', async () => {
    state.queue = [{ verdicts: CASE_VERDICTS }];
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/plugin-api/clive/submit', payload: casesBody() });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(true);
    expect(body.verdicts).toHaveLength(4);
    expect(body.nudge).toBeUndefined();
    expect(body.verdicts.map((v: { criterion_id: string }) => v.criterion_id)).toContain('outputs_are_correct');
  });

  it('answers a blocking failure with a nudge in the same call', async () => {
    const failing = CASE_VERDICTS.map((v) => (v.criterion_id === 'case_is_concrete' ? { ...v, verdict: 'FAIL' } : v));
    state.queue = [
      { verdicts: failing },
      {
        summary: 'One thing first.',
        focus_id: 'case_is_concrete',
        reason: 'It is upstream.',
        nudge: 'Give real values.'
      }
    ];
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/plugin-api/clive/submit', payload: casesBody() });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(false);
    expect(body.nudge?.focus_id).toBe('case_is_concrete');
    expect(body.nudge?.failing.map((f: { id: string }) => f.id)).toContain('case_is_concrete');
  });

  it('rejects a per-step submit with no step', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/plugin-api/clive/submit',
      payload: casesBody({ step: undefined })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/step is required/);
  });

  it('judges Implement from the submitted code, all advisory', async () => {
    state.queue = [{ verdicts: IMPLEMENT_VERDICTS }];
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/plugin-api/clive/submit',
      payload: {
        phase: 'implement',
        problemId: 'p',
        artifact: { code: 'stale' },
        code: 'int main(void) { return 0; }',
        attempt: 1,
        priorArtifacts: []
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(true);
    expect(body.verdicts).toHaveLength(4);
    expect(body.nudge).toBeUndefined();
    expect(body.advisory_unmet).toEqual(['follows_own_design']);
  });

  it('returns one hint', async () => {
    state.queue = [{ criterion_id: 'input_order_stated', diagnosis: 'You list inputs.', hint: 'Say which is first.' }];
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/plugin-api/clive/hint',
      payload: {
        phase: 'problem_definition',
        problemId: 'p',
        artifact: { summary: 'x', inputs: 'y', outputs: 'z' },
        attempt: 1,
        priorArtifacts: [],
        history: []
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ criterion_id: 'input_order_stated' });
  });

  it('turns a JudgeError into a 400 with its message', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/plugin-api/clive/submit',
      payload: casesBody({ phase: 'nope' })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Unknown CLive phase/);
  });
});
