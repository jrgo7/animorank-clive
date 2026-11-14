import { expect, it } from 'vitest';
import { phaseDoc, rubricDoc } from '../../plugins/plugin-clive/server/content/load';
import type { ProblemForPrompt } from '../../plugins/plugin-clive/server/content/templates';
import type { Provider } from '../../plugins/plugin-clive/server/providers';
import { SITUATIONS } from '../../plugins/plugin-clive/server/situations';
import { loadCategories } from './categories';
import { PHASES, type Category } from './types';
import { answerSchema, larperPrompt, writeAnswer } from './writer';

const PROBLEM: ProblemForPrompt = {
  slug: 'fixture',
  title: 'Rectangle',
  statement: 'Read the length and width of a garden plot and print its area.',
  starter_code: '',
  public_test_cases: [{ input: '4 6', output: '24' }],
  reference_solution: 'SECRET_REFERENCE',
  functions: []
};

const CATEGORY: Category = {
  id: 'abstract',
  name: 'Abstract',
  writes: 'You describe the kind of values in words.',
  expect: null
};

function stub(reply: unknown | Error): Provider & { asked: { system: string; user: string }[] } {
  const asked: { system: string; user: string }[] = [];
  return {
    asked,
    name: 'fake',
    defaultModel: 'fake-model',
    apiKeyEnv: 'UNUSED',
    modelPrefixes: [],
    ownsModel: () => true,
    hasApiKey: () => true,
    judgeJson: async (options) => {
      asked.push({ system: options.system, user: options.user });
      if (reply instanceof Error) throw reply;
      return { parsed: reply, model: 'fake-model-1', inputTokens: 0, outputTokens: 0 };
    }
  };
}

it('never shows the larper the rubric or the situations', () => {
  const all = loadCategories();
  for (const phase of PHASES) {
    for (const category of all[phase]) {
      const { system, user } = larperPrompt(phaseDoc(phase), PROBLEM, category, [], 1);
      const text = system + user;
      for (const c of rubricDoc(phase).criteria) {
        expect(text, `${phase}/${category.id}: ${c.id}`).not.toContain(c.id);
        expect(text, `${phase}/${category.id}: ${c.text}`).not.toContain(c.text);
      }
      for (const s of SITUATIONS[phase]) {
        if (s !== 'other') expect(text, `${phase}/${category.id}: ${s}`).not.toContain(s);
      }
    }
  }
});

it('never shows the larper the reference solution', () => {
  const { system, user } = larperPrompt(phaseDoc('implement'), PROBLEM, CATEGORY, [], 1);
  expect(system + user).not.toContain('SECRET_REFERENCE');
});

it('the prompt carries the statement, the examples, what the page asks, the earlier work and the category', () => {
  const phase = phaseDoc('case_design');
  const prior = [{ label: 'Problem', fields: [{ label: 'Summary', value: 'It multiplies two sides.' }] }];
  const { user } = larperPrompt(phase, PROBLEM, CATEGORY, prior, 2);
  expect(user).toContain(PROBLEM.statement);
  expect(user).toContain('4 6');
  expect(user).toContain(phase.task_description.trim());
  expect(user).toContain(phase.artifact_fields[0].hint as string);
  expect(user).toContain('It multiplies two sides.');
  expect(user).toContain(CATEGORY.writes);
  expect(user).toMatch(/variant 2/i);
});

it('Cases asks for Case 1 only', () => {
  const schema = answerSchema(phaseDoc('case_design'));
  expect(schema.safeParse({ normal_cases: [{ input: '1 2', output: '2', working: 'w' }] }).success).toBe(true);
  expect(schema.safeParse({ normal_cases: [], edge_cases: [] }).success).toBe(false);
});

it('each phase asks for its own fields, in their own shapes', () => {
  expect(
    answerSchema(phaseDoc('problem_definition')).safeParse({ summary: 's', inputs: 'i', outputs: 'o' }).success
  ).toBe(true);
  expect(answerSchema(phaseDoc('algorithm_design')).safeParse({ steps: [{ text: 'Read', level: 0 }] }).success).toBe(
    true
  );
  expect(answerSchema(phaseDoc('algorithm_design')).safeParse({ steps: 'Read' }).success).toBe(false);
  expect(answerSchema(phaseDoc('implement')).safeParse({ code: 'int main(void) {}' }).success).toBe(true);
});

it('a reply of the wrong shape becomes an answer with an error', async () => {
  const provider = stub({ normal_cases: 'just text' });
  const a = await writeAnswer(phaseDoc('case_design'), PROBLEM, 'p', CATEGORY, [], 1, provider);
  expect(a.error).toMatch(/normal_cases/);
  expect(a.artifact).toEqual({});
  expect(a).toMatchObject({ problemId: 'p', phase: 'case_design', category: 'abstract', variant: 1 });
});

it('a provider that throws becomes an answer with an error', async () => {
  const a = await writeAnswer(phaseDoc('case_design'), PROBLEM, 'p', CATEGORY, [], 3, stub(new Error('out of credit')));
  expect(a.error).toContain('out of credit');
  expect(a.artifact).toEqual({});
  expect(a.variant).toBe(3);
});

it('a good reply is saved as the larper wrote it', async () => {
  const provider = stub({ normal_cases: [{ input: '3 5', output: 15, working: '3 * 5 = 15' }] });
  const a = await writeAnswer(phaseDoc('case_design'), PROBLEM, 'p', CATEGORY, [], 1, provider);
  expect(a.error).toBeUndefined();
  expect(a.artifact).toEqual({ normal_cases: [{ input: '3 5', output: '15', working: '3 * 5 = 15' }] });
  expect(a.writtenBy).toBe('larper');
  expect(a.model).toBe('fake-model-1');
  expect(provider.asked).toHaveLength(1);
});

it('outline steps keep their nesting, made valid', async () => {
  const provider = stub({
    steps: [
      { text: 'Read both sides', level: 0 },
      { text: 'Multiply them', level: 2 }
    ]
  });
  const a = await writeAnswer(phaseDoc('algorithm_design'), PROBLEM, 'p', CATEGORY, [], 1, provider);
  expect(a.artifact).toEqual({
    steps: [
      { text: 'Read both sides', level: 0 },
      { text: 'Multiply them', level: 1 }
    ]
  });
});
