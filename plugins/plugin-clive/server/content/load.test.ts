/**
 * The YAML content loads and normalises as the prototype's readers do.
 */
import { describe, expect, it } from 'vitest';
import { NUDGE_DOC, STUCK_DOC, JUDGE_JSON_SCHEMA, phaseDoc, rubricDoc } from './load';

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

  it('reads the shared nudge and stuck documents', () => {
    expect(STUCK_DOC.system_prompt.length).toBeGreaterThan(0);
    expect(STUCK_DOC.user_template).toContain('STUDENT SAYS');
    expect(STUCK_DOC.user_template).toContain('PUBLIC TEST RESULTS');
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

describe('rubric fixes from round 6', () => {
  it('requires a Design plan that can be traced by hand on the student’s own case', () => {
    const traceable = rubricDoc('algorithm_design').criteria.find((c) => c.id === 'traceable_on_own_case');
    expect(traceable).toMatchObject({ gate: 'gating', fields: ['steps'] });
  });

  it('accepts plain words for a C type, and reads a function’s parameters as its inputs', () => {
    const inputTypes = rubricDoc('problem_definition').criteria.find((c) => c.id === 'input_types');
    expect(inputTypes?.guidance).toContain('integer');
    expect(inputTypes?.guidance).toContain('parameters');
  });

  it('never fails a correct expected output for its reasoning', () => {
    const outputs = rubricDoc('case_design').criteria.find((c) => c.id === 'outputs_are_correct');
    expect(outputs?.guidance).toContain('A correct value with wrong reasoning PASSes');
  });
});
