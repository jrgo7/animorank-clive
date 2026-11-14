import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { handle, type Context, type Request } from './api';
import { Job } from './job';

function context(over: Partial<Context> = {}): Context & { started: Record<string, string>[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'larper-api-'));
  const dir = path.join(root, 'out', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  const one = {
    answer: {
      problemId: 'p1',
      phase: 'problem_definition',
      category: 'control',
      variant: 1,
      artifact: { summary: 's' },
      writtenBy: 'larper'
    },
    pass: 1,
    blocked: false,
    failed: [],
    advisoryUnmet: [],
    situation: null,
    feedback: '',
    focusFields: [],
    observed: {},
    offCategory: false,
    matches: null,
    record: null,
    ms: 1
  };
  fs.writeFileSync(path.join(dir, 'results.jsonl'), `${JSON.stringify(one)}\n`);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ problemId: 'p1', title: 'Red Wildlings' }));
  fs.writeFileSync(path.join(dir, 'problem_definition.labels.csv'), 'Row ID\r\n');
  fs.mkdirSync(path.join(root, 'baseline'));
  fs.writeFileSync(path.join(root, 'baseline', 'p1.json'), '{}');
  fs.mkdirSync(path.join(root, 'answers', 'p1'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'answers', 'p1', 'problem_definition.json'),
    JSON.stringify([one.answer, one.answer])
  );
  const started: Record<string, string>[] = [];
  return {
    started,
    root,
    port: 8766,
    categories: () => ({
      problem_definition: [{ id: 'control', name: 'Control' }],
      case_design: [],
      algorithm_design: [],
      implement: []
    }),
    page: () => '<!doctype html><title>Larper</title>',
    job: {
      state: () => ({ running: false, id: null, lines: [], exitCode: null }),
      start: (env) => {
        started.push(env);
        return 'r2';
      }
    },
    ...over
  };
}

const get = (url: string, over: Partial<Request> = {}): Request => ({
  method: 'GET',
  url,
  host: '127.0.0.1:8766',
  contentType: '',
  body: '',
  ...over
});
const post = (url: string, body: unknown, over: Partial<Request> = {}): Request => ({
  method: 'POST',
  url,
  host: 'localhost:8766',
  contentType: 'application/json',
  body: JSON.stringify(body),
  ...over
});
const json = (response: { body: string | Buffer }) => JSON.parse(String(response.body));

it('serves the page', () => {
  const r = handle(get('/'), context());
  expect(r.status).toBe(200);
  expect(r.type).toMatch(/text\/html/);
  expect(String(r.body)).toContain('Larper');
});

it('tells the page what can be run: phases, categories, and the problems that have a baseline', () => {
  const body = json(handle(get('/api/config'), context()));
  expect(body.phases.map((p: { id: string }) => p.id)).toEqual([
    'problem_definition',
    'case_design',
    'algorithm_design',
    'implement'
  ]);
  expect(body.categories.problem_definition).toEqual([{ id: 'control', name: 'Control' }]);
  expect(body.problems).toEqual([{ id: 'p1', title: 'Red Wildlings' }]);
});

it('lists runs and reads one, with its summary', () => {
  const ctx = context();
  expect(json(handle(get('/api/runs'), ctx)).map((r: { id: string }) => r.id)).toEqual(['r1']);
  const run = json(handle(get('/api/runs/r1'), ctx));
  expect(run.summary.title).toBe('Red Wildlings');
  expect(run.rows).toMatchObject([{ category: 'control', answers: 1, passed: 1 }]);
  expect(run.results).toHaveLength(1);
  expect(run.files).toContain('problem_definition.labels.csv');
});

it('compares two runs', () => {
  const rows = json(handle(get('/api/compare?a=r1&b=r1'), context()));
  expect(rows).toMatchObject([{ category: 'control', sameAnswer: true, changed: [] }]);
});

it('a run that does not exist is a 404 with the reason', () => {
  const r = handle(get('/api/runs/nope'), context());
  expect(r.status).toBe(404);
  expect(json(r).error).toMatch(/nope/);
});

it("hands over a run's files, and nothing outside the run", () => {
  const ctx = context();
  const file = handle(get('/files/r1/problem_definition.labels.csv'), ctx);
  expect(file.status).toBe(200);
  expect(file.type).toMatch(/text\/csv/);
  expect(file.download).toBe('r1-problem_definition.labels.csv');
  expect(handle(get('/files/r1/..%2F..%2Fbaseline%2Fp1.json'), ctx).status).toBe(404);
  expect(handle(get('/files/r1/run.json'), ctx).status).toBe(404);
});

it('estimates the calls of a run before it is started', () => {
  const ctx = context();
  expect(
    json(handle(post('/api/estimate', { problemId: 'p1', phase: 'problem_definition', variants: 2 }), ctx))
  ).toEqual({
    least: 4,
    most: 6
  });
  // Reusing: the two answers saved for this problem and phase.
  expect(
    json(handle(post('/api/estimate', { problemId: 'p1', phase: 'problem_definition', variants: 2, reuse: true }), ctx))
  ).toEqual({ least: 2, most: 4 });
});

it('starts a run with the checked settings and says which run it is', () => {
  const ctx = context();
  const r = handle(post('/api/run', { problemId: 'p1', phase: 'problem_definition', variants: 1, reuse: true }), ctx);
  expect(r.status).toBe(200);
  expect(json(r)).toEqual({ id: 'r2' });
  expect(ctx.started).toEqual([
    { LARPER_PROBLEM: 'p1', LARPER_PHASE: 'problem_definition', LARPER_VARIANTS: '1', LARPER_REUSE: '1' }
  ]);
});

it('refuses a request that is not a real run, and starts nothing', () => {
  const ctx = context();
  const r = handle(post('/api/run', { problemId: 'p1', phase: 'nope', variants: 1 }), ctx);
  expect(r.status).toBe(400);
  expect(json(r).error).toMatch(/phase/);
  expect(ctx.started).toEqual([]);
});

it('refuses a second run while one is going', () => {
  const ctx = context();
  ctx.job.state = () => ({ running: true, id: 'r2', lines: [], exitCode: null });
  const r = handle(post('/api/run', { problemId: 'p1', variants: 1 }), ctx);
  expect(r.status).toBe(409);
  expect(ctx.started).toEqual([]);
});

it('reports the run in progress', () => {
  const ctx = context();
  ctx.job.state = () => ({ running: true, id: 'r2', lines: ['wrote problem_definition/control 1'], exitCode: null });
  expect(json(handle(get('/api/job'), ctx))).toEqual({
    running: true,
    id: 'r2',
    lines: ['wrote problem_definition/control 1'],
    exitCode: null
  });
});

it("answers only this machine's own browser: another site cannot start a paid run", () => {
  const ctx = context();
  expect(handle(get('/api/runs', { host: 'evil.example:8766' }), ctx).status).toBe(403);
  expect(handle(post('/api/run', { problemId: 'p1', variants: 1 }, { contentType: 'text/plain' }), ctx).status).toBe(
    415
  );
  expect(
    handle(post('/api/run', { problemId: 'p1', variants: 1 }, { origin: 'https://evil.example' }), ctx).status
  ).toBe(403);
  expect(ctx.started).toEqual([]);
});

it('a job runs its command, keeps the lines worth showing, and knows when it ended', async () => {
  const script =
    'console.log("stdout | noise");console.log("wrote problem_definition/control 1");console.log("ran problem_definition/control 1: passed");console.log(process.env.LARPER_PHASE + " " + process.env.LARPER_OUT)';
  const job = new Job('/tmp/out-root', process.cwd(), ['node', '-e', script], () => 'r9', [
    /^wrote /,
    /^ran /,
    /^problem/
  ]);
  const done = vi.fn();
  const id = job.start({ LARPER_PHASE: 'problem_definition' }, done);
  expect(id).toBe('r9');
  expect(job.state().running).toBe(true);
  expect(() => job.start({})).toThrow(/already/);
  await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
  expect(job.state()).toEqual({
    running: false,
    id: 'r9',
    lines: [
      'wrote problem_definition/control 1',
      'ran problem_definition/control 1: passed',
      'problem_definition /tmp/out-root/r9'
    ],
    exitCode: 0
  });
});

it('a job whose command fails keeps the last thing it said', async () => {
  const job = new Job(
    '/tmp/o',
    process.cwd(),
    ['node', '-e', 'console.error("Error: No baseline for case_design.");process.exit(1)'],
    () => 'r9'
  );
  const done = vi.fn();
  job.start({}, done);
  await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
  expect(job.state().exitCode).toBe(1);
  expect(job.state().lines.join('\n')).toContain('No baseline for case_design');
});
