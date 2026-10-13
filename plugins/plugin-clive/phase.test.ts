/**
 * The client-side artifact and step logic, ported from
 * `clive-userflow/src/clive/studio/static/student.html` and matched against the
 * server's `prompts.py` renderers.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIVE_WINDOW_KEYS,
  IMPLEMENT_PHASE,
  IMPLEMENT_WINDOW_KEY,
  IMPLEMENT_WINDOW_KEYS,
  PHASES,
  blankValueFor,
  duplicateOf,
  inPlay,
  isFilled,
  markersFor,
  maxAdded,
  normaliseOutline,
  outlineText,
  parseOutline,
  rowsOf,
  solveLayoutKeys,
  stepComplete,
  type ArtifactField,
  type CaseRow,
  type PhaseConfig
} from './windows/phase';

const case_design = PHASES[1];
const problem = PHASES[0];

const text = (id: string, rows = 4): ArtifactField => ({ id, label: id, kind: 'text', rows });

describe('outline rows', () => {
  it('parses numbered and indented text back to rows, and renders them the same way', () => {
    const rows = parseOutline('1. Read n.\n   a. note it\n2. Print n.');
    expect(rows).toEqual([
      { text: 'Read n.', level: 0 },
      { text: 'note it', level: 1 },
      { text: 'Print n.', level: 0 }
    ]);
    expect(outlineText(rows)).toBe('1. Read n.\n   a. note it\n2. Print n.');
  });

  it('clamps a level to one deeper than the step before it', () => {
    expect(normaliseOutline([{ text: 'deep', level: 2 }])[0].level).toBe(0);
    expect(
      normaliseOutline([
        { text: 'a', level: 0 },
        { text: 'b', level: 2 }
      ])[1].level
    ).toBe(1);
  });

  it('marks each level and restarts under a parent', () => {
    expect(
      markersFor([
        { text: 'a', level: 0 },
        { text: 'b', level: 1 },
        { text: 'c', level: 1 },
        { text: 'd', level: 0 }
      ])
    ).toEqual(['1.', 'a.', 'b.', '2.']);
  });
});

describe('values', () => {
  it('keeps a legacy free-text case value as one row’s working', () => {
    expect(rowsOf('typed by hand')).toEqual([{ input: '', output: '', working: 'typed by hand' }]);
    expect(rowsOf(undefined)).toEqual([{ input: '', output: '', working: '' }]);
  });

  it('starts each field kind from the right blank', () => {
    expect(blankValueFor(text('summary'), 'starter')).toBe('');
    expect(blankValueFor({ id: 'code', label: 'c', kind: 'code' }, 'starter')).toBe('starter');
    expect(blankValueFor({ id: 'c1', label: 'c', kind: 'cases' }, '')).toEqual([
      { input: '', output: '', working: '' }
    ]);
    expect(blankValueFor({ id: 's', label: 's', kind: 'steps' }, '')).toEqual([{ text: '', level: 0 }]);
  });

  it('reads filled for each kind', () => {
    expect(isFilled('  x ')).toBe(true);
    expect(isFilled('   ')).toBe(false);
    expect(isFilled([{ input: '', output: '', working: 'work' }])).toBe(true);
    expect(isFilled([{ text: ' ', level: 0 }])).toBe(false);
  });

  it('needs a case’s output and working before it can be judged, but not its input', () => {
    const field: ArtifactField = { id: 'c', label: 'Case 1', kind: 'cases' };
    const row = (over: Partial<CaseRow>): CaseRow[] => [{ input: '', output: '', working: '', ...over }];
    expect(stepComplete(field, row({ output: '24', working: '4*6' }))).toBe(true);
    expect(stepComplete(field, row({ input: '4 6', output: '24' }))).toBe(false);
    expect(stepComplete(text('summary'), 'x')).toBe(true);
  });
});

describe('steps', () => {
  it('shows the required fields, then only the added cases actually added', () => {
    expect(inPlay(case_design, 0).map((f) => f.id)).toEqual(['normal_cases', 'edge_cases']);
    expect(inPlay(case_design, 2).map((f) => f.id)).toEqual(['normal_cases', 'edge_cases', 'case_3', 'case_4']);
    expect(maxAdded(case_design)).toBe(3);
  });

  it('flags a case whose input repeats an earlier in-play case, whitespace aside', () => {
    const artifact = {
      normal_cases: [{ input: '4 6', output: '24', working: 'x' }],
      edge_cases: [{ input: ' 4   6 ', output: '24', working: 'y' }]
    };
    const fields = inPlay(case_design, 0);
    expect(duplicateOf(case_design, artifact, fields[1], 0)?.id).toBe('normal_cases');
    expect(duplicateOf(case_design, artifact, fields[0], 0)).toBeNull();

    const distinct = { ...artifact, edge_cases: [{ input: '1 1', output: '1', working: 'y' }] };
    expect(duplicateOf(case_design, distinct, fields[1], 0)).toBeNull();
  });

  it('never flags a duplicate outside a per-step cases phase', () => {
    const artifact = { summary: 'x', inputs: 'y', outputs: 'z' };
    expect(duplicateOf(problem, artifact, problem.artifactFields[0], 0)).toBeNull();
    expect(duplicateOf(case_design as PhaseConfig, {}, text('summary'), 0)).toBeNull();
  });
});

describe('solve-page layout', () => {
  it('keeps only CLive’s own windows outside the Implement phase', () => {
    expect(solveLayoutKeys('problem_definition')).toEqual(CLIVE_WINDOW_KEYS);
    expect(solveLayoutKeys('case_design')).toEqual(CLIVE_WINDOW_KEYS);
    expect(CLIVE_WINDOW_KEYS).toContain('clive:track');
    expect(CLIVE_WINDOW_KEYS).toContain('clive:implement');
    expect(CLIVE_WINDOW_KEYS).not.toContain('code_editor');
  });

  it('keeps the editor and the test-case results only in the Implement phase', () => {
    expect(solveLayoutKeys(IMPLEMENT_PHASE)).toEqual([...CLIVE_WINDOW_KEYS, ...IMPLEMENT_WINDOW_KEYS]);
    expect(IMPLEMENT_WINDOW_KEYS).toEqual(['code_editor', 'test_cases']);
    expect(IMPLEMENT_WINDOW_KEY).toBe('clive:implement');
  });
});
