/**
 * The code nudge: a Run or Submit whose code did not pass, answered by the
 * situation the student is in (`content/base/nudge_code.yaml`), on the hint ladder.
 *
 * Ported from the prototype's `nudge.nudge_code` and extended with situations. It
 * runs on compile errors as well as on failing cases, and it is told only how many
 * hidden cases failed — `CodeRun` has no place for anything more.
 *
 * A failed run gets a `hint`; the student's "I'm stuck" asks for a `prompt` on that
 * run, with the situation and place the hint settled on fixed. Either reply is
 * checked for C the student did not write ({@link findCodeLeak}): one that holds some
 * is asked for once more with a note naming it, and if that one does too, the student
 * gets no reply text, only the summary and the focus.
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
  /** What the student reads; empty when the leak check held back both replies. */
  nudge: string;
  /** What the leak check found, one entry per reply that leaked; empty when none did. */
  leaks: string[];
  /** Whether both replies leaked, so the student got no reply text. */
  leak_blocked: boolean;
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

/** What a reply gave away: `note` is said to the model when it is asked again, `found` is logged. */
interface Leak {
  note: string;
  found: string;
}

/** C, as opposed to plain words: each with what the note calls it. */
const CODE_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /;[ \t]*$/m, name: 'a line ending in a semicolon' },
  { pattern: /\b(?:printf|scanf)\s*\(/, name: 'a printf or scanf call' },
  { pattern: /\b(?:for|while|if)\s*\(/, name: 'a C for, while or if' },
  { pattern: /%[-+#0]*\d*(?:\.\d+)?(?:hh|h|ll|l|L|z|j|t)?[diouxXfFeEgGcs]\b/, name: 'a format string' }
];

/** Code compared without its spacing: `for(i=0;` and `for (i = 0;` are the same line. */
const squeeze = (text: string) => text.replace(/\s+/g, '');

/**
 * The C a reply holds that the student did not write, or null. C means a line
 * ending in `;`, a `for (`, `while (`, `if (`, `printf(` or `scanf(`, or a
 * `%d`-style format string. Quoting the student's own code is allowed: a part in
 * backticks that appears in their program, or a line that is one of theirs.
 */
export function findCodeLeak(text: string, studentCode: string): Leak | null {
  const theirs = squeeze(studentCode);
  const isTheirs = (fragment: string) => squeeze(fragment) !== '' && theirs.includes(squeeze(fragment));
  const firstMatch = (fragment: string) => CODE_PATTERNS.find(({ pattern }) => pattern.test(fragment));
  const leak = (name: string, fragment: string): Leak => ({
    note: `C code the student did not write (${name}: "${fragment.trim()}")`,
    found: `C code: ${name}`
  });

  // A part in backticks is judged whole: theirs, or not.
  for (const [, quoted] of text.matchAll(/`([^`\n]+)`/g)) {
    const found = firstMatch(quoted);
    if (found && !isTheirs(quoted)) return leak(found.name, quoted);
  }
  // The rest line by line: a line that is code must be one of theirs.
  for (const line of text.split('\n')) {
    const outsideQuotes = line.replace(/`[^`\n]+`/g, ' ');
    const found = firstMatch(outsideQuotes);
    if (found && !isTheirs(line.replace(/`/g, ''))) return leak(found.name, outsideQuotes);
  }
  return null;
}

/** Added to the user message when a reply is asked for again, naming what the last one gave away. */
function leakNote(leak: Leak): string {
  return (
    `\n\nYOUR LAST REPLY GAVE SOMETHING AWAY\nIt contained ${leak.note}. Write the reply again at the same ` +
    'level without it: point to where to look without writing code. You may quote one of their own lines ' +
    'exactly as they wrote it, in backticks.'
  );
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
  const ask = async (message: string) => {
    const result = await callModel(
      chosen,
      'nudge_code',
      {
        system: NUDGE_CODE_SYSTEM,
        user: message,
        model: chosen.defaultModel,
        maxOutputTokens: NUDGE_CODE_DOC.model?.max_output_tokens ?? 8000,
        effort: NUDGE_CODE_DOC.model?.effort ?? 'medium',
        schema: CodeNudgeSchema,
        schemaText: jsonSchemaText(CodeNudgeSchema)
      },
      `code feedback · ${level}`
    );
    return CodeNudgeSchema.parse(result.parsed);
  };

  const leaks: string[] = [];
  let reply = await ask(user);
  let leak = findCodeLeak(reply.nudge, request.code);
  if (leak) {
    leaks.push(leak.found);
    reply = await ask(user + leakNote(leak));
    leak = findCodeLeak(reply.nudge, request.code);
    if (leak) leaks.push(leak.found);
  }

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
    nudge: leak ? '' : reply.nudge,
    leaks,
    leak_blocked: leak !== null
  };
}
