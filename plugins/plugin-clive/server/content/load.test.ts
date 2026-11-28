/**
 * The YAML content loads and normalises as the prototype's readers do.
 */
import { describe, expect, it } from 'vitest';
import * as load from './load';
import { NUDGE_CODE_DOC, NUDGE_DOC, JUDGE_JSON_SCHEMA, phaseDoc, rubricDoc } from './load';

describe('CLive content loading', () => {
  it('reads the three judged phase documents with their authored shape', () => {
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
    expect(phaseDoc('algorithm_design').artifact_fields.map((f) => f.kind)).toEqual(['steps']);
  });

  it('has no Implement judge: AnimoRank’s tests alone decide Implement', () => {
    expect(() => phaseDoc('implement')).toThrow(/Unknown CLive phase/);
    expect(() => rubricDoc('implement')).toThrow(/Unknown CLive phase/);
  });

  it('reads the three rubrics, defaulting an omitted gate to gating', () => {
    const cases = rubricDoc('case_design');
    expect(cases.criteria).toHaveLength(4);
    // Since criteria v15 the model judges outputs_are_correct, as a required criterion; nothing is computed.
    const outputs = cases.criteria.find((c) => c.id === 'outputs_are_correct');
    expect(outputs).toMatchObject({ gate: 'gating' });
    expect(outputs?.check).toBeUndefined();
    expect(cases.criteria.some((c) => c.check === 'reference')).toBe(false);
    // Every Cases criterion is judged on Case 1 but `worked_out_differently`, which compares Case 2 with it.
    const compared = cases.criteria.find((c) => c.id === 'worked_out_differently');
    expect(compared).toMatchObject({ gate: 'advisory', fields: ['edge_cases'] });
    const rest = cases.criteria.filter((c) => c !== compared);
    expect(rest.every((c) => (c.fields ?? []).includes('normal_cases'))).toBe(true);

    const problem = rubricDoc('problem_definition');
    expect(problem.criteria.filter((c) => c.gate === 'gating')).toHaveLength(5);
    expect(problem.criteria.filter((c) => c.gate === 'advisory')).toHaveLength(0);
  });

  it('reads the shared nudge document at v10: one requirement, a level, no situations, no public tests', () => {
    expect(NUDGE_DOC.version).toBe(10);
    expect(NUDGE_DOC.user_template).toContain('REQUIREMENT TO WORK ON');
    expect(NUDGE_DOC.user_template).toContain('LEVEL');
    expect(NUDGE_DOC.user_template).not.toContain('WHAT DID NOT PASS');
    expect(NUDGE_DOC.user_template).not.toContain('PUBLIC TEST CASES');
    expect(NUDGE_DOC.system_prompt).toContain('## Levels');
    expect(NUDGE_DOC.system_prompt).not.toContain('Decide the situation first');
  });

  it('reads the code nudge at v8: two levels, the five situations, a fixed situation for a prompt', () => {
    expect(NUDGE_CODE_DOC.version).toBe(8);
    expect(NUDGE_CODE_DOC.system_prompt).toContain('## Levels');
    for (const id of ['syntax_following_plan', 'departs_from_plan', 'plan_is_wrong', 'far_from_plan', 'other']) {
      expect(NUDGE_CODE_DOC.system_prompt, id).toContain(`\`${id}\``);
    }
    expect(NUDGE_CODE_DOC.system_prompt).toContain("does one of the plan's steps differently from what it says");
    expect(NUDGE_CODE_DOC.user_template).toContain('LEVEL');
    expect(NUDGE_CODE_DOC.user_template).toContain('SITUATION');
  });

  it('has no stuck document: the hint ladder replaced it', () => {
    expect('STUCK_DOC' in load).toBe(false);
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
    expect(outputs?.guidance).toContain('a correct value with wrong reasoning should pass');
  });
});

describe('code nudge doctrine', () => {
  it('forbids naming the step or rule that is wrong when the plan is wrong', () => {
    expect(NUDGE_CODE_DOC.system_prompt).toContain('never name a step number, a rule, or a condition from their plan');
    expect(NUDGE_CODE_DOC.system_prompt).toContain('say "your plan", never "step');
  });
});
