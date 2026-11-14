import { expect, it } from 'vitest';
import { rubricDoc } from '../../plugins/plugin-clive/server/content/load';
import { csv, labelRows, NEEDS_EARLIER } from './labels';
import { PHASES, type PhaseId, type Result } from './types';

function result(over: Partial<Result>): Result {
  return {
    answer: {
      problemId: 'p',
      phase: 'problem_definition',
      category: 'no_type_named',
      variant: 2,
      artifact: { summary: 'It multiplies two sides.', inputs: 'the length, then the width', outputs: 'the area' },
      writtenBy: 'larper'
    },
    pass: 1,
    blocked: true,
    failed: ['input_types'],
    advisoryUnmet: [],
    situation: 'meaning_not_type',
    feedback: 'Can the length have decimals?',
    focusFields: ['inputs'],
    observed: {},
    offCategory: false,
    matches: null,
    record: {
      response: {
        verdicts: [
          {
            criterion_id: 'novel_wording',
            verdict: 'PASS',
            gate: 'gating',
            evidence: 'It multiplies',
            source: 'judge'
          },
          { criterion_id: 'input_types', verdict: 'FAIL', gate: 'gating', evidence: '', source: 'judge' },
          { criterion_id: 'output_form_exact', verdict: 'FAIL', gate: 'advisory', evidence: '', source: 'judge' }
        ]
      }
    },
    ms: 1,
    ...over
  };
}

it("the labelling sheet has the team's columns", () => {
  expect(labelRows('problem_definition', [result({})]).sheet[0]).toEqual([
    'Row ID',
    'Question',
    'Criterion',
    'Student artifact',
    'Label A',
    'Reason A',
    'Label B',
    'Reason B',
    'A and B agreement'
  ]);
});

it('there is one row per answer and criterion, showing the part of the answer the criterion is about', () => {
  const { sheet } = labelRows('problem_definition', [result({})]);
  expect(sheet.slice(1).map((r) => r.slice(0, 4))).toEqual([
    ['LP001', 'P1', 'novel_wording', 'It multiplies two sides.'],
    ['LP002', 'P2', 'input_types', 'the length, then the width'],
    ['LP003', 'P3', 'output_form_exact', 'the area']
  ]);
});

it('the labels and reasons are left blank, and agreement is worked out by the spreadsheet', () => {
  const { sheet } = labelRows('problem_definition', [result({})]);
  expect(sheet[1].slice(4, 8)).toEqual(['', '', '', '']);
  expect(sheet[1][8]).toBe('=IF(OR(E2="",G2=""),"",IF(E2=G2,"Agree","Disagree"))');
  expect(sheet[3][8]).toContain('E4=G4');
});

it("the labelling sheet says nothing of the category, CLive's verdict, or its feedback", () => {
  const text = JSON.stringify(labelRows('problem_definition', [result({})]).sheet);
  for (const hidden of ['no_type_named', 'PASS', 'FAIL', 'meaning_not_type', 'decimals', 'gating', 'advisory']) {
    expect(text).not.toContain(hidden);
  }
});

it('the key holds what the sheet leaves out, by the same row ids', () => {
  const { key } = labelRows('problem_definition', [result({})]);
  expect(key[0]).toEqual([
    'Row ID',
    'Phase',
    'Category',
    'Variant',
    'Criterion',
    'Required',
    'CLive verdict',
    'Decided by',
    'CLive evidence',
    'Situation',
    'Feedback'
  ]);
  expect(key[2]).toEqual([
    'LP002',
    'problem_definition',
    'no_type_named',
    '2',
    'input_types',
    'yes',
    'FAIL',
    'judge',
    '',
    'meaning_not_type',
    'Can the length have decimals?'
  ]);
  expect(key[3][5]).toBe('no');
});

it('rows are numbered through every answer of the phase', () => {
  const { sheet } = labelRows('problem_definition', [result({}), result({})]);
  expect(sheet.slice(1).map((r) => r[0])).toEqual(['LP001', 'LP002', 'LP003', 'LP004', 'LP005', 'LP006']);
});

it('a repeat, an errored row and a row CLive did not judge give no rows', () => {
  const rows = labelRows('problem_definition', [
    result({ pass: 2 }),
    result({ blocked: null, error: 'down', record: null }),
    result({ record: { situation: 'syntax_following_plan', nudge: 'x' } })
  ]);
  expect(rows.sheet).toHaveLength(1);
  expect(rows.key).toHaveLength(1);
});

it('a case is shown as input, output and working; code is shown whole', () => {
  const cases = result({
    answer: {
      problemId: 'p',
      phase: 'case_design',
      category: 'control',
      variant: 1,
      artifact: { normal_cases: [{ input: '4 6', output: '24', working: '4 * 6 = 24' }] },
      writtenBy: 'larper'
    },
    record: { response: { verdicts: [{ criterion_id: 'work_is_shown', verdict: 'PASS', gate: 'gating' }] } }
  });
  const row = labelRows('case_design', [cases]).sheet[1];
  expect(row.slice(0, 3)).toEqual(['LC001', 'C1', 'work_is_shown']);
  expect(row[3]).toContain('4 6');
  expect(row[3]).toContain('4 * 6 = 24');

  const code = result({
    answer: {
      problemId: 'p',
      phase: 'implement',
      category: 'control',
      variant: 1,
      artifact: { code: 'int x;' },
      writtenBy: 'larper'
    },
    record: { response: { verdicts: [{ criterion_id: 'readable', verdict: 'PASS', gate: 'advisory' }] } }
  });
  expect(labelRows('implement', [code]).sheet[1].slice(0, 4)).toEqual(['LI001', 'I1', 'readable', 'int x;']);
});

it('csv quotes what a spreadsheet would misread', () => {
  expect(csv([['a', 'b,c', 'say "hi"', 'two\nlines']])).toBe('﻿a,"b,c","say ""hi""","two\nlines"\r\n');
});

const PRIOR = [
  { label: 'Problem', fields: [{ label: 'Summary', value: 'EARLIER SUMMARY' }] },
  { label: 'Cases', fields: [{ label: 'Case 1', value: [{ input: '7 8', output: '56', working: '7 * 8 = 56' }] }] },
  { label: 'Design', fields: [{ label: 'Your steps', value: [{ text: 'Multiply the two sides', level: 0 }] }] }
];

it('a criterion judged against earlier work shows that work beside the answer', () => {
  const design = result({
    answer: {
      problemId: 'p',
      phase: 'algorithm_design',
      category: 'control',
      variant: 1,
      artifact: { steps: [{ text: 'Read both sides', level: 0 }] },
      writtenBy: 'larper'
    },
    record: {
      response: {
        verdicts: [
          { criterion_id: 'not_c_code', verdict: 'PASS', gate: 'gating' },
          { criterion_id: 'traceable_on_own_case', verdict: 'PASS', gate: 'gating' }
        ]
      }
    }
  });
  const { sheet } = labelRows('algorithm_design', [design], PRIOR);
  expect(sheet[1][3]).toBe('1. Read both sides');
  expect(sheet[2][3]).toMatch(/^Design:\n1\. Read both sides\n\nCases \(the student's earlier work\):\n/);
  expect(sheet[2][3]).toContain('7 * 8 = 56');
  expect(sheet[2][3]).not.toContain('EARLIER SUMMARY');
});

it('Implement criteria about the plan show the Design, and the one about cases shows the Cases', () => {
  const code = result({
    answer: {
      problemId: 'p',
      phase: 'implement',
      category: 'control',
      variant: 1,
      artifact: { code: 'int x;' },
      writtenBy: 'larper'
    },
    record: {
      response: {
        verdicts: ['follows_own_design', 'state_matches_design', 'handles_own_edge_cases', 'readable'].map(
          (criterion_id) => ({
            criterion_id,
            verdict: 'PASS',
            gate: 'advisory'
          })
        )
      }
    }
  });
  const cells = labelRows('implement', [code], PRIOR)
    .sheet.slice(1)
    .map((r) => r[3]);
  expect(cells[0]).toContain('Multiply the two sides');
  expect(cells[0]).not.toContain('7 * 8');
  expect(cells[1]).toContain('Multiply the two sides');
  expect(cells[2]).toContain('7 * 8 = 56');
  expect(cells[3]).toBe('int x;');
});

it('every criterion said to need earlier work is a real criterion, and names an earlier phase', () => {
  for (const [id, phases] of Object.entries(NEEDS_EARLIER)) {
    const home = PHASES.find((p) => rubricDoc(p).criteria.some((c) => c.id === id));
    expect(home, id).toBeDefined();
    for (const earlier of phases) expect(PHASES.indexOf(earlier)).toBeLessThan(PHASES.indexOf(home as PhaseId));
  }
});
