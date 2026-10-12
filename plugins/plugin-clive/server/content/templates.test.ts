/**
 * The prompts nunjucks renders must match the Jinja2 originals byte for byte.
 *
 * `prompts.golden.json` is generated once from the Python implementation
 * (`clive-userflow/src/clive/prompts.py`) for the fixed fixture below. Any drift
 * in the templates, the context builders, or nunjucks' whitespace rules shows up
 * here as a diff against what the prototype actually sent a model.
 */
import { describe, expect, it } from 'vitest';
import { advisoryCriteria, failingGates } from '../criteria';
import { cut, isPerStep } from '../steps';
import { phaseDoc, rubricDoc } from './load';
import { renderHintPrompt, renderNudgePrompt, renderPhasePrompt, type ProblemForPrompt } from './templates';
import golden from './prompts.golden.json';

const PHASE_IDS = ['problem_definition', 'case_design', 'algorithm_design', 'implement'] as const;

const PROBLEM: ProblemForPrompt = {
  slug: 'fixture',
  title: 'Fixture',
  statement: 'Read a whole number n. Print the sum 1..n.',
  public_test_cases: [
    { input: '3', output: '6' },
    { input: '1', output: '1' }
  ],
  starter_code: '',
  reference_solution: ''
};

const ROW = { input: '4 6', output: '24', working: '4 * 6 = 24.' };

const PRIOR = [
  {
    label: 'Problem',
    fields: [
      { label: 'Summary', value: 'Print the sum from 1 to n.' },
      { label: 'Inputs', value: 'n: an int, 1 or more.' }
    ]
  }
];

const ARTIFACTS: Record<string, Record<string, unknown>> = {
  problem_definition: {
    summary: 'Print the sum from 1 to n.',
    inputs: 'n: an int, 1 or more.',
    outputs: 'The sum as an int.'
  },
  case_design: { normal_cases: [ROW] },
  algorithm_design: {
    steps: [
      { text: 'Read n.', level: 0 },
      { text: 'Set the total to 0.', level: 0 },
      { text: 'Add each number up to n to the total.', level: 0 },
      { text: 'Print the total.', level: 0 }
    ]
  },
  implement: { code: 'int main(void) { return 0; }' }
};

const VERDICTS = [
  { criterion_id: 'case_is_concrete', verdict: 'PASS' as const, evidence: '4 6', confidence: 'high' as const },
  { criterion_id: 'work_is_shown', verdict: 'FAIL' as const, evidence: '4 * 6 = 24.', confidence: 'high' as const },
  { criterion_id: 'outputs_are_correct', verdict: 'FAIL' as const, evidence: '', confidence: 'low' as const },
  {
    criterion_id: 'output_format_matches_statement',
    verdict: 'PASS' as const,
    evidence: '24',
    confidence: 'high' as const
  }
];

describe('prompt parity with the Jinja2 originals', () => {
  it('renders every phase user_template byte-for-byte', () => {
    for (const id of PHASE_IDS) {
      const phase = phaseDoc(id);
      const criteria = rubricDoc(id).criteria;
      const artifact = ARTIFACTS[id];
      const cutPhase = isPerStep(phase) ? cut(phase, artifact, criteria, 'normal_cases') : null;
      const rendered = renderPhasePrompt(cutPhase?.phase ?? phase, {
        problem: PROBLEM,
        artifact: cutPhase?.artifact ?? artifact,
        criteria: cutPhase?.criteria ?? criteria,
        attempt: 2,
        priorArtifacts: PRIOR
      });
      expect(rendered, id).toBe(golden.phase_user[id as keyof typeof golden.phase_user]);
    }
  });

  it('renders the single-shot phase template when there is nothing to carry', () => {
    for (const id of PHASE_IDS) {
      const phase = phaseDoc(id);
      const criteria = rubricDoc(id).criteria;
      const artifact = ARTIFACTS[id];
      const cutPhase = isPerStep(phase) ? cut(phase, artifact, criteria, 'normal_cases') : null;
      const rendered = renderPhasePrompt(cutPhase?.phase ?? phase, {
        problem: { ...PROBLEM, public_test_cases: [] },
        artifact: cutPhase?.artifact ?? artifact,
        criteria: cutPhase?.criteria ?? criteria,
        attempt: 2,
        priorArtifacts: []
      });
      expect(rendered, id).toBe(golden.phase_user_empty[id as keyof typeof golden.phase_user_empty]);
      expect(rendered, `${id} should carry no stray headings`).not.toMatch(
        /^PUBLIC TEST CASES$|^EARLIER PHASES$|^CONVERSATION SO FAR$/m
      );
    }
  });

  it('exposes the authored system prompts unchanged', () => {
    for (const id of PHASE_IDS) {
      expect(phaseDoc(id).system_prompt, id).toBe(golden.phase_system[id as keyof typeof golden.phase_system]);
    }
  });

  it('renders the hint template byte-for-byte', () => {
    const phase = phaseDoc('case_design');
    const criteria = rubricDoc('case_design').criteria;
    const rendered = renderHintPrompt({
      phase,
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      criteria: advisoryCriteria(criteria),
      attempt: 2,
      priorArtifacts: PRIOR,
      history: [{ role: 'hint', text: 'Look at the input shape.' }]
    });
    expect(rendered).toBe(golden.hint_user);
  });

  it('renders the nudge template byte-for-byte, evidence and no-evidence alike', () => {
    const phase = phaseDoc('case_design');
    const criteria = rubricDoc('case_design').criteria;
    const failures = failingGates(criteria, VERDICTS);
    expect(failures.map((f) => f.id)).toEqual(['work_is_shown', 'outputs_are_correct']);
    const rendered = renderNudgePrompt({
      phase,
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      failures,
      attempt: 2,
      priorArtifacts: PRIOR,
      history: [{ role: 'hint', text: 'Look at the input shape.' }]
    });
    expect(rendered).toBe(golden.nudge_user);
  });
});
