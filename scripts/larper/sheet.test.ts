import { expect, it } from 'vitest';
import { jsonLines, sheet } from './sheet';
import type { Answer, Category, Result } from './types';

const CATEGORIES: Category[] = [
  { id: 'control', name: 'Control', writes: 'w', expect: null },
  {
    id: 'copied_from_summary',
    name: 'Copied From Summary',
    writes: 'w',
    expect: { blocks: true, fails: ['novel_wording'], situations: ['copied_statement'] }
  }
];

const answer = (category: string, variant: number, artifact: Record<string, unknown>): Answer => ({
  problemId: 'p',
  phase: 'problem_definition',
  category,
  variant,
  artifact,
  writtenBy: 'larper'
});

function result(over: Partial<Result> & { answer: Answer }): Result {
  return {
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
    ms: 1200,
    ...over
  };
}

const COPIED = (variant: number, situation: string, matches: boolean) =>
  result({
    answer: answer('copied_from_summary', variant, {
      summary: 'Read two numbers.',
      inputs: 'two ints',
      outputs: 'an int'
    }),
    blocked: true,
    failed: ['novel_wording'],
    advisoryUnmet: ['input_order_stated'],
    situation,
    feedback: 'How would you say it\nto a classmate?',
    focusFields: ['summary'],
    matches
  });

const RESULTS: Result[] = [
  result({ answer: answer('control', 1, { summary: 'It multiplies.', inputs: 'int a', outputs: 'int' }) }),
  COPIED(1, 'copied_statement', true),
  COPIED(2, 'copied_statement', true),
  COPIED(3, 'other', false)
];

it("shows each category under the team's name, in the file's order", () => {
  const text = sheet('problem_definition', CATEGORIES, RESULTS, []);
  expect(text.indexOf('## Control')).toBeGreaterThan(-1);
  expect(text.indexOf('## Copied From Summary')).toBeGreaterThan(text.indexOf('## Control'));
});

it('says when an expectation is not decided, and states one that is', () => {
  const text = sheet('problem_definition', CATEGORIES, RESULTS, []);
  expect(text).toContain('Expected: not decided yet');
  expect(text).toContain('Expected: blocks; unmet: novel_wording; situation: copied_statement');
});

it('shows what the student wrote, what failed, the situation and the feedback', () => {
  const text = sheet('problem_definition', CATEGORIES, RESULTS, []);
  expect(text).toContain('Read two numbers.');
  expect(text).toContain('Blocked: yes');
  expect(text).toContain('Blocked: no');
  expect(text).toContain('Failed: novel_wording');
  expect(text).toContain('Optional points unmet: input_order_stated');
  expect(text).toContain('Situation: copied_statement');
  expect(text).toContain('> How would you say it\n> to a classmate?');
});

it('marks a match only where there is an expectation', () => {
  const text = sheet('problem_definition', CATEGORIES, RESULTS, []);
  expect(text.match(/✓/g)).toHaveLength(2);
  expect(text.match(/✗/g)).toHaveLength(1);
});

it('the summary counts what was blocked and which situations were seen', () => {
  const text = sheet('problem_definition', CATEGORIES, RESULTS, []);
  expect(text).toContain('| Control | 1 | 0 | none | 0 |');
  expect(text).toContain('| Copied From Summary | 3 | 3 | copied_statement ×2, other ×1 | 0 |');
});

it('an errored row is shown as an error and the others still render', () => {
  const broken = result({ answer: answer('control', 2, {}), blocked: null, error: 'provider down' });
  const text = sheet('problem_definition', CATEGORIES, [...RESULTS, broken], []);
  expect(text).toContain('ERROR: provider down');
  expect(text).toContain('Situation: copied_statement');
});

it('an off-category row and a repeat are marked', () => {
  const off = result({
    answer: { ...answer('control', 1, { code: 'int main(void) {}' }), phase: 'implement' },
    offCategory: true,
    observed: { compiled: false, publicPassed: false }
  });
  const text = sheet('implement', [CATEGORIES[0]], [off, { ...off, pass: 2 }], []);
  expect(text).toContain('off-category');
  expect(text).toContain('(repeat)');
  // The repeat is the same answer again: it is not printed twice.
  expect(text.match(/```c/g)).toHaveLength(1);
  expect(text).toContain('Compiled: no; examples passed: no');
  expect(text).toContain('```c\nint main(void) {}\n```');
});

it('cases and outlines are shown as the student would see them', () => {
  const cases = result({
    answer: {
      ...answer('control', 1, { normal_cases: [{ input: '4 6', output: '24', working: '4 * 6 = 24' }] }),
      phase: 'case_design'
    }
  });
  expect(sheet('case_design', [CATEGORIES[0]], [cases], [])).toMatch(/Input: 4 6\s+Output: 24\s+Working: 4 \* 6 = 24/);
  const steps = result({
    answer: {
      ...answer('control', 1, {
        steps: [
          { text: 'Read both', level: 0 },
          { text: 'Multiply', level: 1 }
        ]
      }),
      phase: 'algorithm_design'
    }
  });
  expect(sheet('algorithm_design', [CATEGORIES[0]], [steps], [])).toContain('1. Read both\n   a. Multiply');
});

it('a category with no results says so', () => {
  expect(sheet('problem_definition', CATEGORIES, [RESULTS[0]], [])).toMatch(/## Copied From Summary[\s\S]*no answers/);
});

it('answers of a category no longer in the file are listed as skipped, not as errors', () => {
  const text = sheet('problem_definition', CATEGORIES, RESULTS, ['old_category']);
  expect(text).toMatch(/Skipped[\s\S]*old_category/);
  expect(text).not.toContain('ERROR');
});

it('every result is one line of JSON', () => {
  const lines = jsonLines(RESULTS).trim().split('\n');
  expect(lines).toHaveLength(4);
  expect(JSON.parse(lines[1]).answer.category).toBe('copied_from_summary');
});

it('a hand-written answer with nothing in it is an errored row, not a crash', () => {
  const empty = result({
    answer: { ...answer('control', 9, {}), artifact: undefined as unknown as Record<string, unknown> },
    blocked: null,
    error: 'no artifact'
  });
  expect(sheet('problem_definition', CATEGORIES, [empty], [])).toContain('ERROR: no artifact');
});
