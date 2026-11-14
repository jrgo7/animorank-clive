import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { priorFor, readAnswers, readBaseline, requireBaseline, writeAnswers, writeBaseline } from './store';
import type { Answer } from './types';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'larper-store-'));

const ANSWER: Answer = {
  problemId: 'p1',
  phase: 'problem_definition',
  category: 'control',
  variant: 1,
  artifact: { summary: 's' },
  writtenBy: 'larper',
  model: 'm'
};

it('answers come back as they were written', () => {
  const dir = root();
  writeAnswers(dir, 'p1', 'problem_definition', [ANSWER, { ...ANSWER, variant: 2, writtenBy: 'hand' }]);
  expect(readAnswers(dir, 'p1', 'problem_definition')).toEqual([ANSWER, { ...ANSWER, variant: 2, writtenBy: 'hand' }]);
  expect(fs.existsSync(path.join(dir, 'answers/p1/problem_definition.json'))).toBe(true);
});

it('a phase with no saved answers has none', () => {
  expect(readAnswers(root(), 'p1', 'implement')).toEqual([]);
});

it('writing replaces the phase file with exactly what it is given', () => {
  const dir = root();
  writeAnswers(dir, 'p1', 'problem_definition', [ANSWER]);
  writeAnswers(dir, 'p1', 'problem_definition', [{ ...ANSWER, category: 'one_word' }]);
  expect(readAnswers(dir, 'p1', 'problem_definition').map((a) => a.category)).toEqual(['one_word']);
});

it('a baseline comes back as it was written, and a missing one is empty', () => {
  const dir = root();
  expect(readBaseline(dir, 'p1')).toEqual({});
  writeBaseline(dir, 'p1', { problem_definition: { summary: 's' } });
  expect(readBaseline(dir, 'p1')).toEqual({ problem_definition: { summary: 's' } });
});

it('the first phase has no earlier work', () => {
  expect(priorFor({}, 'problem_definition')).toEqual([]);
});

it('earlier work is carried forward as the page carries it, without empty fields', () => {
  expect(priorFor({ problem_definition: { summary: 's', inputs: 'i', outputs: '' } }, 'case_design')).toEqual([
    {
      label: 'Problem',
      fields: [
        { label: 'Summary', value: 's' },
        { label: 'Inputs', value: 'i' }
      ]
    }
  ]);
});

it('earlier phases come in phase order', () => {
  const prior = priorFor(
    {
      algorithm_design: { steps: [{ text: 'Read', level: 0 }] },
      case_design: { normal_cases: [{ input: '1', output: '1', working: 'w' }] },
      problem_definition: { summary: 's' }
    },
    'implement'
  );
  expect(prior.map((p) => p.label)).toEqual(['Problem', 'Cases', 'Design']);
});

it('a later phase without its earlier work says how to make it', () => {
  expect(() => priorFor({}, 'implement')).toThrow(/LARPER_BASELINE=1/);
  expect(() => priorFor({ problem_definition: { summary: 's' } }, 'algorithm_design')).toThrow(/case_design/);
});

it('a run is refused before it starts when a phase it will reach has no earlier work', () => {
  const baseline = { problem_definition: { summary: 's' } };
  expect(() => requireBaseline(baseline, ['problem_definition', 'case_design'])).not.toThrow();
  expect(() => requireBaseline(baseline, ['problem_definition', 'case_design', 'algorithm_design'])).toThrow(
    /LARPER_BASELINE=1/
  );
});

it('a saved file that is not valid JSON is named in the error', () => {
  const dir = root();
  writeAnswers(dir, 'p1', 'implement', []);
  fs.writeFileSync(path.join(dir, 'answers/p1/implement.json'), '[{,]');
  expect(() => readAnswers(dir, 'p1', 'implement')).toThrow(/implement\.json/);
});
