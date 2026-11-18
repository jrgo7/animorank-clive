/**
 * The prompts nunjucks renders must match the Jinja2 originals byte for byte.
 *
 * `prompts.golden.json` is generated once from the Python implementation
 * (`clive-userflow/src/clive/prompts.py`) for the fixed fixtures below. Any drift
 * in the templates, the context builders, or nunjucks' whitespace, escaping or
 * filter rules shows up here as a diff against what the prototype actually sent a
 * model — including the public test results the stuck ask is grounded in, and the
 * `truncate` Jinja uses on a long printed output.
 *
 * Except: the 2026-11-17 criteria review regenerated `phase_user`, `phase_user_empty`,
 * `phase_system` and `nudge_user` from this renderer, and the same day's shorter
 * phase wording regenerated `nudge_user` and the three `stuck_user*` entries, so those
 * entries match the prototype only once clive-userflow carries the same content.
 */
import { describe, expect, it } from 'vitest';
import { failingGates } from '../criteria';
import { compareCase, cut, isPerStep } from '../steps';
import { phaseDoc, rubricDoc } from './load';
import {
  renderNudgePrompt,
  renderPhasePrompt,
  renderStuckPrompt,
  type ProblemForPrompt,
  type PublicTestRun
} from './templates';
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
  reference_solution: '',
  functions: []
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
    criterion_id: 'worked_out_differently',
    verdict: 'PASS' as const,
    evidence: '24',
    confidence: 'high' as const
  }
];

const STUCK_STATEMENT = "I don't know what the program should print when the list is empty.";
const STUCK_HISTORY = [
  {
    statement: 'Is my input right?',
    feedback: 'Which value does the program read first?\nWhat type holds a score like 87.5?'
  }
];
/** Longer than 305 characters, so Jinja's `truncate(300, true, "…")` fires. */
const LONG_ACTUAL = `printed: ${'x'.repeat(400)}`;

const STUCK_TESTS_SOME_FAIL: PublicTestRun = {
  compiled: true,
  cases: [
    { input: '3', expected: '6', actual: '6', passed: true, status: 'ok' },
    { input: '1', expected: '1', actual: LONG_ACTUAL, passed: false, status: 'ok' },
    { input: '2', expected: '3', actual: '4', passed: true, status: 'timeout' }
  ],
  all_public_passed: false
};
const STUCK_TESTS_ALL_PASS: PublicTestRun = {
  compiled: true,
  cases: [{ input: '3', expected: '6', actual: '6', passed: true, status: 'ok' }],
  all_public_passed: true
};

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
    expect(rubricDoc('implement').criteria.every((c) => c.gate === 'advisory')).toBe(true);
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
      history: [
        { attempt: 1, situation: 'rule_not_worked', focus_id: 'work_is_shown', nudge: 'Look at the input shape.' }
      ]
    });
    expect(rendered).toBe(golden.nudge_user);
  });

  it('shows the nudge its earlier turns with their situation and requirement, and the phase id', () => {
    const phase = phaseDoc('case_design');
    const failures = failingGates(rubricDoc('case_design').criteria, VERDICTS);
    const base = { phase, problem: PROBLEM, artifact: ARTIFACTS.case_design, failures, attempt: 2, priorArtifacts: [] };
    const withHistory = renderNudgePrompt({
      ...base,
      history: [{ attempt: 1, situation: 'rule_not_worked', focus_id: 'work_is_shown', nudge: 'Which numbers?' }]
    });
    expect(withHistory).toContain('situation rule_not_worked, about [work_is_shown]: Which numbers?');
    expect(withHistory).toContain('(`case_design`)');
    expect(renderNudgePrompt({ ...base, history: [] })).not.toContain('CONVERSATION SO FAR');
  });

  it('renders the stuck template byte-for-byte with nothing else to go on', () => {
    const rendered = renderStuckPrompt({
      phase: phaseDoc('case_design'),
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      statement: STUCK_STATEMENT,
      priorArtifacts: [],
      history: []
    });
    expect(rendered).toBe(golden.stuck_user);
  });

  it('renders the stuck template with earlier work, earlier asks and the public test results', () => {
    const rendered = renderStuckPrompt({
      phase: phaseDoc('case_design'),
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      field: phaseDoc('case_design').artifact_fields.find((f) => f.id === 'normal_cases'),
      statement: STUCK_STATEMENT,
      priorArtifacts: PRIOR,
      history: STUCK_HISTORY,
      tests: STUCK_TESTS_SOME_FAIL
    });
    expect(rendered).toBe(golden.stuck_user_full);
    // The long printed output is truncated to Jinja's length, and `tojson` escapes the
    // ellipsis it ends with, as Python's `json.dumps` does.
    expect(rendered).toContain(`${LONG_ACTUAL.slice(0, 299)}\\u2026`);
  });

  it('says so when every public case passes', () => {
    const rendered = renderStuckPrompt({
      phase: phaseDoc('case_design'),
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      statement: STUCK_STATEMENT,
      priorArtifacts: [],
      history: [],
      tests: STUCK_TESTS_ALL_PASS
    });
    expect(rendered).toBe(golden.stuck_user_all_pass);
  });

  it('escapes non-ASCII the way Python’s json.dumps does', () => {
    const rendered = renderStuckPrompt({
      phase: phaseDoc('case_design'),
      problem: { ...PROBLEM, public_test_cases: [{ input: 'salamat, Juán', output: 'salamat, Juán' }] },
      artifact: ARTIFACTS.case_design,
      statement: 'Paano po ito?',
      priorArtifacts: [],
      history: []
    });
    // `JSON.stringify` would keep the á; `json.dumps(ensure_ascii=True)` escapes it.
    expect(rendered).toContain('- input: "salamat, Ju\\u00e1n" output: "salamat, Ju\\u00e1n"');
  });
});

describe('YOUR CASE 1, beside Case 2', () => {
  const CASE_2 = { input: '1 1', output: '1', working: '1 * 1 = 1.' };
  /** The heading itself: `worked_out_differently`'s guidance also names it, in quotes. */
  const HEADING = /^YOUR CASE 1$/m;

  /** One Cases step's prompt, rendered as the submit route renders it. */
  function casePrompt(artifact: Record<string, unknown>, step: string): string {
    const scoped = cut(phaseDoc('case_design'), artifact, rubricDoc('case_design').criteria, step);
    return renderPhasePrompt(scoped.phase, {
      problem: PROBLEM,
      artifact: scoped.artifact,
      criteria: scoped.criteria,
      attempt: 1,
      priorArtifacts: PRIOR,
      compareCase: compareCase(artifact, step)
    });
  }

  it('shows a Case 2 prompt the student’s Case 1, after EARLIER PHASES and before STUDENT ARTIFACT', () => {
    const prompt = casePrompt({ normal_cases: [ROW], edge_cases: [CASE_2] }, 'edge_cases');
    expect(prompt).toContain(
      [
        'YOUR CASE 1',
        "The student's own Case 1, shown so this case can be compared with it. Never quote it as evidence.",
        '- Input: 4 6',
        '- Expected output: 24',
        '- How I got it: 4 * 6 = 24.',
        '',
        'STUDENT ARTIFACT'
      ].join('\n')
    );
    expect(prompt.indexOf('EARLIER PHASES')).toBeLessThan(prompt.search(HEADING));
    // Case 2 is still the only case judged.
    const judged = prompt.slice(prompt.indexOf('STUDENT ARTIFACT'));
    expect(judged).toContain('Input: 1 1');
    expect(judged).not.toContain('Input: 4 6');
    expect(judged).toContain('[worked_out_differently]');
  });

  it('shows a Case 1 prompt no YOUR CASE 1', () => {
    expect(casePrompt({ normal_cases: [ROW], edge_cases: [CASE_2] }, 'normal_cases')).not.toMatch(HEADING);
  });

  it('shows a Case 2 prompt no YOUR CASE 1 when there is no Case 1 to show', () => {
    for (const normal_cases of [undefined, [], [{ input: '', output: '', working: '' }], ' ']) {
      expect(casePrompt({ normal_cases, edge_cases: [CASE_2] }, 'edge_cases'), String(normal_cases)).not.toMatch(
        HEADING
      );
    }
  });
});
