import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { findCategory, loadCategories } from './categories';

function temp(yaml: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'larper-categories-')), 'categories.yaml');
  fs.writeFileSync(file, yaml);
  return file;
}

const ONE = (extra: string) =>
  `problem_definition:\n  - id: control\n    name: Control\n    writes: A complete answer.\n${extra}`;

it('lists the categories of the team document, per phase', () => {
  const all = loadCategories();
  expect(all.problem_definition.map((c) => c.id)).toEqual([
    'control',
    'copied_from_summary',
    'proxy_type_words',
    'one_word',
    'no_type_named',
    'no_limits',
    'everything_wrong'
  ]);
  expect(all.case_design.map((c) => c.id)).toEqual([
    'control',
    'wrong_format',
    'abstract',
    'wrong_answer',
    'everything_wrong'
  ]);
  expect(all.algorithm_design.map((c) => c.id)).toEqual(['control', 'direct_syntax', 'copied_from_summary']);
  expect(all.implement.map((c) => c.id)).toEqual(['control', 'correct_ignores_plan', 'compile_error']);
});

it('every category says what the student writes, and none has an expectation yet', () => {
  for (const list of Object.values(loadCategories())) {
    for (const c of list) {
      expect(c.name).not.toBe('');
      expect(c.writes.length).toBeGreaterThan(40);
      expect(c.expect).toBeNull();
    }
  }
});

it('a phase the file leaves out has no categories', () => {
  expect(loadCategories(temp(ONE(''))).implement).toEqual([]);
});

it('refuses a category with no description', () => {
  expect(() => loadCategories(temp('problem_definition:\n  - id: control\n    name: Control\n'))).toThrow(/writes/);
});

it('refuses a repeated id in one phase', () => {
  expect(() => loadCategories(temp(ONE('  - id: control\n    name: Again\n    writes: Another answer.\n')))).toThrow(
    /control/
  );
});

it('refuses an unknown phase', () => {
  expect(() => loadCategories(temp('testing:\n  - id: a\n    name: A\n    writes: An answer.\n'))).toThrow(/testing/);
});

it('refuses an expectation that names a criterion the phase does not have', () => {
  expect(() => loadCategories(temp(ONE('    expect:\n      fails: [nope]\n')))).toThrow(/nope/);
});

it('refuses an expectation that names a situation the phase does not have', () => {
  expect(() => loadCategories(temp(ONE('    expect:\n      situations: [nope]\n')))).toThrow(/nope/);
});

it("loads an expectation in the phase's own terms", () => {
  const all = loadCategories(
    temp(ONE('    expect:\n      blocks: true\n      fails: [novel_wording]\n      situations: [copied_statement]\n'))
  );
  expect(findCategory(all, 'problem_definition', 'control')?.expect).toEqual({
    blocks: true,
    fails: ['novel_wording'],
    situations: ['copied_statement']
  });
  expect(findCategory(all, 'problem_definition', 'missing')).toBeUndefined();
});
