/**
 * The nudge call: one requirement, one rung of the hint ladder.
 *
 * Ported from `clive-userflow/src/clive/nudge.py` (the judged nudge) and reworked
 * for the hint ladder: the caller picks the requirement ({@link pickFocus}, the
 * first failing gate in rubric order) and the level (a failed submit always gets a
 * `hint`; "I'm stuck" asks for a `prompt` on that submission), and the model writes
 * that rung for that requirement alone. Its sibling for
 * Implement's code, `nudge_code`, lives in `codeNudge.ts`.
 *
 * Before a reply goes back it is checked for what it must never hold
 * ({@link findLeak}): a Cases case's expected output, or C code in Problem or
 * Design. A reply that leaks is asked for once more with a note naming the leak;
 * if that one leaks too, the nudge comes back empty and the page shows only the
 * requirement's own line.
 */
import { type PriorArtifact } from './artifact';
import { failingGates, type FailingCriterion } from './criteria';
import { JudgeError } from './content/errors';
import { NUDGE_DOC, type CriterionDoc, type PhaseDoc } from './content/load';
import { jsonSchemaText, NudgeSchema } from './content/schema';
import {
  renderNudgePrompt,
  NUDGE_SYSTEM,
  type HistoryTurn,
  type NudgeLevel,
  type ProblemForPrompt
} from './content/templates';
import type { Verdict } from './judge';
import { callModel } from './llmCalls';
import { normaliseOutput } from './program';
import { getProvider, type Provider } from './providers';
import type { CheckResult } from './referenceCheck';

export type { NudgeLevel };

export interface NudgeOutcome {
  level: NudgeLevel;
  focus_id: string;
  focus_text: string;
  /** The focused criterion's `not_met` line — the one the student sees just above the nudge. */
  focus_not_met: string;
  /** For the research log only: what the model thinks is behind the failure. */
  reason: string;
  /** What the student reads; empty when the leak check blocked both replies. */
  nudge: string;
  /** Every failing gating criterion, in rubric order — computed here, never taken from the model. */
  failing: { id: string; text: string }[];
  /** What the leak check found, one entry per reply that leaked; empty when none did. */
  leaks: string[];
  /** Whether both replies leaked, so the student got no nudge. */
  leak_blocked: boolean;
}

/**
 * The requirement a failed submit is about: the first failing gating criterion in
 * rubric order (`criteria` as applied, so a reference fallback's downgrade counts),
 * or null when nothing gating failed. Advisory criteria are never nudged.
 */
export function pickFocus(criteria: CriterionDoc[], verdicts: Verdict[]): FailingCriterion | null {
  return failingGates(criteria, verdicts)[0] ?? null;
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
  {
    pattern: /\b(?:int|float|double|char|long|short|unsigned|signed)\s+\**[A-Za-z_]\w*\s*=/,
    name: 'a C declaration'
  },
  { pattern: /[{}]/, name: 'braces' }
];

/** The phases whose nudges are checked for C code: Cases' working is arithmetic, and Implement has its own feedback. */
const CODE_CHECKED = new Set(['problem_definition', 'algorithm_design']);

/** The shortest expected output worth looking for: a single character turns up in too much ordinary text. */
const SHORTEST_OUTPUT = 2;

/**
 * Whether `text` holds `value` as a whole token: not inside a longer word or
 * number (24 is not in 240, 1.24 or 24.5), with any run of whitespace in the value
 * matching any run in the text, and letters matched in either case.
 */
function holdsToken(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\w]|\\d\\.)${escaped}(?![\\w]|\\.\\d)`, 'i').test(text);
}

/**
 * What `text` gives away, or null. In Cases, the reference's output for the case
 * being judged, when it is at least {@link SHORTEST_OUTPUT} characters and the
 * student has not already written it (a value they wrote and got right is theirs
 * to be asked about). In Problem and Design, anything that looks like C.
 */
export function findLeak(phaseId: string, text: string, referenceCheck: CheckResult | null | undefined): Leak | null {
  if (phaseId === 'case_design' && referenceCheck?.status === 'checked') {
    for (const row of referenceCheck.rows) {
      if (row.outcome !== 'wrong' && row.outcome !== 'missing_output') continue;
      const expected = normaliseOutput(row.actual ?? '').trim();
      if (expected.length < SHORTEST_OUTPUT) continue;
      if (holdsToken(text, expected)) {
        return { note: `the expected output for ${row.label}`, found: `${row.label} expected output "${expected}"` };
      }
    }
  }
  if (CODE_CHECKED.has(phaseId)) {
    for (const { pattern, name } of CODE_PATTERNS) {
      const match = text.match(pattern);
      if (match) return { note: `C code (${name}: "${match[0].trim()}")`, found: `C code: ${name}` };
    }
  }
  return null;
}

/** Added to the user message when a reply is asked for again, naming what the last one gave away. */
function leakNote(leak: Leak): string {
  return (
    `\n\nYOUR LAST REPLY GAVE SOMETHING AWAY\nIt contained ${leak.note}, which the student must work out ` +
    'themselves. Write the reply again at the same level without it.'
  );
}

interface NudgeRequest {
  phase: PhaseDoc;
  problem: ProblemForPrompt;
  artifact: Record<string, unknown>;
  /** The requirement to write about, with its verdict's evidence: {@link pickFocus}'s choice. */
  focus: FailingCriterion;
  /** Every failing gating criterion, in rubric order, for the page's count. */
  failing: FailingCriterion[];
  level: NudgeLevel;
  attempt?: number;
  priorArtifacts?: PriorArtifact[];
  /** Earlier turns on `focus` only, oldest first. */
  history?: HistoryTurn[];
  /** The submit's reference check: the leak check's source for a case's expected output. */
  referenceCheck?: CheckResult | null;
  provider?: Provider;
  /** What the live reasoning window calls this call; `nudge · <level>` by default. */
  liveLabel?: string;
}

export async function nudge(request: NudgeRequest): Promise<NudgeOutcome> {
  const { phase, focus, level } = request;

  // The nudge document pins no model, so the provider is chosen from the phase's own
  // model id -- that is the provider the judge just used, and it keeps the two halves of
  // one phase on one provider even when CLIVE_PROVIDER is unset.
  const chosen = request.provider ?? getProvider({ model: phase.model.id });
  if (!chosen.hasApiKey()) {
    throw new JudgeError(
      `No API key for provider '${chosen.name}'. Set ${chosen.apiKeyEnv} in the environment, ` +
        'then restart the server.'
    );
  }
  const user = renderNudgePrompt({
    phase,
    problem: request.problem,
    artifact: request.artifact,
    focus,
    level,
    attempt: request.attempt ?? 1,
    priorArtifacts: request.priorArtifacts ?? [],
    history: request.history ?? []
  });

  const ask = async (message: string) => {
    const result = await callModel(
      chosen,
      'nudge',
      {
        system: NUDGE_SYSTEM,
        user: message,
        model: chosen.defaultModel,
        maxOutputTokens: NUDGE_DOC.model?.max_output_tokens ?? 2000,
        effort: NUDGE_DOC.model?.effort ?? 'medium',
        schema: NudgeSchema,
        schemaText: jsonSchemaText(NudgeSchema)
      },
      request.liveLabel ?? `nudge · ${level}`
    );
    return NudgeSchema.parse(result.parsed);
  };

  const leaks: string[] = [];
  let reply = await ask(user);
  let leak = findLeak(phase.phase, reply.nudge, request.referenceCheck);
  if (leak) {
    leaks.push(leak.found);
    reply = await ask(user + leakNote(leak));
    leak = findLeak(phase.phase, reply.nudge, request.referenceCheck);
    if (leak) leaks.push(leak.found);
  }

  return {
    level,
    focus_id: focus.id,
    focus_text: focus.text,
    focus_not_met: focus.not_met ?? '',
    reason: reply.reason,
    nudge: leak ? '' : reply.nudge,
    failing: request.failing.map((c) => ({ id: c.id, text: c.text })),
    leaks,
    leak_blocked: leak !== null
  };
}
