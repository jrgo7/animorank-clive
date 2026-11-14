/**
 * What the larper's page shows, read from the same files a terminal run writes:
 * the runs under `out/`, a summary of one, and two runs side by side.
 *
 * Plain Node, with no imports from the app: the page's server is started on its
 * own and must not need the app's build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PHASES, type PhaseId, type Result } from '../types';

/** The categories as the page needs them: enough to name and order things. */
export type StudioCategories = Record<PhaseId, { id: string; name: string }[]>;

export interface RunSummary {
  id: string;
  problemId: string;
  title: string;
  phases: PhaseId[];
  variants: number | null;
  reuse: boolean | null;
  repeat: boolean | null;
  results: number;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function runDir(outRoot: string, id: string): string {
  if (!RUN_ID.test(id) || id.includes('..')) throw new Error(`'${id}' is not a run.`);
  const dir = path.join(outRoot, id);
  if (!fs.existsSync(path.join(dir, 'results.jsonl')))
    throw new Error(`There is no run '${id}' (missing results.jsonl).`);
  return dir;
}

/** Every whole line of results; a last line still being written is left out. */
function readResults(file: string): Result[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Result];
      } catch {
        return [];
      }
    });
}

export function readRun(outRoot: string, id: string): { summary: RunSummary; results: Result[]; files: string[] } {
  const dir = runDir(outRoot, id);
  const results = readResults(path.join(dir, 'results.jsonl'));
  let meta: Partial<RunSummary> = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as Partial<RunSummary>;
  } catch {
    // A run from before run.json existed, or one still starting.
  }
  const seen = new Set(results.map((r) => r.answer.phase));
  return {
    summary: {
      id,
      problemId: meta.problemId ?? results[0]?.answer.problemId ?? '',
      title: meta.title ?? '',
      phases: meta.phases ?? PHASES.filter((p) => seen.has(p)),
      variants: meta.variants ?? null,
      reuse: meta.reuse ?? null,
      repeat: meta.repeat ?? null,
      results: results.length
    },
    results,
    files: fs
      .readdirSync(dir)
      .filter((f) => /\.(md|csv|jsonl)$/.test(f))
      .sort()
  };
}

/** Newest first: run folders are named by when they started. */
export function listRuns(outRoot: string): RunSummary[] {
  if (!fs.existsSync(outRoot)) return [];
  return fs
    .readdirSync(outRoot)
    .filter((id) => RUN_ID.test(id) && fs.existsSync(path.join(outRoot, id, 'results.jsonl')))
    .sort()
    .reverse()
    .map((id) => readRun(outRoot, id).summary);
}

export interface SummaryRow {
  phase: PhaseId;
  category: string;
  name: string;
  answers: number;
  blocked: number;
  passed: number;
  errors: number;
  offCategory: number;
  situations: Record<string, number>;
}

/** One row per category that has results, in the categories file's order; repeats are not counted. */
export function summarise(results: Result[], categories: StudioCategories): SummaryRow[] {
  const rows: SummaryRow[] = [];
  for (const phase of PHASES) {
    const mine = results.filter((r) => r.answer.phase === phase && r.pass === 1);
    const known = categories[phase] ?? [];
    const unknown = [...new Set(mine.map((r) => r.answer.category))]
      .filter((id) => !known.some((c) => c.id === id))
      .map((id) => ({ id, name: id }));
    for (const category of [...known, ...unknown]) {
      const of = mine.filter((r) => r.answer.category === category.id);
      if (!of.length) continue;
      const situations: Record<string, number> = {};
      for (const r of of) if (r.situation) situations[r.situation] = (situations[r.situation] ?? 0) + 1;
      rows.push({
        phase,
        category: category.id,
        name: category.name,
        answers: of.length,
        blocked: of.filter((r) => r.blocked === true).length,
        passed: of.filter((r) => r.blocked === false).length,
        errors: of.filter((r) => r.blocked === null).length,
        offCategory: of.filter((r) => r.offCategory).length,
        situations
      });
    }
  }
  return rows;
}

export interface CompareRow {
  phase: PhaseId;
  category: string;
  variant: number;
  pass: 1 | 2;
  before: Result | null;
  after: Result | null;
  /** Whether both runs judged the very same answer. */
  sameAnswer: boolean;
  /** What differs in the outcome: any of `blocked`, `failed`, `situation`; empty when nothing does. */
  changed: string[];
}

const keyOf = (r: Result) => `${r.answer.phase}\u0000${r.answer.category}\u0000${r.answer.variant}\u0000${r.pass}`;
const sorted = (ids: string[]) => [...ids].sort().join(',');

/**
 * Two runs, answer by answer. The outcome is what CLive decided -- blocked or not,
 * which points failed, which situation -- not the feedback's wording, which differs
 * on every call. Changed rows come first.
 */
export function compare(before: Result[], after: Result[]): CompareRow[] {
  const first = new Map(before.map((r) => [keyOf(r), r]));
  const second = new Map(after.map((r) => [keyOf(r), r]));
  const keys = [...new Set([...first.keys(), ...second.keys()])];
  const rows = keys.map((key): CompareRow => {
    const a = first.get(key) ?? null;
    const b = second.get(key) ?? null;
    const one = (a ?? b) as Result;
    const changed: string[] = [];
    if (!b) changed.push('only in the first run');
    else if (!a) changed.push('only in the second run');
    else {
      if (a.blocked !== b.blocked) changed.push('blocked');
      if (sorted(a.failed) !== sorted(b.failed)) changed.push('failed');
      if (a.situation !== b.situation) changed.push('situation');
    }
    return {
      phase: one.answer.phase,
      category: one.answer.category,
      variant: one.answer.variant,
      pass: one.pass,
      before: a,
      after: b,
      sameAnswer: !!a && !!b && JSON.stringify(a.answer.artifact) === JSON.stringify(b.answer.artifact),
      changed
    };
  });
  return [...rows.filter((r) => r.changed.length), ...rows.filter((r) => !r.changed.length)];
}

export interface RunRequest {
  problemId?: string;
  phase?: string;
  category?: string;
  variants?: number;
  reuse?: boolean;
  repeat?: boolean;
}

function categoriesOf(request: RunRequest, categories: StudioCategories): { id: string }[] {
  const phases = request.phase ? [request.phase as PhaseId] : PHASES;
  return phases.flatMap((p) => (categories[p] ?? []).filter((c) => !request.category || c.id === request.category));
}

/**
 * The page's request as the settings of a run. Everything is checked against what
 * exists, so nothing the page sends reaches the command line unexamined.
 */
export function runEnv(request: RunRequest, categories: StudioCategories): Record<string, string> {
  if (!request.problemId || !/^[A-Za-z0-9-]{1,64}$/.test(request.problemId)) {
    throw new Error('Choose a problem: its id is letters, digits and dashes.');
  }
  if (request.phase !== undefined && !(PHASES as string[]).includes(request.phase)) {
    throw new Error(`'${request.phase}' is not a phase.`);
  }
  if (request.category !== undefined && !categoriesOf(request, categories).length) {
    throw new Error(`There is no category '${request.category}'${request.phase ? ` in ${request.phase}` : ''}.`);
  }
  const variants = request.variants;
  if (typeof variants !== 'number' || !Number.isInteger(variants) || variants < 1 || variants > 10) {
    throw new Error('Answers per category must be a whole number from 1 to 10.');
  }
  const env: Record<string, string> = { LARPER_PROBLEM: request.problemId };
  if (request.phase) env.LARPER_PHASE = request.phase;
  if (request.category) env.LARPER_CATEGORY = request.category;
  env.LARPER_VARIANTS = String(variants);
  if (request.reuse) env.LARPER_REUSE = '1';
  if (request.repeat) env.LARPER_REPEAT = '1';
  return env;
}

/**
 * Roughly how many paid model calls a run makes. `savedAnswers` is how many saved
 * answers a reusing run would submit. Each answer is one call to write (unless
 * reused) and one to judge; feedback is a further call only when it is blocked, and
 * a repeat judges and answers a blocked one again.
 */
export function estimateCalls(
  request: RunRequest,
  categories: StudioCategories,
  savedAnswers: number
): { least: number; most: number } {
  const written = request.reuse ? 0 : categoriesOf(request, categories).length * (request.variants ?? 0);
  const judged = request.reuse ? savedAnswers : written;
  return { least: written + judged, most: written + judged * (request.repeat ? 4 : 2) };
}
