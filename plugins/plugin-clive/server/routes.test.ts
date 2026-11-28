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
import { rubricDoc } from './content/load';
import { toResponseVerdicts } from './routes';
import type { SessionLogEntry } from './sessionLog';

const state = vi.hoisted(() => ({ queue: [] as unknown[], calls: 0, users: [] as string[] }));
const log = vi.hoisted(() => ({
  owns: true,
  fail: false,
  written: [] as SessionLogEntry[],
  check: true,
  checked: [] as string[],
  writtenTo: [] as string[],
  tagged: [] as { sessionId: string; participant: string }[],
  started: [] as { userId: string; problemId: string }[],
  lookups: [] as { sessionId: string; phaseId: string; step: string | null }[],
  /** Whether reading the escalations back fails, as a database that is down would. */
  escalationsUnreadable: false
}));

vi.mock('./problem', () => ({
  loadCLiveProblem: async () => ({
    slug: 'fixture',
    title: 'Fixture',
    statement: 'Read two numbers and print their product.',
    starter_code: '',
    public_test_cases: [{ input: '4 6', output: '24' }],
    reference_solution: '',
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
    judgeJson: async (options: { user: string }) => {
      state.calls += 1;
      state.users.push(options.user);
      const next = state.queue.shift();
      if (next instanceof Error) throw next;
      return { parsed: next ?? {}, model: 'fake-model', inputTokens: 0, outputTokens: 0 };
    }
  })
}));

vi.mock('./sessionLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionLog')>();
  return {
    ...actual,
    ownsPracticeSession: async () => log.owns,
    ownsAnyPracticeSession: async () => log.owns,
    writeSessionLog: async (sessionId: string, entries: SessionLogEntry[]) => {
      if (log.fail) throw new Error('database down');
      log.writtenTo.push(sessionId);
      log.written.push(...entries);
    },
    // The newest CLIVE_SUBMIT this fake history holds for the phase and step: what the real
    // reader finds in the practice session's history.
    latestSubmitRecord: async (sessionId: string, phaseId: string, step: string | null) => {
      log.lookups.push({ sessionId, phaseId, step });
      const found = log.written.findLast(
        (e) => e.type === 'CLIVE_SUBMIT' && e.data.phase_id === phaseId && (e.data.step ?? null) === step
      );
      return found ? found.data : null;
    },
    // Whether this fake history holds an escalation of the newest submit for the phase and
    // step: a CLIVE_ESCALATE on the same attempt, written after it.
    submissionEscalated: async (sessionId: string, phaseId: string, step: string | null, attempt: number) => {
      if (log.escalationsUnreadable) throw new Error('database down');
      for (const e of [...log.written].reverse()) {
        if (e.data.phase_id !== phaseId || (e.data.step ?? null) !== step) continue;
        if (e.type === 'CLIVE_SUBMIT') return false;
        if (e.type === 'CLIVE_ESCALATE' && e.data.attempt === attempt) return true;
      }
      return false;
    },
    // The newest CLIVE_CODE_FEEDBACK this fake history holds, with whether an Implement
    // escalation of it, or a Run or Submit that passed every test, came after it.
    latestCodeFeedbackRecord: async () => {
      const at = log.written.findLastIndex((e) => e.type === 'CLIVE_CODE_FEEDBACK');
      if (at < 0) return null;
      const record = log.written[at].data;
      const after = log.written.slice(at + 1);
      return {
        record,
        escalated: after.some(
          (e) => e.type === 'CLIVE_ESCALATE' && e.data.phase_id === 'implement' && e.data.attempt === record.attempt
        ),
        passedSince: after.some(
          (e) => e.type === 'RUN_ATTEMPT' && (e.data.generalTestResults as boolean[]).every(Boolean)
        )
      };
    },
    tagParticipant: async (sessionId: string, participant: string) => {
      log.tagged.push({ sessionId, participant });
    },
    startNextSession: async (userId: string, problemId: string) => {
      log.started.push({ userId, problemId });
      return NEXT_SESSION;
    },
    checkSessionLog: async (sessionId: string) => {
      log.checked.push(sessionId);
      return { ok: log.check, file: sessionId, error: log.check ? '' : 'database down' };
    }
  };
});

const SESSION = '123e4567-e89b-42d3-a456-426614174000';
const NEXT_SESSION = '223e4567-e89b-42d3-a456-426614174000';

const CASE_VERDICTS = [
  { criterion_id: 'case_is_concrete', verdict: 'PASS', evidence: '4 6', confidence: 'high' },
  { criterion_id: 'work_is_shown', verdict: 'PASS', evidence: '4 * 6 = 24.', confidence: 'high' },
  { criterion_id: 'outputs_are_correct', verdict: 'PASS', evidence: '', confidence: 'high' }
];

/** Case 2 is judged on one more point than Case 1: whether it works out differently. */
const CASE_2_VERDICTS = [
  ...CASE_VERDICTS,
  { criterion_id: 'worked_out_differently', verdict: 'PASS', evidence: '', confidence: 'high' }
];

const PROBLEM_VERDICTS = [
  { criterion_id: 'summary_is_correct', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'novel_wording', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'input_types', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'output_types', verdict: 'PASS', evidence: '', confidence: 'high' },
  { criterion_id: 'constraints_noted', verdict: 'FAIL', evidence: '', confidence: 'high' }
];

/** A nudge reply (v9): the model writes the lines and its reason, and picks nothing. */
const NUDGE = { reason: 'Describes the input instead of giving one.', nudge: 'What would you actually type in?' };
const PROMPT = { reason: 'Still no values.', nudge: 'Which two numbers would you give it?' };

/** Case 1 failing on one requirement, as the judge answers it. */
const failingOn = (...ids: string[]) =>
  CASE_VERDICTS.map((v) => (ids.includes(v.criterion_id) ? { ...v, verdict: 'FAIL' } : v));

/** One turn of the history the page sends back. */
const turn = (attempt: number, focus_id: string, level: 'hint' | 'prompt', nudge = `nudge-${attempt}`) => ({
  attempt,
  level,
  focus_id,
  nudge
});

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

/** An escalation as the page sends it: no verdicts, no artifact — the server reads its own record. */
const escalateBody = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  phase: 'case_design',
  problemId: 'p',
  step: 'normal_cases',
  attempt: 2,
  priorArtifacts: [],
  history: [turn(1, 'case_is_concrete', 'hint', NUDGE.nudge)],
  ...overrides
});

/** The parts of a `CLIVE_SUBMIT` record these tests read. */
type SubmitRecord = Record<string, unknown> & {
  reference_check: unknown;
  response: {
    passed: boolean;
    verdicts: { criterion_id: string; evidence: string; evidence_found: boolean | null; confidence: string | null }[];
    nudge?: { focus_id: string; level: string; reason: string };
  };
};

const types = () => log.written.map((e) => e.type);
const entry = (type: string) => log.written.find((e) => e.type === type)!;

describe('CLive plugin routes', () => {
  beforeEach(() => {
    state.queue = [];
    state.calls = 0;
    state.users = [];
    log.owns = true;
    log.fail = false;
    log.written = [];
    log.check = true;
    log.checked = [];
    log.writtenTo = [];
    log.tagged = [];
    log.started = [];
    log.lookups = [];
    log.escalationsUnreadable = false;
  });

  it('tags the practice session with a participant, and logs it', async () => {
    const res = await post('/participant', { sessionId: SESSION, problemId: 'p', participant: ' P07 ', next: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: SESSION });
    expect(log.tagged).toEqual([{ sessionId: SESSION, participant: 'P07' }]);
    expect(log.started).toEqual([]);
    expect(log.writtenTo).toEqual([SESSION]);
    expect(log.written.map((e) => [e.type, e.data])).toEqual([['CLIVE_PARTICIPANT', { participant: 'P07' }]]);
  });

  it('starts a fresh session for the next participant, tagged, leaving this one as it is', async () => {
    const res = await post('/participant', { sessionId: SESSION, problemId: 'p', participant: 'P08', next: true });
    expect(res.json()).toEqual({ sessionId: NEXT_SESSION });
    expect(log.started).toEqual([{ userId: 'user-1', problemId: 'p' }]);
    expect(log.tagged).toEqual([{ sessionId: NEXT_SESSION, participant: 'P08' }]);
    expect(log.writtenTo).toEqual([NEXT_SESSION]);
    expect(log.written[0].data).toEqual({ participant: 'P08', previous_session: SESSION });
  });

  it('refuses a participant tag on a practice session that is not yours', async () => {
    log.owns = false;
    const res = await post('/participant', { sessionId: SESSION, problemId: 'p', participant: 'P07', next: true });
    expect(res.statusCode).toBe(403);
    expect(log.tagged).toEqual([]);
    expect(log.started).toEqual([]);
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
    expect(body.verdicts).toHaveLength(3);
    expect(body.nudge).toBeUndefined();
    expect(body.verdicts.map((v: { criterion_id: string }) => v.criterion_id)).toContain('outputs_are_correct');
    // Each verdict carries the line the student reads for that requirement.
    expect(body.verdicts.every((v: { not_met: string }) => v.not_met.length > 0)).toBe(true);
    // Case 1 has nothing to be compared with.
    expect(state.users[0]).not.toMatch(/^YOUR CASE 1$/m);
  });

  it('shows the judge the student’s Case 1 when Case 2 is submitted', async () => {
    state.queue = [{ verdicts: CASE_2_VERDICTS }];
    const response = await post(
      '/submit',
      casesBody({
        step: 'edge_cases',
        artifact: {
          normal_cases: [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }],
          edge_cases: [{ input: '1 1', output: '1', working: '1 * 1 = 1.' }]
        }
      })
    );

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.verdicts.map((v: { criterion_id: string }) => v.criterion_id)).toContain('worked_out_differently');
    expect(state.users[0]).toMatch(/^YOUR CASE 1$/m);
    expect(state.users[0]).toContain('- Input: 4 6\n- Expected output: 24\n- How I got it: 4 * 6 = 24.');
    // The case judged is still Case 2 alone.
    const judged = state.users[0].slice(state.users[0].indexOf('STUDENT ARTIFACT'));
    expect(judged).toContain('Input: 1 1');
    expect(judged).not.toContain('Input: 4 6');
  });

  it('answers a blocking failure with a hint in the same call', async () => {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    const response = await post('/submit', casesBody());

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(false);
    expect(body.nudge).toMatchObject({ level: 'hint', focus_id: 'case_is_concrete', nudge: NUDGE.nudge });
    expect(body.nudge?.focus_not_met).toBeTruthy();
    expect(body.nudge?.failing.map((f: { id: string }) => f.id)).toContain('case_is_concrete');
    // The old situation and summary are gone; the reason is for the record, not the page.
    expect(body.nudge).not.toHaveProperty('situation');
    expect(body.nudge).not.toHaveProperty('summary');
    expect(body.nudge).not.toHaveProperty('reason');
  });

  it('nudges the first failing requirement in rubric order, and shows the model that one alone', async () => {
    // The judge's own order puts work_is_shown first; the rubric puts case_is_concrete first.
    const verdicts = failingOn('case_is_concrete', 'work_is_shown');
    state.queue = [{ verdicts: [verdicts[1], verdicts[0], verdicts[2]] }, NUDGE];
    const body = (await post('/submit', casesBody())).json();

    expect(body.nudge.focus_id).toBe('case_is_concrete');
    expect(body.nudge.failing.map((f: { id: string }) => f.id)).toEqual(['case_is_concrete', 'work_is_shown']);
    expect(state.users[1]).toContain('[case_is_concrete]');
    expect(state.users[1]).not.toContain('[work_is_shown]');
    expect(state.users[1]).toContain('LEVEL\nhint');
  });

  it('answers a failed submit after an escalation with a hint, and shows the model the earlier prompt', async () => {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    const history = [
      turn(1, 'case_is_concrete', 'hint', 'the first hint'),
      turn(1, 'case_is_concrete', 'prompt', 'the prompt asked for')
    ];
    const body = (await post('/submit', casesBody({ attempt: 2, history }))).json();

    expect(body.nudge.level).toBe('hint');
    expect(state.users[1]).toContain('LEVEL\nhint');
    // So the new hint does not repeat what the prompt already said.
    expect(state.users[1]).toContain('- attempt 1, prompt: the prompt asked for');
    expect(state.users[1]).toContain('- attempt 1, hint: the first hint');
  });

  it('shows the model the last five earlier turns on the focus only', async () => {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    const history = [
      turn(1, 'case_is_concrete', 'prompt'),
      ...[2, 3, 4, 5, 6, 7].map((n) => turn(n, 'case_is_concrete', 'hint'))
    ];
    await post('/submit', casesBody({ attempt: 8, history }));

    expect(state.users[1]).toContain('- attempt 3, hint: nudge-3');
    expect(state.users[1]).toContain('- attempt 7, hint: nudge-7');
    expect(state.users[1]).not.toContain('nudge-2');
    expect(state.users[1]).not.toContain('nudge-1');
  });

  it('shows the model only the earlier turns on its own requirement, and starts a new focus at a hint', async () => {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    const history = [turn(1, 'work_is_shown', 'prompt', 'about the working'), turn(2, 'case_is_concrete', 'hint')];
    const body = (await post('/submit', casesBody({ attempt: 3, history }))).json();

    expect(body.nudge.level).toBe('hint');
    expect(state.users[1]).toContain('- attempt 2, hint: nudge-2');
    expect(state.users[1]).not.toContain('about the working');
  });

  it('reads the turns a session saved before the ladder: no level is a hint, and a situation is ignored', async () => {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    const history = [{ attempt: 1, situation: 'not_a_case', focus_id: 'case_is_concrete', nudge: 'Real values?' }];
    const response = await post('/submit', casesBody({ attempt: 2, history }));

    expect(response.statusCode).toBe(200);
    expect(response.json().nudge.level).toBe('hint');
    expect(state.users[1]).toContain('- attempt 1, hint: Real values?');
    expect(state.users[1]).not.toContain('not_a_case');
  });

  it('keeps the reason in the record', async () => {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    await post('/submit', casesBody());

    const record = entry('CLIVE_SUBMIT').data as SubmitRecord;
    expect(record.response.nudge).toMatchObject({
      level: 'hint',
      focus_id: 'case_is_concrete',
      reason: NUDGE.reason
    });
  });

  it('tags each verdict, and the nudge, with the questions they are about', async () => {
    state.queue = [{ verdicts: PROBLEM_VERDICTS }, NUDGE];
    const response = await post('/submit', {
      sessionId: SESSION,
      phase: 'problem_definition',
      problemId: 'p',
      artifact: { summary: 'Multiply two numbers.', inputs: 'Two ints.', outputs: 'Their product.' },
      attempt: 1,
      priorArtifacts: []
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const constraints = body.verdicts.find((v: { criterion_id: string }) => v.criterion_id === 'constraints_noted');
    expect(constraints.fields).toEqual(['inputs']);
    // The page opens on the question the nudge is about, and words it from the requirement.
    expect(body.nudge?.focus_fields).toEqual(['inputs']);
    expect(body.nudge?.focus_text).toBe(constraints.criterion_text);
  });

  it('names the cases whose input breaks the rules, on a failed computed verdict only', () => {
    const criteria = rubricDoc('case_design').criteria;
    const computed = (verdict: 'PASS' | 'FAIL') =>
      toResponseVerdicts(
        [
          {
            criterion_id: 'outputs_are_correct',
            verdict,
            evidence: '',
            confidence: 'high',
            source: 'reference',
            wrong: [],
            outside_rules: ['Case 1']
          }
        ],
        criteria
      )[0];

    expect(computed('FAIL').outside_rules).toEqual(['Case 1']);
    expect(computed('PASS').outside_rules).toEqual([]);
  });

  it('rejects a per-step submit with no step', async () => {
    const response = await post('/submit', casesBody({ step: undefined }));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/step is required/);
  });

  it('refuses an Implement submit: the tests alone decide Implement', async () => {
    const response = await post('/submit', {
      sessionId: SESSION,
      phase: 'implement',
      problemId: 'p',
      artifact: { code: 'int main(void) { return 0; }' },
      attempt: 1,
      priorArtifacts: []
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(
      'Implement is not checked here: Run and Submit in the Code Editor window decide it.'
    );
    expect(state.calls).toBe(0);
    expect(log.written).toEqual([]);
  });

  /** A failed Case 1 submit on case_is_concrete, answered with a hint: what an escalation follows. */
  async function failedSubmit(): Promise<void> {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    expect((await post('/submit', casesBody())).statusCode).toBe(200);
  }

  it('escalates the last failed submit to a prompt on the same requirement', async () => {
    await failedSubmit();
    state.queue = [PROMPT];
    const response = await post('/escalate', escalateBody());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      level: 'prompt',
      focus_id: 'case_is_concrete',
      nudge: PROMPT.nudge,
      focus_fields: ['normal_cases'],
      failing: [{ id: 'case_is_concrete' }]
    });
    expect(response.json().focus_not_met).toBeTruthy();
    expect(response.json()).not.toHaveProperty('reason');
    expect(log.lookups).toEqual([{ sessionId: SESSION, phaseId: 'case_design', step: 'normal_cases' }]);
    expect(state.users[2]).toContain('LEVEL\nprompt');
    expect(state.users[2]).toContain(`- attempt 1, hint: ${NUDGE.nudge}`);
  });

  it('builds the escalation from the server’s own record, never from verdicts or work the page sends', async () => {
    await failedSubmit();
    state.queue = [PROMPT];
    const response = await post(
      '/escalate',
      escalateBody({
        verdicts: [{ criterion_id: 'work_is_shown', verdict: 'FAIL', evidence: 'CLIENT_EVIDENCE' }],
        artifact: { normal_cases: [{ input: 'CLIENT_INPUT', output: '1', working: '' }] }
      })
    );

    expect(response.json().focus_id).toBe('case_is_concrete');
    expect(state.users[2]).toContain('[case_is_concrete]');
    expect(state.users[2]).toContain('Input: 4 6');
    expect(state.users[2]).not.toContain('CLIENT_INPUT');
    expect(state.users[2]).not.toContain('CLIENT_EVIDENCE');
  });

  it('refuses to escalate a submit that passed', async () => {
    state.queue = [{ verdicts: CASE_VERDICTS }];
    await post('/submit', casesBody());
    const response = await post('/escalate', escalateBody({ history: [] }));

    expect(response.statusCode).toBe(409);
    expect(state.calls).toBe(1);
  });

  it('refuses a second escalation of the same submission', async () => {
    await failedSubmit();
    state.queue = [PROMPT];
    expect((await post('/escalate', escalateBody())).statusCode).toBe(200);

    const history = [
      turn(1, 'case_is_concrete', 'hint', NUDGE.nudge),
      turn(1, 'case_is_concrete', 'prompt', PROMPT.nudge)
    ];
    const again = await post('/escalate', escalateBody({ history }));

    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe(
      'You already have the more specific help for this submission. Change your work and submit again for a new hint.'
    );
    // The judge and the hint, then the one prompt: no second prompt was asked for.
    expect(state.calls).toBe(3);
  });

  it('escalates a later submission on the same requirement, even though an earlier one had a prompt', async () => {
    await failedSubmit();
    state.queue = [PROMPT];
    await post('/escalate', escalateBody());

    const history = [
      turn(1, 'case_is_concrete', 'hint', NUDGE.nudge),
      turn(1, 'case_is_concrete', 'prompt', PROMPT.nudge)
    ];
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    const resubmit = (await post('/submit', casesBody({ attempt: 2, history }))).json();
    expect(resubmit.nudge.level).toBe('hint');

    state.queue = [PROMPT];
    const response = await post(
      '/escalate',
      escalateBody({ attempt: 2, history: [...history, turn(2, 'case_is_concrete', 'hint', NUDGE.nudge)] })
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ level: 'prompt', focus_id: 'case_is_concrete' });
    expect(log.written.filter((e) => e.type === 'CLIVE_ESCALATE').map((e) => e.data.attempt)).toEqual([1, 2]);
  });

  it('reads the page’s history for an earlier escalation only when the server’s record cannot be read', async () => {
    await failedSubmit();
    log.escalationsUnreadable = true;
    const escalatedHere = [turn(1, 'case_is_concrete', 'hint'), turn(1, 'case_is_concrete', 'prompt')];
    expect((await post('/escalate', escalateBody({ history: escalatedHere }))).statusCode).toBe(409);

    state.queue = [PROMPT];
    expect((await post('/escalate', escalateBody())).statusCode).toBe(200);
  });

  it('refuses to escalate when nothing was submitted for that phase or step', async () => {
    await failedSubmit();
    const response = await post('/escalate', escalateBody({ step: 'edge_cases' }));

    expect(response.statusCode).toBe(409);
    expect(state.calls).toBe(2);
  });

  it('logs an escalation: its model call, then its record', async () => {
    await failedSubmit();
    log.written = log.written.filter((e) => e.type === 'CLIVE_SUBMIT');
    state.queue = [PROMPT];
    await post('/escalate', escalateBody());

    expect(types()).toEqual(['CLIVE_SUBMIT', 'CLIVE_LLM_CALL', 'CLIVE_ESCALATE']);
    expect(entry('CLIVE_LLM_CALL').data).toMatchObject({ during: 'escalate', seq: 1, purpose: 'nudge' });
    expect(entry('CLIVE_ESCALATE').data).toMatchObject({
      phase_id: 'case_design',
      problem_id: 'p',
      step: 'normal_cases',
      attempt: 1,
      level: 'prompt',
      focus_id: 'case_is_concrete',
      history: escalateBody().history,
      response: { level: 'prompt', nudge: PROMPT.nudge, reason: PROMPT.reason }
    });
  });

  it('logs a failed escalation as an error', async () => {
    await failedSubmit();
    state.queue = [new JudgeError('The model gave up.')];
    const response = await post('/escalate', escalateBody());

    expect(response.statusCode).toBe(400);
    expect(entry('CLIVE_ERROR').data).toMatchObject({
      call: 'escalate',
      phase_id: 'case_design',
      step: 'normal_cases'
    });
  });

  it('has no stuck route', async () => {
    const response = await post('/stuck', { sessionId: SESSION, phase: 'case_design', problemId: 'p' });
    expect(response.statusCode).toBe(404);
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

  it('refuses a submit or an escalation into a practice session that is not yours', async () => {
    log.owns = false;
    state.queue = [{ verdicts: CASE_VERDICTS }];

    expect((await post('/submit', casesBody())).statusCode).toBe(403);
    expect((await post('/escalate', escalateBody())).statusCode).toBe(403);
    expect(state.calls).toBe(0);
    expect(log.written).toEqual([]);
    expect(log.lookups).toEqual([]);
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
    // No Cases criterion is computed since criteria v15, so there is no reference check to keep.
    expect(record.reference_check).toBeNull();
    expect(record.response.passed).toBe(true);
    const shown = record.response.verdicts.find((v) => v.criterion_id === 'work_is_shown');
    expect(shown).toMatchObject({ evidence: '4 * 6 = 24.', evidence_found: true, confidence: 'high' });
    // The page gets the verdicts without the judge's evidence.
    expect(JSON.stringify(response.json())).not.toContain('evidence');
  });

  it('writes the nudge call after the judge call when a gating criterion fails', async () => {
    state.queue = [{ verdicts: failingOn('case_is_concrete') }, NUDGE];
    await post('/submit', casesBody());

    expect(types()).toEqual(['CLIVE_LLM_CALL', 'CLIVE_LLM_CALL', 'CLIVE_SUBMIT']);
    expect(log.written.slice(0, 2).map((e) => [e.data.purpose, e.data.seq])).toEqual([
      ['judge', 1],
      ['nudge', 2]
    ]);
    expect((entry('CLIVE_SUBMIT').data as SubmitRecord).response.nudge?.focus_id).toBe('case_is_concrete');
  });

  const codeBody = (overrides: Record<string, unknown> = {}) => ({
    sessionId: SESSION,
    problemId: 'p',
    code: 'int main(void) { return 0; }',
    runType: 'run',
    attempt: 1,
    priorArtifacts: [],
    history: [],
    run: {
      compiled: true,
      compilerOutput: '',
      cases: [{ input: '4 6', expected: '24', actual: '0', passed: false }],
      hiddenFailed: 0
    },
    ...overrides
  });
  const CODE_REPLY = {
    situation: 'departs_from_plan',
    summary: 'One fails.',
    focus: 'step 2',
    nudge: 'Look at step 2.'
  };

  it('answers failing Implement code with a hint: its situation and feedback', async () => {
    state.queue = [CODE_REPLY];
    const response = await post('/code-feedback', codeBody());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...CODE_REPLY, level: 'hint' });
    expect(state.users[0]).toContain('LEVEL\nhint');
  });

  it('writes the code-feedback call, then its record with the level', async () => {
    state.queue = [CODE_REPLY];
    await post('/code-feedback', codeBody());
    expect(types()).toEqual(['CLIVE_LLM_CALL', 'CLIVE_CODE_FEEDBACK']);
    expect(entry('CLIVE_LLM_CALL').data).toMatchObject({ during: 'code-feedback', purpose: 'nudge_code' });
    expect(entry('CLIVE_CODE_FEEDBACK').data).toMatchObject({
      problem_id: 'p',
      run_type: 'run',
      attempt: 1,
      level: 'hint',
      code: 'int main(void) { return 0; }',
      response: { ...CODE_REPLY, level: 'hint' }
    });
  });

  it('reads earlier replies saved without a level as hints', async () => {
    state.queue = [CODE_REPLY];
    const history = [{ situation: 'other', focus: 'the loop', nudge: 'Look at the loop.' }];
    expect((await post('/code-feedback', codeBody({ history }))).statusCode).toBe(200);
    expect(state.users[0]).toContain('- hint, [other] at the loop: Look at the loop.');
  });

  describe('"I\'m stuck" on code feedback', () => {
    /** What the page sends: no code and no results, which the server reads from its own record. */
    const codeEscalateBody = (overrides: Record<string, unknown> = {}) => ({
      sessionId: SESSION,
      problemId: 'p',
      priorArtifacts: [],
      history: [{ level: 'hint', situation: 'departs_from_plan', focus: 'step 2', nudge: 'Look at step 2.' }],
      ...overrides
    });
    const CODE_PROMPT = {
      situation: 'other',
      summary: 'Still one fails.',
      focus: 'somewhere else',
      nudge: 'Where does nSum get its first value?'
    };

    /** A failing run answered with a hint, as the server records it. */
    async function failedRun(attempt = 1): Promise<void> {
      state.queue = [CODE_REPLY];
      expect((await post('/code-feedback', codeBody({ attempt }))).statusCode).toBe(200);
    }

    it('answers with a prompt on the same situation and place, from the server’s own record', async () => {
      await failedRun();
      state.queue = [CODE_PROMPT];
      const response = await post(
        '/code-feedback/escalate',
        codeEscalateBody({
          code: 'CLIENT_CODE',
          run: { compiled: true, cases: [{ input: 'CLIENT_INPUT', expected: '1', actual: '0', passed: false }] }
        })
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        level: 'prompt',
        situation: 'departs_from_plan',
        summary: CODE_PROMPT.summary,
        focus: 'step 2',
        nudge: CODE_PROMPT.nudge
      });
      const user = state.users[1];
      expect(user).toContain('LEVEL\nprompt');
      expect(user).toContain('SITUATION\ndeparts_from_plan');
      expect(user).toContain('FOCUS\nstep 2');
      expect(user).toContain('int main(void) { return 0; }');
      expect(user).toContain('input "4 6"');
      expect(user).not.toContain('CLIENT_CODE');
      expect(user).not.toContain('CLIENT_INPUT');
      // The hint it goes further from is in its history, once.
      expect(user.split('- hint, [departs_from_plan] at step 2: Look at step 2.')).toHaveLength(2);
    });

    it('logs the escalation: its model call, then its record', async () => {
      await failedRun();
      state.queue = [CODE_PROMPT];
      await post('/code-feedback/escalate', codeEscalateBody());

      expect(types()).toEqual(['CLIVE_LLM_CALL', 'CLIVE_CODE_FEEDBACK', 'CLIVE_LLM_CALL', 'CLIVE_ESCALATE']);
      expect(log.written[2].data).toMatchObject({ during: 'escalate', seq: 1, purpose: 'nudge_code' });
      expect(entry('CLIVE_ESCALATE').data).toMatchObject({
        phase_id: 'implement',
        problem_id: 'p',
        step: null,
        attempt: 1,
        run_type: 'run',
        level: 'prompt',
        situation: 'departs_from_plan',
        focus: 'step 2',
        response: { level: 'prompt', nudge: CODE_PROMPT.nudge }
      });
    });

    it('refuses when no code feedback was recorded', async () => {
      const response = await post('/code-feedback/escalate', codeEscalateBody());
      expect(response.statusCode).toBe(409);
      expect(state.calls).toBe(0);
    });

    it('refuses a second escalation of the same run, and allows the next failing run’s', async () => {
      await failedRun();
      state.queue = [CODE_PROMPT];
      expect((await post('/code-feedback/escalate', codeEscalateBody())).statusCode).toBe(200);

      const again = await post('/code-feedback/escalate', codeEscalateBody());
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe(
        'You already have the more specific help for this run. Change your code and run it again for a new hint.'
      );
      expect(state.calls).toBe(2);

      await failedRun(2);
      state.queue = [CODE_PROMPT];
      const next = await post('/code-feedback/escalate', codeEscalateBody());
      expect(next.statusCode).toBe(200);
      expect(entry('CLIVE_ESCALATE').data.attempt).toBe(1);
      expect(log.written.filter((e) => e.type === 'CLIVE_ESCALATE').map((e) => e.data.attempt)).toEqual([1, 2]);
    });

    it('refuses once a newer Run or Submit has passed every test', async () => {
      await failedRun();
      log.written.push({
        type: 'RUN_ATTEMPT',
        data: { runType: 'submit', generalTestResults: [true, true, true], submittedCode: 'fixed' },
        timestamp: new Date()
      });
      const response = await post('/code-feedback/escalate', codeEscalateBody());

      expect(response.statusCode).toBe(409);
      expect(state.calls).toBe(1);
    });

    it('records a failed escalation as an error', async () => {
      await failedRun();
      state.queue = [new JudgeError('The model gave up.')];
      const response = await post('/code-feedback/escalate', codeEscalateBody());

      expect(response.statusCode).toBe(400);
      expect(entry('CLIVE_ERROR').data).toMatchObject({ call: 'escalate', phase_id: 'implement', attempt: 1 });
    });

    it('refuses an escalation into a practice session that is not yours', async () => {
      log.owns = false;
      expect((await post('/code-feedback/escalate', codeEscalateBody())).statusCode).toBe(403);
    });
  });

  it('refuses code feedback into a practice session that is not yours', async () => {
    log.owns = false;
    const response = await post('/code-feedback', codeBody());
    expect(response.statusCode).toBe(403);
  });

  it('shows the model only the last five earlier replies', async () => {
    state.queue = [CODE_REPLY];
    const history = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ situation: 'other', focus: `turn-${n}`, nudge: `reply ${n}` }));
    await post('/code-feedback', codeBody({ history }));
    expect(state.users[0]).toContain('turn-3');
    expect(state.users[0]).toContain('turn-7');
    expect(state.users[0]).not.toContain('turn-2');
  });

  async function getFrom(ip: string, url: string) {
    const instance = await app();
    return instance.inject({
      method: 'GET',
      url: `/plugin-api/clive${url}`,
      remoteAddress: ip,
      headers: { [PLUGIN_API_USER_HEADER]: 'user-1' }
    });
  }

  it('serves the live reasoning feed only to the machine the app runs on', async () => {
    // A session no other test has called a model in, so its feed is empty.
    const QUIET = '00000000-0000-4000-8000-000000000000';
    const away = await getFrom('10.0.0.5', `/live/events?session=${QUIET}&after=0`);
    expect(away.statusCode).toBe(403);
    const here = await getFrom('127.0.0.1', `/live/events?session=${QUIET}&after=0`);
    expect(here.statusCode).toBe(200);
    expect(here.json()).toMatchObject({ events: [], last: 0 });
    const page = await getFrom('::1', `/live?session=${QUIET}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
  });

  it('serves the live feed only for a session the signed-in user owns', async () => {
    log.owns = false;
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/plugin-api/clive/live/events?session=${SESSION}&after=0`,
      remoteAddress: '127.0.0.1',
      headers: { [PLUGIN_API_USER_HEADER]: 'user-1' }
    });
    expect(response.statusCode).toBe(403);
  });

  it('never hands the page a judge’s guidance, its evidence, or a nudge’s reason', async () => {
    // The prototype's leak sweep (`tests/test_student.py`), for every route a student page calls.
    const failing = CASE_VERDICTS.map((v) =>
      v.criterion_id === 'case_is_concrete' ? { ...v, verdict: 'FAIL', evidence: 'EVIDENCE_MARKER' } : v
    );
    state.queue = [
      { verdicts: failing },
      { reason: 'REASON_MARKER', nudge: 'What would you type in?' },
      { reason: 'REASON_MARKER', nudge: 'Which two numbers?' },
      CODE_REPLY
    ];
    const bodies = [
      (await post('/submit', casesBody())).body,
      (await post('/escalate', escalateBody())).body,
      (await post('/code-feedback', codeBody())).body,
      (await (await app()).inject({ method: 'GET', url: '/plugin-api/clive/boot' })).body
    ].join('\n');

    expect(bodies).toContain('Which two numbers?');
    expect(bodies).not.toContain('EVIDENCE_MARKER');
    expect(bodies).not.toContain('REASON_MARKER');
    for (const phase of ['problem_definition', 'case_design', 'algorithm_design']) {
      for (const criterion of rubricDoc(phase).criteria) {
        for (const line of (criterion.guidance ?? '').split('\n').map((l) => l.trim())) {
          if (line.length > 30) expect(bodies, `${criterion.id} guidance`).not.toContain(line);
        }
      }
    }
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
