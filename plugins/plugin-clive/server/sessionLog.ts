/**
 * The research record: what each submission and escalation sent, what the model
 * was asked and answered, and what the student was shown — written by the server
 * into the practice session's history, beside the entries the page records.
 *
 * The counterpart of the prototype's `clive/studio/session_log.py`, which wrote
 * the same records to a JSONL file per participant. Field names follow its lines
 * (`phase_id`, `reference_check`, `latency_ms`, …) so an analysis of either reads
 * the same names.
 *
 * Some of what is written here is for the researcher only — the reference
 * check's rows hold the right output for every case, and a nudge's `reason`
 * (like a stuck ask's diagnosis before it) often names the answer. The instructor
 * session-logs page is the one reader
 * (`plugins/plugin-clive/windows/CLiveLogs.window.svelte`), and it shows them to
 * instructors; anything that reads these rows into a student-facing page must
 * leave these fields out. The server's own readers are {@link latestSubmitRecord} and
 * {@link latestCodeFeedbackRecord}, which escalations build from, and
 * {@link submissionEscalated}, which allows one escalation per submission; none of
 * them hands the page any of these fields.
 */
import { randomUUID } from 'node:crypto';
import type { JsonValue } from '@zenstackhq/orm';
import type { User } from '@auth/sveltekit';
import { db } from '$lib/zenstack';
import { PracticeSessionService } from '$lib/practiceSession/practiceSessionService';
import { ServerRegistryProvider } from '$lib/registry/server';
import type { LlmCall } from './llmCalls';

/** The entry types the server writes. The page writes the rest (`CLIVE_PROBLEM_LOAD`, `CLIVE_PHASE_OPEN`, …). */
export const SESSION_LOG_TYPES = {
  submit: 'CLIVE_SUBMIT',
  /** "I'm stuck": a failed submit's requirement, or a failed run's situation (`phase_id: 'implement'`), as a prompt. */
  escalate: 'CLIVE_ESCALATE',
  /** No longer written (the hint ladder replaced the stuck ask); sessions recorded before it still hold these. */
  stuck: 'CLIVE_STUCK',
  codeFeedback: 'CLIVE_CODE_FEEDBACK',
  llmCall: 'CLIVE_LLM_CALL',
  error: 'CLIVE_ERROR',
  logCheck: 'CLIVE_LOG_CHECK',
  participant: 'CLIVE_PARTICIPANT'
} as const;

/** Which route a model call served. Sessions recorded before the hint ladder also hold `stuck`. */
export type RequestKind = 'submit' | 'escalate' | 'code-feedback';

export interface SessionLogEntry {
  type: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

/** Whether `sessionId` is `userId`'s practice session on `problemId`: the only session a request may write into. */
export async function ownsPracticeSession(userId: string, sessionId: string, problemId: string): Promise<boolean> {
  const count = await db.practiceSession.count({
    where: { id: sessionId, student_id: userId, problem_id: problemId }
  });
  return count > 0;
}

/** Whether `sessionId` is one of `userId`'s practice sessions, on any problem. */
export async function ownsAnyPracticeSession(userId: string, sessionId: string): Promise<boolean> {
  return (await db.practiceSession.count({ where: { id: sessionId, student_id: userId } })) > 0;
}

/**
 * The key a session's participant tag is kept under in `extension_data`: its own
 * top-level key, which the page's saves (they merge top-level keys) never touch.
 */
export const PARTICIPANT_KEY = 'clive_participant';

/** Tag a practice session with the participant working in it. */
export async function tagParticipant(sessionId: string, participant: string): Promise<void> {
  const session = await db.practiceSession.findUnique({ where: { id: sessionId }, select: { extension_data: true } });
  const data = (session?.extension_data ?? {}) as Record<string, JsonValue>;
  await db.practiceSession.update({
    where: { id: sessionId },
    data: { extension_data: { ...data, [PARTICIPANT_KEY]: participant } }
  });
}

/**
 * A fresh practice session on the same problem, for the next participant at a
 * shared machine. Opening the problem goes to the newest session, so this one is
 * where they land; the earlier one is left exactly as it was.
 */
export async function startNextSession(userId: string, problemId: string): Promise<string | null> {
  const service = await ServerRegistryProvider.instance().getService(PracticeSessionService);
  const next = await service.create({ problemId, user: { id: userId } as User });
  return next?.id ?? null;
}

/** The answer to a log check, for the page that asked: the prototype's `session_log.check` shape. */
interface LogCheckResult {
  ok: boolean;
  /** The history the entry was written into — the practice session id, where the prototype named a file. */
  file: string;
  /** Why the check failed; empty when it passed. */
  error: string;
}

/**
 * Write a `CLIVE_LOG_CHECK` entry with a fresh nonce, then read it back. A
 * failed write is reported rather than thrown, so the page can tell a student
 * their session is not being recorded; nothing about it costs them the page.
 */
export async function checkSessionLog(sessionId: string): Promise<LogCheckResult> {
  const nonce = randomUUID();
  try {
    const written = await db.sessionHistoryEntry.create({
      data: {
        practice_session_id: sessionId,
        type: SESSION_LOG_TYPES.logCheck,
        data: { nonce },
        timestamp: new Date()
      },
      select: { id: true }
    });
    const read = await db.sessionHistoryEntry.findUnique({
      where: { id: written.id },
      select: { data: true }
    });
    const ok = (read?.data as { nonce?: unknown } | null)?.nonce === nonce;
    return {
      ok,
      file: sessionId,
      error: ok ? '' : 'The entry was written but could not be read back.'
    };
  } catch (error) {
    return { ok: false, file: sessionId, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The newest `CLIVE_SUBMIT` record this practice session holds for `phaseId` and
 * `step` (null for a phase judged all at once), or null when it holds none. An
 * escalation is built from this, never from verdicts or work the page sends.
 */
export async function latestSubmitRecord(
  sessionId: string,
  phaseId: string,
  step: string | null
): Promise<Record<string, unknown> | null> {
  const rows = await db.sessionHistoryEntry.findMany({
    where: { practice_session_id: sessionId, type: SESSION_LOG_TYPES.submit },
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    select: { data: true }
  });
  for (const row of rows) {
    const data = row.data as Record<string, unknown> | null;
    if (data && data.phase_id === phaseId && (data.step ?? null) === step) return data;
  }
  return null;
}

/**
 * Whether the newest `CLIVE_SUBMIT` for `phaseId` and `step` was already escalated:
 * a `CLIVE_ESCALATE` on the same phase, step and attempt, written after it. "I'm
 * stuck" gives one prompt per submission; a later submission may be escalated again.
 */
export async function submissionEscalated(
  sessionId: string,
  phaseId: string,
  step: string | null,
  attempt: number
): Promise<boolean> {
  const rows = await db.sessionHistoryEntry.findMany({
    where: {
      practice_session_id: sessionId,
      type: { in: [SESSION_LOG_TYPES.submit, SESSION_LOG_TYPES.escalate] }
    },
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    select: { type: true, data: true }
  });
  for (const row of rows) {
    const data = row.data as Record<string, unknown> | null;
    if (!data || data.phase_id !== phaseId || (data.step ?? null) !== step) continue;
    // Reached the submission itself: nothing after it escalated it.
    if (row.type === SESSION_LOG_TYPES.submit) return false;
    if (data.attempt === attempt) return true;
  }
  return false;
}

/** AnimoRank's own record of each Run and Submit (`src/lib/telemetry/hooks/execution.ts`), stamped by the page. */
const RUN_ATTEMPT = 'RUN_ATTEMPT';

/** The newest code feedback, and what has happened to the run it answered since. */
export interface CodeFeedbackStanding {
  /** The newest `CLIVE_CODE_FEEDBACK` record: the code, the run, and the hint it gave. */
  record: Record<string, unknown>;
  /** Whether an Implement `CLIVE_ESCALATE` on the same attempt was written after it. */
  escalated: boolean;
  /** Whether a Run or Submit after the one it answered passed every test. */
  passedSince: boolean;
}

/**
 * The newest `CLIVE_CODE_FEEDBACK` this practice session holds, or null when it holds
 * none: what "I'm stuck" in Implement builds its prompt from, never from code or
 * results the page sends.
 *
 * Whether a later run passed is read from AnimoRank's `RUN_ATTEMPT` entries, which
 * the page stamps with its own clock. So they are ordered among themselves, never
 * against the server's records: newest first, a run that passed every test counts
 * when it comes before the failing run whose code the feedback was about. A history
 * that does not hold that run yet counts nothing as passed.
 */
export async function latestCodeFeedbackRecord(sessionId: string): Promise<CodeFeedbackStanding | null> {
  const [newest] = await db.sessionHistoryEntry.findMany({
    where: { practice_session_id: sessionId, type: SESSION_LOG_TYPES.codeFeedback },
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { data: true, timestamp: true }
  });
  const record = newest?.data as Record<string, unknown> | null | undefined;
  if (!newest || !record) return null;

  const escalations = await db.sessionHistoryEntry.findMany({
    where: { practice_session_id: sessionId, type: SESSION_LOG_TYPES.escalate, timestamp: { gt: newest.timestamp } },
    select: { data: true }
  });
  const escalated = escalations.some((row) => {
    const data = row.data as Record<string, unknown> | null;
    return data?.phase_id === 'implement' && data.attempt === record.attempt;
  });

  const runs = await db.sessionHistoryEntry.findMany({
    where: { practice_session_id: sessionId, type: RUN_ATTEMPT },
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    select: { data: true }
  });
  let passed = false;
  for (const row of runs) {
    const run = (row.data ?? {}) as { runType?: unknown; submittedCode?: unknown; generalTestResults?: unknown };
    const results = Array.isArray(run.generalTestResults) ? run.generalTestResults : [];
    const allPassed = results.length > 0 && results.every((r) => r === true);
    if (allPassed) {
      passed = true;
    } else if (run.submittedCode === record.code && run.runType === record.run_type) {
      return { record, escalated, passedSince: passed };
    }
  }
  return { record, escalated, passedSince: false };
}

/** Write `entries` into the practice session's history, in one statement. */
export async function writeSessionLog(sessionId: string, entries: SessionLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.sessionHistoryEntry.createMany({
    data: entries.map((entry) => ({
      practice_session_id: sessionId,
      type: entry.type,
      data: entry.data as JsonValue,
      timestamp: entry.timestamp
    }))
  });
}

/**
 * One entry per model call, numbered within the request it served. Each is
 * stamped when its call finished, and always after the call before it, so the
 * history reads them in the order they were made even when two finish times
 * collide.
 */
export function llmCallEntries(during: RequestKind, calls: LlmCall[]): SessionLogEntry[] {
  let previous = -Infinity;
  return calls.map((call, index) => {
    previous = Math.max(Date.parse(call.started) + call.latency_ms, previous + 1);
    return {
      type: SESSION_LOG_TYPES.llmCall,
      data: { during, seq: index + 1, ...call },
      timestamp: new Date(previous)
    };
  });
}

/**
 * A request's entries: its model calls, then the record they led to, as the
 * prototype wrote them. The record is stamped now, or a millisecond after its
 * last call when that is later — a call's latency is rounded, and a record
 * written in the same millisecond would otherwise sort either side of it.
 */
export function requestEntries(
  during: RequestKind,
  calls: LlmCall[],
  record: { type: string; data: Record<string, unknown> }
): SessionLogEntry[] {
  const callEntries = llmCallEntries(during, calls);
  const lastCall = callEntries.at(-1)?.timestamp.getTime() ?? -Infinity;
  return [...callEntries, { ...record, timestamp: new Date(Math.max(Date.now(), lastCall + 1)) }];
}
