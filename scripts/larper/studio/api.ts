/**
 * The page's server, as a function from a request to a response: reading runs,
 * comparing two, and starting one. `server.ts` is the thin part that listens.
 *
 * It starts paid runs, so it answers only the browser on this machine: the Host
 * must be this server's own loopback address, a request from another site's page
 * is refused by its Origin, and a run can only be started with a JSON body, which
 * a plain form on another site cannot send.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PHASES, type Answer, type PhaseId } from '../types';
import type { JobState } from './job';
import {
  compare,
  estimateCalls,
  listRuns,
  readRun,
  runEnv,
  summarise,
  type RunRequest,
  type StudioCategories
} from './runs';

export interface Request {
  method: string;
  url: string;
  host: string;
  origin?: string;
  contentType: string;
  body: string;
}

export interface Response {
  status: number;
  type: string;
  body: string | Buffer;
  /** A file name, when the browser should save the body instead of showing it. */
  download?: string;
}

export interface Context {
  /** `scripts/larper`: where `out/`, `answers/` and `baseline/` live. */
  root: string;
  port: number;
  categories: () => StudioCategories;
  page: () => string;
  job: { state: () => JobState; start: (_settings: Record<string, string>) => string };
}

const PHASE_NAMES: Record<PhaseId, string> = {
  problem_definition: 'Problem',
  case_design: 'Cases',
  algorithm_design: 'Design',
  implement: 'Implement'
};

const FILE_TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8'
};

const send = (status: number, value: unknown): Response => ({
  status,
  type: 'application/json; charset=utf-8',
  body: JSON.stringify(value)
});
const refuse = (status: number, error: string): Response => send(status, { error });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The problems a run can be started for: those with a baseline, named from their latest run. */
function problems(ctx: Context): { id: string; title: string }[] {
  const dir = path.join(ctx.root, 'baseline');
  if (!fs.existsSync(dir)) return [];
  const runs = listRuns(path.join(ctx.root, 'out'));
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .map((id) => ({ id, title: runs.find((r) => r.problemId === id && r.title)?.title ?? '' }));
}

/** How many saved answers a reusing run would submit. */
function savedAnswers(ctx: Context, request: RunRequest): number {
  const phases = request.phase ? [request.phase] : PHASES;
  let count = 0;
  for (const phase of phases) {
    const file = path.join(ctx.root, 'answers', request.problemId ?? '', `${phase}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const answers = JSON.parse(fs.readFileSync(file, 'utf8')) as Answer[];
      count += answers.filter((a) => !request.category || a.category === request.category).length;
    } catch {
      // An unreadable file is the run's to report.
    }
  }
  return count;
}

export function handle(request: Request, ctx: Context): Response {
  const own = [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`];
  if (!own.includes(request.host)) return refuse(403, 'This page answers only on this machine.');
  if (request.origin && !own.some((host) => request.origin === `http://${host}`)) {
    return refuse(403, 'This page answers only its own requests.');
  }

  const url = new URL(request.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const outRoot = path.join(ctx.root, 'out');

  try {
    if (request.method === 'GET') {
      if (parts.length === 0) return { status: 200, type: 'text/html; charset=utf-8', body: ctx.page() };
      if (url.pathname === '/api/config') {
        return send(200, {
          phases: PHASES.map((id) => ({ id, name: PHASE_NAMES[id] })),
          categories: ctx.categories(),
          problems: problems(ctx)
        });
      }
      if (url.pathname === '/api/runs') return send(200, listRuns(outRoot));
      if (url.pathname === '/api/job') return send(200, ctx.job.state());
      if (url.pathname === '/api/compare') {
        const a = readRun(outRoot, url.searchParams.get('a') ?? '');
        const b = readRun(outRoot, url.searchParams.get('b') ?? '');
        return send(200, compare(a.results, b.results));
      }
      if (parts[0] === 'api' && parts[1] === 'runs' && parts.length === 3) {
        const run = readRun(outRoot, parts[2]);
        return send(200, { ...run, rows: summarise(run.results, ctx.categories()) });
      }
      if (parts[0] === 'files' && parts.length === 3) {
        const run = readRun(outRoot, parts[1]);
        // Only the files the run lists: a name is matched, never joined into a path unchecked.
        if (!run.files.includes(parts[2])) return refuse(404, `The run has no file '${parts[2]}'.`);
        return {
          status: 200,
          type: FILE_TYPES[path.extname(parts[2])] ?? 'application/octet-stream',
          body: fs.readFileSync(path.join(outRoot, parts[1], parts[2])),
          download: `${parts[1]}-${parts[2]}`
        };
      }
      return refuse(404, 'There is nothing at this address.');
    }

    if (request.method === 'POST') {
      if (!request.contentType.startsWith('application/json')) return refuse(415, 'Send the request as JSON.');
      let body: RunRequest;
      try {
        body = JSON.parse(request.body || '{}') as RunRequest;
      } catch {
        return refuse(400, 'The request could not be read.');
      }
      if (url.pathname === '/api/estimate') {
        runEnv(body, ctx.categories());
        return send(200, estimateCalls(body, ctx.categories(), savedAnswers(ctx, body)));
      }
      if (url.pathname === '/api/run') {
        const settings = runEnv(body, ctx.categories());
        if (ctx.job.state().running) return refuse(409, 'A run is already going. Wait for it to finish.');
        return send(200, { id: ctx.job.start(settings) });
      }
      return refuse(404, 'There is nothing at this address.');
    }
    return refuse(405, 'Only GET and POST.');
  } catch (error) {
    const text = message(error);
    return refuse(/no run|not a run/i.test(text) ? 404 : 400, text);
  }
}
