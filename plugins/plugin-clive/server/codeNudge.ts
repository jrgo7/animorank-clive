/**
 * The code nudge: a Run or Submit whose code did not pass, answered by the
 * situation the student is in (`content/base/nudge_code.yaml`), on the hint ladder.
 *
 * Ported from the prototype's `nudge.nudge_code` and extended with situations. It
 * runs on compile errors as well as on failing cases, and it is told only how many
 * hidden cases failed — `CodeRun` has no place for anything more.
 *
 * A failed run gets a `hint`; the student's "I'm stuck" asks for a `prompt` on that
 * run, with the situation and place the hint settled on fixed.
 */
import type { PriorArtifact } from './artifact';
import { JudgeError } from './content/errors';
import { NUDGE_CODE_DOC } from './content/load';
import { CodeNudgeSchema, jsonSchemaText } from './content/schema';
import {
  NUDGE_CODE_SYSTEM,
  renderCodeNudgePrompt,
  type CodeHistoryTurn,
  type NudgeLevel,
  type ProblemForPrompt
} from './content/templates';
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

/** One earlier reply about this code, at its level, for the repeat rule. */
export type CodeFeedbackTurn = CodeHistoryTurn;

export interface CodeFeedback {
  level: NudgeLevel;
  situation: string;
  summary: string;
  focus: string;
  /** What the student reads. */
  nudge: string;
}

export interface CodeNudgeRequest {
  problem: ProblemForPrompt;
  code: string;
  run: CodeRun;
  priorArtifacts: PriorArtifact[];
  /** Earlier replies about this code, oldest first, hints and prompts. */
  history: CodeFeedbackTurn[];
  attempt: number;
  level: NudgeLevel;
  /** For a prompt: the situation and place its hint settled on, which the prompt answers to. */
  fixed?: { situation: string; focus: string };
  provider?: Provider;
}

export async function codeNudge(request: CodeNudgeRequest): Promise<CodeFeedback> {
  const { run, level, fixed } = request;
  if (level === 'prompt' && !fixed) throw new JudgeError('A code prompt needs the situation and focus of its hint.');
  const chosen = request.provider ?? getProvider();
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, then restart the server.`
    );
  }
  const user = renderCodeNudgePrompt({
    problem: request.problem,
    code: request.code,
    run,
    priorArtifacts: request.priorArtifacts,
    history: request.history,
    attempt: request.attempt,
    level,
    fixed
  });
  const result = await callModel(
    chosen,
    'nudge_code',
    {
      system: NUDGE_CODE_SYSTEM,
      user,
      model: chosen.defaultModel,
      maxOutputTokens: NUDGE_CODE_DOC.model?.max_output_tokens ?? 8000,
      effort: NUDGE_CODE_DOC.model?.effort ?? 'medium',
      schema: CodeNudgeSchema,
      schemaText: jsonSchemaText(CodeNudgeSchema)
    },
    `code feedback · ${level}`
  );
  const reply = CodeNudgeSchema.parse(result.parsed);

  // A prompt answers to its hint's situation and place. A program that did not compile is
  // the syntax situation by rule, not by the model's reading of the code: a replay of
  // Avril's eight failing Runs had the model call each one far_from_plan and tell her to
  // empty the function, eight times over.
  const situation = fixed
    ? fixed.situation
    : run.compiled
      ? situationOr('implement', reply.situation)
      : 'syntax_following_plan';
  return {
    level,
    situation,
    summary: reply.summary,
    focus: fixed ? fixed.focus : reply.focus,
    nudge: reply.nudge
  };
}
