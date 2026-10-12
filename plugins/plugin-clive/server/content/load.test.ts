/**
 * The YAML content loads and normalises as the prototype's readers do.
 */
import { describe, expect, it } from 'vitest';
import { HINT_DOC, JUDGE_JSON_SCHEMA, NUDGE_DOC, phaseDoc, rubricDoc } from './load';

describe('CLive content loading', () => {
  it('reads the four phase documents with their authored shape', () => {
    expect(phaseDoc('case_design').judge).toBe('per_step');
    expect(phaseDoc('case_design').layout).toBe('steps');
    expect(phaseDoc('case_design').artifact_fields.map((f) => f.id)).toEqual([
      'normal_cases',
      'edge_cases',
      'case_3',
      'case_4',
      'case_5'
    ]);
    expect(
      phaseDoc('case_design')
        .artifact_fields.filter((f) => f.added)
        .map((f) => f.id)
    ).toEqual(['case_3', 'case_4', 'case_5']);
    expect(phaseDoc('problem_definition').gate).toBe('criteria');
    expect(phaseDoc('implement').gate).toBe('tests');
    expect(phaseDoc('implement').artifact_fields.map((f) => f.kind)).toEqual(['code']);
    expect(phaseDoc('algorithm_design').artifact_fields.map((f) => f.kind)).toEqual(['steps']);
  });

  it('reads the four rubrics, defaulting an omitted gate to gating', () => {
    const implement = rubricDoc('implement');
    expect(implement.criteria).toHaveLength(4);
    expect(implement.criteria.every((c) => c.gate === 'advisory')).toBe(true);
    expect(implement.criteria.every((c) => c.fields === undefined)).toBe(true);

    const cases = rubricDoc('case_design');
    expect(cases.criteria).toHaveLength(4);
    expect(cases.criteria.find((c) => c.id === 'outputs_are_correct')?.check).toBe('reference');
    expect(cases.criteria.every((c) => (c.fields ?? []).includes('normal_cases'))).toBe(true);

    const problem = rubricDoc('problem_definition');
    expect(problem.criteria.filter((c) => c.gate === 'gating')).toHaveLength(4);
    expect(problem.criteria.filter((c) => c.gate === 'advisory')).toHaveLength(2);
  });

  it('reads the shared hint and nudge documents', () => {
    expect(HINT_DOC.system_prompt.length).toBeGreaterThan(0);
    expect(HINT_DOC.user_template).toContain('CRITERIA YOU MAY POINT AT');
    expect(NUDGE_DOC.user_template).toContain('WHAT DID NOT PASS');
  });

  it('reads the shipped output schema', () => {
    expect(JUDGE_JSON_SCHEMA).toMatchObject({ type: 'object' });
  });

  it('rejects an unknown phase', () => {
    expect(() => phaseDoc('nope')).toThrow(/Unknown CLive phase/);
    expect(() => rubricDoc('nope')).toThrow(/Unknown CLive phase/);
  });
});
