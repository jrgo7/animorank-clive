import { expect, it, vi } from 'vitest';
import { buildBaseline, flag, mergeAnswers, runPhase, selectAnswers, type PhaseRun } from './run';
import type { Answer, Baseline, Category, PhaseId, Result } from './types';

const answer = (category: string, variant: number, writtenBy: 'larper' | 'hand' = 'larper'): Answer => ({
  problemId: 'p',
  phase: 'problem_definition',
  category,
  variant,
  artifact: {},
  writtenBy
});
const category = (id: string): Category => ({ id, name: id, writes: 'w', expect: null });

it("new answers replace the larper's earlier ones for that category and keep everything else", () => {
  const saved = [answer('control', 1), answer('control', 2), answer('control', 3, 'hand'), answer('one_word', 1)];
  const merged = mergeAnswers(saved, 'control', [{ ...answer('control', 1), model: 'new' }]);
  expect(merged).toEqual([
    answer('control', 3, 'hand'),
    answer('one_word', 1),
    { ...answer('control', 1), model: 'new' }
  ]);
});

it('answers are run in the order of the categories file, and unknown categories are set aside', () => {
  const saved = [answer('old_category', 1), answer('one_word', 1), answer('control', 2), answer('control', 1)];
  const { toRun, skipped } = selectAnswers(saved, [category('control'), category('one_word')]);
  expect(toRun.map((a) => `${a.category}:${a.variant}`)).toEqual(['control:1', 'control:2', 'one_word:1']);
  expect(skipped).toEqual(['old_category']);
});

it('choosing one category runs only its answers, and skips nothing', () => {
  const saved = [answer('one_word', 1), answer('control', 1)];
  expect(selectAnswers(saved, [category('control'), category('one_word')], 'one_word')).toEqual({
    toRun: [answer('one_word', 1)],
    skipped: []
  });
});

const done = (a: Answer, blocked: boolean, pass: 1 | 2 = 1): Result => ({
  answer: a,
  pass,
  blocked,
  failed: [],
  advisoryUnmet: [],
  situation: blocked ? 'other' : null,
  feedback: '',
  focusFields: [],
  observed: {},
  offCategory: false,
  matches: null,
  record: null,
  ms: 0
});

function phaseRun(over: Partial<PhaseRun> = {}) {
  const kept: Result[] = [];
  const saves: Answer[][] = [];
  const run: PhaseRun = {
    saved: [],
    categories: [category('control'), category('one_word')],
    variants: 2,
    reuse: false,
    dry: false,
    repeat: false,
    write: vi.fn(async (c: Category, variant: number) => answer(c.id, variant)),
    run: vi.fn(async (a: Answer, _c: Category, earlier?: Result) =>
      done(a, a.category === 'one_word', earlier ? 2 : 1)
    ),
    save: (answers) => saves.push(answers),
    keep: (r) => kept.push(r),
    ...over
  };
  return { run, kept, saves };
}

it('a phase writes every category, saves after each, then runs them all', async () => {
  const { run, kept, saves } = phaseRun();
  const { results, skipped } = await runPhase(run);
  expect(run.write).toHaveBeenCalledTimes(4);
  expect(saves).toHaveLength(2);
  expect(saves[1].map((a) => `${a.category}:${a.variant}`)).toEqual([
    'control:1',
    'control:2',
    'one_word:1',
    'one_word:2'
  ]);
  expect(results).toHaveLength(4);
  expect(kept).toEqual(results);
  expect(skipped).toEqual([]);
});

it('each result is kept as soon as it is known, before the next answer is run', async () => {
  const order: string[] = [];
  const { run } = phaseRun({ keep: (r) => order.push(`keep ${r.answer.category}:${r.answer.variant}`) });
  run.run = vi.fn(async (a: Answer) => {
    order.push(`run ${a.category}:${a.variant}`);
    return done(a, false);
  });
  await runPhase(run);
  expect(order.slice(0, 4)).toEqual(['run control:1', 'keep control:1', 'run control:2', 'keep control:2']);
});

it('a dry run writes and saves answers and submits none', async () => {
  const { run, kept, saves } = phaseRun({ dry: true });
  const { results } = await runPhase(run);
  expect(saves).toHaveLength(2);
  expect(run.run).not.toHaveBeenCalled();
  expect(results).toEqual([]);
  expect(kept).toEqual([]);
});

it('reusing saved answers writes nothing new', async () => {
  const { run, saves } = phaseRun({ reuse: true, saved: [answer('control', 1), answer('gone', 1)] });
  const { results, skipped } = await runPhase(run);
  expect(run.write).not.toHaveBeenCalled();
  expect(saves).toEqual([]);
  expect(results.map((r) => r.answer.category)).toEqual(['control']);
  expect(skipped).toEqual(['gone']);
});

it('one chosen category is the only one written and run', async () => {
  const { run } = phaseRun({ only: 'one_word', saved: [answer('control', 1)] });
  const { results } = await runPhase(run);
  expect(run.write).toHaveBeenCalledTimes(2);
  expect(results.map((r) => r.answer.category)).toEqual(['one_word', 'one_word']);
});

it('a blocked answer is submitted again when repeats are on, and only a blocked one', async () => {
  const { run } = phaseRun({ repeat: true });
  const { results } = await runPhase(run);
  expect(results.map((r) => `${r.answer.category}:${r.answer.variant}:${r.pass}`)).toEqual([
    'control:1:1',
    'control:2:1',
    'one_word:1:1',
    'one_word:1:2',
    'one_word:2:1',
    'one_word:2:2'
  ]);
});

it('a baseline is built phase by phase, each on the ones before, and saved as it grows', async () => {
  const saved: Baseline[] = [];
  const attempt = vi.fn(async (phase: PhaseId, baseline: Baseline) =>
    done({ ...answer('control', 1), artifact: { made: phase, after: Object.keys(baseline).length } }, false)
  );
  const baseline = await buildBaseline({ tries: 3, attempt, save: (b) => saved.push({ ...b }) });
  expect(Object.keys(baseline)).toEqual(['problem_definition', 'case_design', 'algorithm_design', 'implement']);
  expect(baseline.algorithm_design).toEqual({ made: 'algorithm_design', after: 2 });
  expect(saved).toHaveLength(4);
});

it('a baseline that cannot be finished keeps only the phases that passed, never older work', async () => {
  const saved: Baseline[] = [];
  const attempt = vi.fn(async (phase: PhaseId) =>
    phase === 'case_design'
      ? { ...done(answer('control', 1), true), feedback: 'Show your working.' }
      : done({ ...answer('control', 1), artifact: { made: phase } }, false)
  );
  await expect(buildBaseline({ tries: 3, attempt, save: (b) => saved.push({ ...b }) })).rejects.toThrow(
    /case_design[\s\S]*3 tries[\s\S]*Show your working\./
  );
  expect(attempt).toHaveBeenCalledTimes(4);
  expect(saved.at(-1)).toEqual({ problem_definition: { made: 'problem_definition' } });
});

it('a baseline answer whose code did not do what Control asks is tried again', async () => {
  let tries = 0;
  const attempt = vi.fn(async (phase: PhaseId) => {
    const r = done({ ...answer('control', 1), artifact: { made: phase } }, false);
    if (phase === 'implement' && (tries += 1) === 1) return { ...r, blocked: true, offCategory: true };
    return r;
  });
  await buildBaseline({ tries: 3, attempt, save: () => {} });
  expect(attempt).toHaveBeenCalledTimes(5);
});

it('a switch is on for 1, true or yes, off when unset, and refuses anything else', () => {
  expect(flag('X', { X: '1' })).toBe(true);
  expect(flag('X', { X: 'true' })).toBe(true);
  expect(flag('X', { X: 'yes' })).toBe(true);
  expect(flag('X', {})).toBe(false);
  expect(flag('X', { X: '0' })).toBe(false);
  expect(flag('X', { X: '' })).toBe(false);
  expect(() => flag('LARPER_DRY', { LARPER_DRY: 'on' })).toThrow(/LARPER_DRY/);
});
