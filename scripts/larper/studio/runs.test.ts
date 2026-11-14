import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Answer, Result } from '../types';
import { compare, estimateCalls, listRuns, readRun, runEnv, summarise, type StudioCategories } from './runs';

const CATEGORIES: StudioCategories = {
  problem_definition: [
    { id: 'control', name: 'Control' },
    { id: 'one_word', name: 'One Word Response' }
  ],
  case_design: [{ id: 'control', name: 'Control / All are Correct' }],
  algorithm_design: [],
  implement: []
};

const answer = (category: string, variant: number, text = 'a'): Answer => ({
  problemId: 'p1',
  phase: 'problem_definition',
  category,
  variant,
  artifact: { summary: text },
  writtenBy: 'larper'
});

const result = (category: string, variant: number, over: Partial<Result> = {}, text = 'a'): Result => ({
  answer: answer(category, variant, text),
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
  ms: 1,
  ...over
});

function outRoot(runs: Record<string, { meta?: object; results: Result[]; files?: string[] }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'larper-studio-'));
  for (const [id, run] of Object.entries(runs)) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'results.jsonl'), run.results.map((r) => `${JSON.stringify(r)}\n`).join(''));
    if (run.meta) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run.meta));
    for (const f of run.files ?? []) fs.writeFileSync(path.join(dir, f), 'x');
  }
  return root;
}

it('runs are listed newest first, with what each one ran', () => {
  const root = outRoot({
    '2026-11-14T10-00-00': { results: [result('control', 1)] },
    '2026-11-14T12-00-00': {
      meta: {
        problemId: 'p1',
        title: 'Red Wildlings',
        phases: ['problem_definition'],
        variants: 1,
        reuse: true,
        repeat: false
      },
      results: [result('control', 1), result('one_word', 1, { blocked: true })]
    }
  });
  expect(listRuns(root)).toEqual([
    {
      id: '2026-11-14T12-00-00',
      problemId: 'p1',
      title: 'Red Wildlings',
      phases: ['problem_definition'],
      variants: 1,
      reuse: true,
      repeat: false,
      results: 2
    },
    // A run from before run.json existed: what can be told from its results.
    {
      id: '2026-11-14T10-00-00',
      problemId: 'p1',
      title: '',
      phases: ['problem_definition'],
      variants: null,
      reuse: null,
      repeat: null,
      results: 1
    }
  ]);
});

it('no runs yet is an empty list, not an error', () => {
  expect(listRuns(path.join(os.tmpdir(), 'larper-studio-nothing-here'))).toEqual([]);
});

it('a run is read with its results and the files that can be downloaded', () => {
  const root = outRoot({
    r1: { results: [result('control', 1)], files: ['problem_definition.labels.csv', 'problem_definition.md'] }
  });
  const run = readRun(root, 'r1');
  expect(run.results).toHaveLength(1);
  expect(run.files).toEqual(['problem_definition.labels.csv', 'problem_definition.md', 'results.jsonl']);
});

it('a half-written last line of results is left out, not a crash', () => {
  const root = outRoot({ r1: { results: [result('control', 1)] } });
  fs.appendFileSync(path.join(root, 'r1', 'results.jsonl'), '{"answer":{"cat');
  expect(readRun(root, 'r1').results).toHaveLength(1);
});

it('a run id that reaches outside the folder is refused', () => {
  const root = outRoot({ r1: { results: [] } });
  expect(() => readRun(root, '../r1')).toThrow(/run/i);
  expect(() => readRun(root, 'missing')).toThrow(/missing/);
});

it("the summary counts each category in the file's order, first submits only", () => {
  const rows = summarise(
    [
      result('one_word', 1, { blocked: true, situation: 'meaning_not_type' }),
      result('one_word', 1, { pass: 2, blocked: true, situation: 'other' }),
      result('one_word', 2, { blocked: null, error: 'down' }),
      result('control', 1),
      result('gone', 1)
    ],
    CATEGORIES
  );
  expect(rows).toEqual([
    {
      phase: 'problem_definition',
      category: 'control',
      name: 'Control',
      answers: 1,
      blocked: 0,
      passed: 1,
      errors: 0,
      offCategory: 0,
      situations: {}
    },
    {
      phase: 'problem_definition',
      category: 'one_word',
      name: 'One Word Response',
      answers: 2,
      blocked: 1,
      passed: 0,
      errors: 1,
      offCategory: 0,
      situations: { meaning_not_type: 1 }
    },
    // No longer in the categories file: still shown, under its id.
    {
      phase: 'problem_definition',
      category: 'gone',
      name: 'gone',
      answers: 1,
      blocked: 0,
      passed: 1,
      errors: 0,
      offCategory: 0,
      situations: {}
    }
  ]);
});

it('comparing two runs puts the answers whose outcome changed first', () => {
  const before = [
    result('control', 1),
    result('one_word', 1, { blocked: true, failed: ['output_types'], situation: 'meaning_not_type', feedback: 'old' }),
    result('one_word', 2, { blocked: true, failed: ['output_types'], situation: 'other', feedback: 'same' })
  ];
  const after = [
    result('control', 1),
    result('one_word', 1, { blocked: true, failed: ['output_types'], situation: 'missing_detail', feedback: 'new' }),
    result('one_word', 2, {
      blocked: true,
      failed: ['output_types'],
      situation: 'other',
      feedback: 'same wording, different'
    })
  ];
  const rows = compare(before, after);
  expect(rows.map((r) => `${r.category}:${r.variant} ${r.changed.join('+') || 'same'}`)).toEqual([
    'one_word:1 situation',
    'control:1 same',
    'one_word:2 same'
  ]);
  expect(rows[0].before?.feedback).toBe('old');
  expect(rows[0].after?.feedback).toBe('new');
  expect(rows[0].sameAnswer).toBe(true);
});

it('a change in what blocks or what failed is a change', () => {
  const rows = compare(
    [result('control', 1), result('one_word', 1, { blocked: true, failed: ['a', 'b'] })],
    [
      result('control', 1, { blocked: true, failed: ['a'] }),
      result('one_word', 1, { blocked: true, failed: ['b', 'a'] })
    ]
  );
  expect(rows.map((r) => `${r.category} ${r.changed.join('+') || 'same'}`)).toEqual([
    'control blocked+failed',
    'one_word same'
  ]);
});

it('an answer in only one of the two runs, or rewritten between them, is said to be so', () => {
  const rows = compare(
    [result('control', 1, {}, 'first wording'), result('one_word', 1)],
    [result('control', 1, {}, 'second wording'), result('one_word', 2)]
  );
  const by = Object.fromEntries(rows.map((r) => [`${r.category}:${r.variant}`, r]));
  expect(by['control:1'].sameAnswer).toBe(false);
  expect(by['one_word:1'].after).toBeNull();
  expect(by['one_word:1'].changed).toEqual(['only in the first run']);
  expect(by['one_word:2'].before).toBeNull();
  expect(by['one_word:2'].changed).toEqual(['only in the second run']);
});

it('a request from the page becomes the settings of a run, and nothing else', () => {
  expect(
    runEnv(
      { problemId: 'p-1', phase: 'problem_definition', category: 'one_word', variants: 2, reuse: true, repeat: true },
      CATEGORIES
    )
  ).toEqual({
    LARPER_PROBLEM: 'p-1',
    LARPER_PHASE: 'problem_definition',
    LARPER_CATEGORY: 'one_word',
    LARPER_VARIANTS: '2',
    LARPER_REUSE: '1',
    LARPER_REPEAT: '1'
  });
  expect(runEnv({ problemId: 'p-1', variants: 3 }, CATEGORIES)).toEqual({
    LARPER_PROBLEM: 'p-1',
    LARPER_VARIANTS: '3'
  });
});

it.each([
  [{ variants: 1 }, /problem/i],
  [{ problemId: 'p; rm -rf', variants: 1 }, /problem/i],
  [{ problemId: 'p', phase: 'nope', variants: 1 }, /phase/i],
  [{ problemId: 'p', phase: 'case_design', category: 'one_word', variants: 1 }, /category/i],
  [{ problemId: 'p', category: 'nope', variants: 1 }, /category/i],
  [{ problemId: 'p', variants: 0 }, /answers/i],
  [{ problemId: 'p', variants: 11 }, /answers/i],
  [{ problemId: 'p', variants: 1.5 }, /answers/i]
])('a request that is not a real run is refused: %j', (request, message) => {
  expect(() => runEnv(request as never, CATEGORIES)).toThrow(message);
});

it('says roughly how many paid calls a run will make', () => {
  // 2 categories x 2 answers: 4 written, 4 judged, up to 4 pieces of feedback.
  expect(estimateCalls({ problemId: 'p', phase: 'problem_definition', variants: 2 }, CATEGORIES, 0)).toEqual({
    least: 8,
    most: 12
  });
  // Reusing 5 saved answers writes none; repeats can add a judge and a feedback call each.
  expect(
    estimateCalls(
      { problemId: 'p', phase: 'problem_definition', variants: 2, reuse: true, repeat: true },
      CATEGORIES,
      5
    )
  ).toEqual({
    least: 5,
    most: 20
  });
  // One category of one phase.
  expect(
    estimateCalls({ problemId: 'p', phase: 'problem_definition', category: 'control', variants: 3 }, CATEGORIES, 0)
  ).toEqual({
    least: 6,
    most: 9
  });
});
