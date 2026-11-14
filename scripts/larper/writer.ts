/**
 * The larper call: one category, one phase, one answer.
 *
 * What matters is what the larper is not given: the rubric, the situations and the
 * reference solution. It reads what a student reads on the page -- the problem, the
 * phase's instructions and hints, its own earlier work -- plus a description of the
 * kind of student it is. A larper shown the rubric writes to the rubric
 * (`clive-userflow/src/clive/persona.py` has the same rule).
 *
 * The provider is called directly, not through `callModel`, so a larper call is
 * never logged or shown as one of CLive's own.
 */
import { z } from 'zod';
import { caseRows, fieldText, outlineRows, type PriorArtifact } from '../../plugins/plugin-clive/server/artifact';
import type { FieldDoc, PhaseDoc } from '../../plugins/plugin-clive/server/content/load';
import { jsonSchemaText } from '../../plugins/plugin-clive/server/content/schema';
import type { ProblemForPrompt } from '../../plugins/plugin-clive/server/content/templates';
import { getProvider, type Provider } from '../../plugins/plugin-clive/server/providers';
import type { Answer, Category, PhaseId } from './types';

const SYSTEM = `You are playing a first-year university student in an introductory C course (CCPROG1). The course has not covered arrays, structs or pointers.

You are working through one programming problem in a tutoring tool, one phase at a time. You will be told what kind of student you are for this answer. Write the answer exactly as that student would, with that student's gaps and mistakes left in. Do not fix them, do not hedge, and do not explain or comment on what you are doing.

Reply with one JSON object holding the fields asked for and nothing else.`;

const cell = z.union([z.string(), z.number()]);

/** The fields the larper fills in this phase. Cases is answered one case at a time: Case 1. */
function fieldsToWrite(phase: PhaseDoc): FieldDoc[] {
  return phase.judge === 'per_step' ? phase.artifact_fields.slice(0, 1) : phase.artifact_fields.filter((f) => !f.added);
}

export function answerSchema(phase: PhaseDoc): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const field of fieldsToWrite(phase)) {
    shape[field.id] =
      field.kind === 'cases'
        ? z.array(z.object({ input: cell, output: cell, working: cell })).min(1)
        : field.kind === 'steps'
          ? z.array(z.object({ text: z.string(), level: z.number().int().min(0).max(2) })).min(1)
          : z.string();
  }
  return z.strictObject(shape);
}

function describeField(field: FieldDoc): string {
  const shape =
    field.kind === 'cases'
      ? 'a list with one row: {"input": ..., "output": ..., "working": ...}'
      : field.kind === 'steps'
        ? 'a list of steps: {"text": ..., "level": 0, 1 or 2}, where level is how far the step is indented'
        : field.kind === 'code'
          ? 'a string holding your C code'
          : 'a string';
  return [
    `"${field.id}" (shown to you as "${field.label}"): ${shape}`,
    field.prompt ? `  The page asks: ${field.prompt.trim()}` : '',
    field.hint ? `  The page's hint: ${field.hint.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

export function larperPrompt(
  phase: PhaseDoc,
  problem: ProblemForPrompt,
  category: Category,
  prior: PriorArtifact[],
  variant: number
): { system: string; user: string } {
  const parts: string[] = [`THE PROBLEM: ${problem.title}`, problem.statement.trim()];
  if (problem.public_test_cases.length) {
    parts.push(
      'EXAMPLES GIVEN WITH THE PROBLEM',
      problem.public_test_cases.map((c) => `- input: ${c.input}  output: ${c.output}`).join('\n')
    );
  }
  if (problem.starter_code.trim()) parts.push('STARTER CODE', problem.starter_code.trim());
  if (prior.length) {
    parts.push(
      'YOUR OWN WORK FROM EARLIER PHASES',
      prior
        .map((p) => `${p.label}:\n${p.fields.map((f) => `- ${f.label}: ${fieldText(f.value)}`).join('\n')}`)
        .join('\n\n')
    );
  }
  parts.push(
    `THIS PHASE: ${phase.label}`,
    phase.task_description.trim(),
    'WHAT YOU FILL IN',
    fieldsToWrite(phase).map(describeField).join('\n\n'),
    'THE KIND OF STUDENT YOU ARE FOR THIS ANSWER',
    category.writes.trim(),
    `This is variant ${variant} of several answers of this kind. Write it differently from an obvious first try: other values, other wording, a different slip of the same kind.`
  );
  return { system: SYSTEM, user: parts.join('\n\n') };
}

/** The reply as the page would hold it: case cells as text, outline levels made valid. */
function normalise(phase: PhaseDoc, parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fieldsToWrite(phase)) {
    const value = parsed[field.id];
    out[field.id] = field.kind === 'cases' ? caseRows(value) : field.kind === 'steps' ? outlineRows(value) : value;
  }
  return out;
}

/** One answer from the larper. A reply that cannot be used comes back as an answer carrying `error`. */
export async function writeAnswer(
  phase: PhaseDoc,
  problem: ProblemForPrompt,
  problemId: string,
  category: Category,
  prior: PriorArtifact[],
  variant: number,
  provider?: Provider
): Promise<Answer> {
  const base: Answer = {
    problemId,
    phase: phase.phase as PhaseId,
    category: category.id,
    variant,
    artifact: {},
    writtenBy: 'larper'
  };
  try {
    const chosen = provider ?? getProvider();
    if (!chosen.hasApiKey()) throw new Error(`No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv}.`);
    const schema = answerSchema(phase);
    const { system, user } = larperPrompt(phase, problem, category, prior, variant);
    const result = await chosen.judgeJson({
      system,
      user,
      model: chosen.defaultModel,
      maxOutputTokens: 8000,
      effort: 'medium',
      schema,
      schemaText: jsonSchemaText(schema)
    });
    const parsed = schema.safeParse(result.parsed);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ...base,
        model: result.model,
        error: `The larper's reply could not be used: ${issue.path.join('.')}: ${issue.message}`
      };
    }
    return { ...base, model: result.model, artifact: normalise(phase, parsed.data) };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
