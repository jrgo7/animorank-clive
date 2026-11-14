import { expect, it } from 'vitest';
import { mergeAnswers, selectAnswers } from './run';
import type { Answer, Category } from './types';

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
