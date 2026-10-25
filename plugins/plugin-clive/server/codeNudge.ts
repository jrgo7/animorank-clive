/**
 * The code nudge: a Run or Submit whose code did not pass, answered by the
 * situation the student is in (`content/base/nudge_code.yaml`).
 *
 * Ported from the prototype's `nudge.nudge_code` and extended with situations. It
 * runs on compile errors as well as on failing cases, and it is told only how many
 * hidden cases failed — `CodeRun` has no place for anything more.
 */
import type { PriorArtifact } from './artifact';
import { JudgeError } from './content/errors';
import { NUDGE_CODE_DOC } from './content/load';
import { CodeNudgeSchema, jsonSchemaText } from './content/schema';
import { NUDGE_CODE_SYSTEM, renderCodeNudgePrompt, type ProblemForPrompt } from './content/templates';
import { callModel } from './llmCalls';
import { getProvider, type Provider } from './providers';
import { situationOr } from './situations';

export interface CodeRun {
  compiled: boolean;
  /** What the compiler said; empty when the program compiled. */
  compilerOutput: string;
  /** The public cases only. */
  cases: { input: string; expected: string; actual: string; passed: boolean }[];
  hiddenFailed: number;
}

/** One earlier reply about this code, for the repeat rule. */
export interface CodeFeedbackTurn {
  situation: string;
  focus: string;
  nudge: string;
}

export interface CodeFeedback {
  situation: string;
  summary: string;
  focus: string;
  nudge: string;
}

export async function codeNudge(
  problem: ProblemForPrompt,
  code: string,
  run: CodeRun,
  priorArtifacts: PriorArtifact[],
  history: CodeFeedbackTurn[],
  attempt: number,
  provider?: Provider
): Promise<CodeFeedback> {
  const chosen = provider ?? getProvider();
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, then restart the server.`
    );
  }
  const user = renderCodeNudgePrompt({ problem, code, run, priorArtifacts, history, attempt });
  const result = await callModel(chosen, 'nudge_code', {
    system: NUDGE_CODE_SYSTEM,
    user,
    model: chosen.defaultModel,
    maxOutputTokens: NUDGE_CODE_DOC.model?.max_output_tokens ?? 8000,
    effort: NUDGE_CODE_DOC.model?.effort ?? 'medium',
    schema: CodeNudgeSchema,
    schemaText: jsonSchemaText(CodeNudgeSchema)
  });
  const parsed = CodeNudgeSchema.parse(result.parsed);
  return { ...parsed, situation: situationOr('implement', parsed.situation) };
}
