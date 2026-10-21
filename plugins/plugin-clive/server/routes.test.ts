/**
 * The plugin's routes, driven through the same Fastify app the app mounts, with
 * the provider, the problem loader and the session log's database calls mocked
 * so no network or database is touched. Mirrors
 * `src/lib/plugins/healthcheck/healthcheckPlugin.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerAnimoRankAPI } from '$lib/api/server';
import { Server } from '$lib/server';
import { PLUGIN_API_USER_HEADER } from '$lib/server/serverAPI';
import CLiveServerPlugin from '../server';
import { JudgeError } from './content/errors';
import type { SessionLogEntry } from './sessionLog';

const state = vi.hoisted(() => ({ queue: [] as unknown[], calls: 0 }));
const log = vi.hoisted(() => ({
  owns: true,
  fail: false,
  written: [] as SessionLogEntry[],
  check: true,
  checked: [] as string[]
}));

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
    judgeJson: async () => {
      state.calls += 1;
      const next = state.queue.shift();
      if (next instanceof Error) throw next;
      return { parsed: next ?? {}, model: 'fake-model', inputTokens: 0, outputTokens: 0 };
    }
  })
}));

// No executor in tests: the stuck route's public-case run fails, which it is built to survive.
vi.mock('./publicTests', () => ({
  publicTestRun: async () => {
    throw new Error('no executor in tests');
  }
}));

vi.mock('./sessionLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionLog')>();
  return {
    ...actual,
    ownsPracticeSession: async () => log.owns,
    writeSessionLog: async (_sessionId: string, entries: SessionLogEntry[]) => {
      if (log.fail) throw new Error('database down');
      log.written.push(...entries);
    },
    checkSessionLog: async (sessionId: string) => {
      log.checked.push(sessionId);
      return { ok: log.check, file: sessionId, error: log.check ? '' : 'database down' };
    }
  };
});

const SESSION = '123e4567-e89b-42d3-a456-426614174000';

const CASE_VERDICTS = [
  { criterion_id: 'case_is_concrete', verdict: 'PASS', evidence: '4 6', confidence: 'high' },
  { criterion_id: 'work_is_shown', verdict: 'PASS', evidence: '4 * 6 = 24.', confidence: 'high' },
  { criterion_id: 'outputs_are_correct', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'output_format_matches_statement', verdict: 'PASS', evidence: '', confidence: 'high' }
];

const IMPLEMENT_VERDICTS = [
  { criterion_id: 'follows_own_design', verdict: 'FAIL', evidence: '', confidence: 'low' },
  { criterion_id: 'state_matches_design', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'handles_own_edge_cases', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'readable', verdict: 'PASS', evidence: '', confidence: 'high' }
];

const NUDGE = {
  summary: 'One thing first.',
  focus_id: 'case_is_concrete',
  reason: 'It is upstream.',
  nudge: 'Real values?'
};

/** The registrations are process-wide, so the entry runs once per process. */
let installed: Promise<void> | undefined;
function install(): Promise<void> {
  return (installed ??= new CLiveServerPlugin().init(new ServerAnimoRankAPI('clive')));
}

async function app() {
  await install();
  return new Server().prepareApp();
}

/** POST as the bridge would deliver it: from `user-1`, or from nobody when `userId` is null. */
async function post(path: string, payload: unknown, userId: string | null = 'user-1') {
  const instance = await app();
  return instance.inject({
    method: 'POST',
    url: `/plugin-api/clive${path}`,
    payload: payload as Record<string, unknown>,
    headers: userId ? { [PLUGIN_API_USER_HEADER]: userId } : {}
  });
}

const casesBody = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  phase: 'case_design',
  problemId: 'p',
  artifact: { normal_cases: [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }], edge_cases: [] },
  attempt: 1,
  priorArtifacts: [],
  step: 'normal_cases',
  ...overrides
});

const stuckBody = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  phase: 'case_design',
  problemId: 'p',
  artifact: { normal_cases: [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }] },
  attempt: 1,
  priorArtifacts: [],
  statement: 'I do not get the leftover.',
  fieldId: 'normal_cases',
  history: [{ statement: 'Is my input right?', feedback: 'Which value comes first?' }],
  ...overrides
});

/** The parts of a `CLIVE_SUBMIT` record these tests read. */
type SubmitRecord = Record<string, unknown> & {
  reference_check: unknown;
  response: {
    passed: boolean;
    verdicts: { criterion_id: string; evidence: string; evidence_found: boolean | null; confidence: string | null }[];
    nudge?: { focus_id: string };
  };
};

const types = () => log.written.map((e) => e.type);
const entry = (type: string) => log.written.find((e) => e.type === type)!;

describe('CLive plugin routes', () => {
  beforeEach(() => {
    state.queue = [];
    state.calls = 0;
    log.owns = true;
    log.fail = false;
    log.written = [];
    log.check = true;
    log.checked = [];
  });

  it('answers /boot', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/plugin-api/clive/boot' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.hasApiKey).toBe(true);
    // The live-diagnostics wording table rides along: the page words a squiggle
    // from it, and it needs it before the student types.
    expect(Object.keys(body.live_check).sort()).toEqual(['available', 'fallback', 'table']);
    expect(body.live_check.fallback).toBe('The compiler stopped here.');
    const unfinished = body.live_check.table.find((row: { kind: string }) => row.kind === 'unfinished_statement');
    expect(unfinished.codes).toContain('expected_semi_after_expr');
    expect(body.live_check.table.every((row: { codes: string[] }) => row.codes.length > 0)).toBe(true);
  });

  it('checks the session log for the practice session that owns it', async () => {
    const response = await post('/log-check', { sessionId: SESSION, problemId: 'p' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, file: SESSION, error: '' });
    expect(log.checked).toEqual([SESSION]);
  });

  it('reports a failed log check as an answer, not a failed request', async () => {
    log.check = false;
    const response = await post('/log-check', { sessionId: SESSION, problemId: 'p' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, file: SESSION, error: 'database down' });
  });

  it('refuses a log check into another student’s practice session', async () => {
    log.owns = false;
    const response = await post('/log-check', { sessionId: SESSION, problemId: 'p' });

    expect(response.statusCode).toBe(403);
    expect(log.checked).toEqual([]);
  });

  it('judges one Cases step and carries no nudge when nothing blocks', async () => {
    state.queue = [{ verdicts: CASE_VERDICTS }];
    const response = await post('/submit', casesBody());

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(true);
    expect(body.verdicts).toHaveLength(4);
    expect(body.nudge).toBeUndefined();
    expect(body.verdicts.map((v: { criterion_id: string }) => v.criterion_id)).toContain('outputs_are_correct');
    // Each verdict carries the line the student reads for that requirement.
    expect(body.verdicts.every((v: { not_met: string }) => v.not_met.length > 0)).toBe(true);
  });

  it('answers a blocking failure with a nudge in the same call', async () => {
    const failing = CASE_VERDICTS.map((v) => (v.criterion_id === 'case_is_concrete' ? { ...v, verdict: 'FAIL' } : v));
    state.queue = [{ verdicts: failing }, NUDGE];
    const response = await post('/submit', casesBody());

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(false);
    expect(body.nudge?.focus_id).toBe('case_is_concrete');
    expect(body.nudge?.focus_not_met).toBeTruthy();
    expect(body.nudge?.failing.map((f: { id: string }) => f.id)).toContain('case_is_concrete');
  });

  it('rejects a per-step submit with no step', async () => {
    const response = await post('/submit', casesBody({ step: undefined }));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/step is required/);
  });

  it('judges Implement from the submitted code, all advisory', async () => {
    state.queue = [{ verdicts: IMPLEMENT_VERDICTS }];
    const response = await post('/submit', {
      sessionId: SESSION,
      phase: 'implement',
      problemId: 'p',
      artifact: { code: 'stale' },
      code: 'int main(void) { return 0; }',
      attempt: 1,
      priorArtifacts: []
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(true);
    expect(body.verdicts).toHaveLength(4);
    expect(body.nudge).toBeUndefined();
    expect(body.advisory_unmet).toEqual(['follows_own_design']);
    // The record keeps the code that was judged, not the stale copy in the artifact.
    expect(entry('CLIVE_SUBMIT').data.artifact).toEqual({ code: 'int main(void) { return 0; }' });
  });

  it('answers a stuck ask with the feedback alone, keeping the diagnosis out of the response', async () => {
    state.queue = [
      { diagnosis: 'Does not connect “leftover” with a remainder.', feedback: 'How many fit?\nWhat is left over?' }
    ];
    const response = await post('/stuck', stuckBody());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ feedback: 'How many fit?\nWhat is left over?' });
    // The diagnosis names the answer often enough that the page must never receive it.
    expect(JSON.stringify(response.json())).not.toContain('remainder');
  });

  it('refuses a stuck ask with nothing asked', async () => {
    state.queue = [{ diagnosis: 'd', feedback: 'f' }];
    const response = await post('/stuck', stuckBody({ statement: '   ', fieldId: undefined, history: [] }));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Say what you are having trouble with first/);
  });

  it('turns a JudgeError into a 400 with its message', async () => {
    const response = await post('/submit', casesBody({ phase: 'nope' }));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Unknown CLive phase/);
  });

  it('refuses a submit from nobody signed in', async () => {
    state.queue = [{ verdicts: CASE_VERDICTS }];
    const response = await post('/submit', casesBody(), null);

    expect(response.statusCode).toBe(401);
    expect(state.calls).toBe(0);
    expect(log.written).toEqual([]);
  });

  it('refuses a submit or stuck ask into a practice session that is not yours', async () => {
    log.owns = false;
    state.queue = [{ verdicts: CASE_VERDICTS }];

    expect((await post('/submit', casesBody())).statusCode).toBe(403);
    expect((await post('/stuck', stuckBody())).statusCode).toBe(403);
    expect(state.calls).toBe(0);
    expect(log.written).toEqual([]);
  });

  it('writes the judge call and the full submission record', async () => {
    state.queue = [{ verdicts: CASE_VERDICTS }];
    const response = await post('/submit', casesBody());

    expect(types()).toEqual(['CLIVE_LLM_CALL', 'CLIVE_SUBMIT']);
    expect(entry('CLIVE_LLM_CALL').data).toMatchObject({
      during: 'submit',
      seq: 1,
      purpose: 'judge',
      provider: 'fake',
      error: null,
      checks: { missing_ids: [], unexpected_ids: [], evidence_not_found: [] }
    });
    const record = entry('CLIVE_SUBMIT').data as SubmitRecord;
    expect(record).toMatchObject({
      phase_id: 'case_design',
      problem_id: 'p',
      attempt: 1,
      step: 'normal_cases',
      artifact: casesBody().artifact
    });
    expect(record.reference_check).toHaveProperty('status');
    expect(record.response.passed).toBe(true);
    const shown = record.response.verdicts.find((v) => v.criterion_id === 'work_is_shown');
    expect(shown).toMatchObject({ evidence: '4 * 6 = 24.', evidence_found: true, confidence: 'high' });
    // The page gets the verdicts without the judge's evidence.
    expect(JSON.stringify(response.json())).not.toContain('evidence');
  });

  it('writes the nudge call after the judge call when a gating criterion fails', async () => {
    const failing = CASE_VERDICTS.map((v) => (v.criterion_id === 'case_is_concrete' ? { ...v, verdict: 'FAIL' } : v));
    state.queue = [{ verdicts: failing }, NUDGE];
    await post('/submit', casesBody());

    expect(types()).toEqual(['CLIVE_LLM_CALL', 'CLIVE_LLM_CALL', 'CLIVE_SUBMIT']);
    expect(log.written.slice(0, 2).map((e) => [e.data.purpose, e.data.seq])).toEqual([
      ['judge', 1],
      ['nudge', 2]
    ]);
    expect((entry('CLIVE_SUBMIT').data as SubmitRecord).response.nudge?.focus_id).toBe('case_is_concrete');
  });

  it('writes the stuck record with the diagnosis', async () => {
    state.queue = [{ diagnosis: 'Does not connect “leftover” with a remainder.', feedback: 'How many fit?' }];
    await post('/stuck', stuckBody());

    expect(types()).toEqual(['CLIVE_LLM_CALL', 'CLIVE_STUCK']);
    expect(entry('CLIVE_LLM_CALL').data).toMatchObject({ during: 'stuck', purpose: 'stuck' });
    expect(entry('CLIVE_STUCK').data).toMatchObject({
      phase_id: 'case_design',
      problem_id: 'p',
      attempt: 1,
      field_id: 'normal_cases',
      statement: 'I do not get the leftover.',
      history: stuckBody().history,
      artifact: stuckBody().artifact,
      diagnosis: 'Does not connect “leftover” with a remainder.',
      response: { feedback: 'How many fit?' }
    });
  });

  it('shows the stuck model the program from the editor in Implement, and records it', async () => {
    state.queue = [
      { diagnosis: 'Has not met the remainder operator.', feedback: 'Which operator gives the leftover?' }
    ];
    const code = 'int main(void) { int n; scanf("%d", &n); return 0; }';
    await post('/stuck', stuckBody({ phase: 'implement', fieldId: 'code', artifact: { code: '' }, code, history: [] }));

    // The artifact's own copy of the code is stale; the editor's is what the student has written.
    expect(entry('CLIVE_LLM_CALL').data.user).toContain(code);
    expect(entry('CLIVE_STUCK').data.artifact).toEqual({ code });
  });

  it('writes the failed call and an error record when the judge fails', async () => {
    state.queue = [new JudgeError('Response hit max_tokens.', { raw: '{"ver', reasoning: 'Let me' })];
    const response = await post('/submit', casesBody());

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Response hit max_tokens.');
    expect(types()).toEqual(['CLIVE_LLM_CALL', 'CLIVE_ERROR']);
    expect(entry('CLIVE_LLM_CALL').data).toMatchObject({
      purpose: 'judge',
      error: 'Response hit max_tokens.',
      raw_text: '{"ver',
      reasoning: 'Let me'
    });
    expect(entry('CLIVE_ERROR').data).toMatchObject({
      call: 'submit',
      phase_id: 'case_design',
      step: 'normal_cases',
      attempt: 1,
      error: 'Response hit max_tokens.'
    });
  });

  it('still answers when the session log cannot be written', async () => {
    log.fail = true;
    state.queue = [{ verdicts: CASE_VERDICTS }];
    const response = await post('/submit', casesBody());

    expect(response.statusCode).toBe(200);
    expect(response.json().passed).toBe(true);
  });
});
