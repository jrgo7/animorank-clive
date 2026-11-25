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
 * phase wording regenerated `nudge_user`, so those entries match the prototype only
 * once clive-userflow carries the same content. The hint ladder (nudge v9) regenerated
 * `nudge_user` and `nudge_system` from this renderer again, and dropped the stuck
 * entries with `stuck.yaml`. Dropping the public test cases from every prompt before
 * Implement (2026-11-23: phases problem_definition v19, case_design v17,
 * algorithm_design v15, criteria case_design v12, nudge v10) regenerated the
 * Problem, Cases and Design entries and `nudge_user` from this renderer. Implement's
 * judge went on 2026-11-25 (AnimoRank's tests alone decide Implement), and its three
 * entries with it.
 */
import { describe, expect, it } from 'vitest';
import { failingGates } from '../criteria';
import { compareCase, cut, isPerStep } from '../steps';
import { phaseDoc, rubricDoc } from './load';
import {
  NUDGE_SYSTEM,
  renderCodeNudgePrompt,
  renderNudgePrompt,
  renderPhasePrompt,
  type ProblemForPrompt
} from './templates';
import golden from './prompts.golden.json';

/** The phases a judge decides; Implement is decided by AnimoRank's tests. */
const PHASE_IDS = ['problem_definition', 'case_design', 'algorithm_design'] as const;

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
  }
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

/** The nudge's requirement, as the submit route picks it: the first failing gate in rubric order. */
function focusOf(verdicts: Parameters<typeof failingGates>[1]) {
  return failingGates(rubricDoc('case_design').criteria, verdicts)[0];
}

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

  it('keeps no Implement judge prompt', () => {
    for (const entries of [golden.phase_user, golden.phase_user_empty, golden.phase_system]) {
      expect(Object.keys(entries)).toEqual([...PHASE_IDS]);
    }
  });

  it('renders the nudge template byte-for-byte', () => {
    const rendered = renderNudgePrompt({
      phase: phaseDoc('case_design'),
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      focus: focusOf(VERDICTS),
      level: 'hint',
      attempt: 2,
      priorArtifacts: PRIOR,
      history: [{ attempt: 1, level: 'hint', focus_id: 'work_is_shown', nudge: 'Look at the input shape.' }]
    });
    expect(rendered).toBe(golden.nudge_user);
  });

  it('exposes the nudge system prompt unchanged', () => {
    expect(NUDGE_SYSTEM).toBe(golden.nudge_system);
  });

  it('shows the nudge one requirement, the level, and only that requirement’s earlier feedback', () => {
    const rendered = renderNudgePrompt({
      phase: phaseDoc('case_design'),
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      focus: focusOf(VERDICTS),
      level: 'prompt',
      attempt: 3,
      priorArtifacts: [],
      history: [{ attempt: 2, level: 'hint', focus_id: 'work_is_shown', nudge: 'Which numbers?' }]
    });
    expect(rendered).toContain('REQUIREMENT TO WORK ON\n- [work_is_shown] ');
    expect(rendered).toContain('The judge quoted from the artifact: "4 * 6 = 24."');
    expect(rendered).toContain('LEVEL\nprompt\n');
    expect(rendered).toContain(
      'EARLIER FEEDBACK ON THIS REQUIREMENT\nOldest first.\n- attempt 2, hint: Which numbers?'
    );
    expect(rendered).toContain('(`case_design`)');
    // The other failing requirement, the old failure list and the old situations are gone.
    expect(rendered).not.toContain('[outputs_are_correct]');
    expect(rendered).not.toMatch(/WHAT DID NOT PASS|CONVERSATION SO FAR|situation /);
  });

  it('says when the judge quoted nothing, and leaves out the earlier-feedback block when there is none', () => {
    const noQuote = VERDICTS.map((v) => (v.criterion_id === 'work_is_shown' ? { ...v, verdict: 'PASS' as const } : v));
    const rendered = renderNudgePrompt({
      phase: phaseDoc('case_design'),
      problem: PROBLEM,
      artifact: ARTIFACTS.case_design,
      focus: focusOf(noQuote),
      level: 'hint',
      attempt: 2,
      priorArtifacts: [],
      history: []
    });
    expect(rendered).toContain('- [outputs_are_correct] ');
    expect(rendered).toContain('The judge quoted nothing from the artifact for this one.');
    expect(rendered).toContain(
      'The student sees this line just above your feedback: Work out the expected output for this input again.'
    );
    expect(rendered).toContain('LEVEL\nhint\n\nATTEMPT\nThis was submission 2 for this phase.');
    expect(rendered).not.toContain('EARLIER FEEDBACK ON THIS REQUIREMENT');
  });

  it('escapes non-ASCII the way Python’s json.dumps does', () => {
    // Code feedback is the one prompt that lists example cases, with `tojson`.
    const rendered = renderCodeNudgePrompt({
      problem: PROBLEM,
      code: 'int main(void) { return 0; }',
      run: {
        compiled: true,
        compilerOutput: '',
        cases: [{ input: 'salamat, Juán', expected: 'salamat, Juán', actual: '', passed: false }],
        hiddenFailed: 0
      },
      priorArtifacts: [],
      history: [],
      attempt: 1,
      level: 'hint'
    });
    // `JSON.stringify` would keep the á; `json.dumps(ensure_ascii=True)` escapes it.
    expect(rendered).toContain('input "salamat, Ju\\u00e1n", expected "salamat, Ju\\u00e1n"');
  });
});

describe('public test cases', () => {
  // The student is not shown the public tests until Implement (the page opens the
  // test-case window only there), so no prompt before Implement may list them: the
  // Cases judge would fail a case that happened to match one as "copied", and a
  // nudge could hand the student a test's input and output.
  const HEADING = /^PUBLIC TEST CASES$/m;

  it('are left out of the Problem, Cases and Design judges', () => {
    for (const id of PHASE_IDS) {
      const phase = phaseDoc(id);
      const criteria = rubricDoc(id).criteria;
      const cutPhase = isPerStep(phase) ? cut(phase, ARTIFACTS[id], criteria, 'normal_cases') : null;
      const rendered = renderPhasePrompt(cutPhase?.phase ?? phase, {
        problem: PROBLEM,
        artifact: cutPhase?.artifact ?? ARTIFACTS[id],
        criteria: cutPhase?.criteria ?? criteria,
        attempt: 1,
        priorArtifacts: []
      });
      expect(rendered, id).not.toMatch(HEADING);
    }
  });

  it('are left out of the nudge, at both levels', () => {
    for (const level of ['hint', 'prompt'] as const) {
      const rendered = renderNudgePrompt({
        phase: phaseDoc('case_design'),
        problem: PROBLEM,
        artifact: ARTIFACTS.case_design,
        focus: focusOf(VERDICTS),
        level,
        attempt: 2,
        priorArtifacts: PRIOR,
        history: []
      });
      expect(rendered, level).not.toMatch(HEADING);
      expect(rendered, level).not.toContain('- input: "3" output: "6"');
    }
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
