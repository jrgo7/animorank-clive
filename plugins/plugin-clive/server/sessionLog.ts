/**
 * The research record: what each submission and stuck ask sent, what the model
 * was asked and answered, and what the student was shown — written by the server
 * into the practice session's history, beside the entries the page records.
 *
 * The counterpart of the prototype's `clive/studio/session_log.py`, which wrote
 * the same records to a JSONL file per participant. Field names follow its lines
 * (`phase_id`, `reference_check`, `latency_ms`, …) so an analysis of either reads
 * the same names.
 *
 * Some of what is written here is for the researcher only — the reference
 * check's rows hold the right output for every case, and a stuck ask's diagnosis
 * often names the answer. Nothing in the app reads `SessionHistoryEntry` back to
 * a page today; anything that ever does must leave these fields out.
 */
import type { JsonValue } from '@zenstackhq/orm';
import { db } from '$lib/zenstack';
import type { LlmCall } from './llmCalls';

/** The entry types the server writes. The page writes the rest (`CLIVE_PROBLEM_LOAD`, `CLIVE_PHASE_OPEN`, …). */
export const SESSION_LOG_TYPES = {
  submit: 'CLIVE_SUBMIT',
  stuck: 'CLIVE_STUCK',
  llmCall: 'CLIVE_LLM_CALL',
  error: 'CLIVE_ERROR'
} as const;

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
export function llmCallEntries(during: 'submit' | 'stuck', calls: LlmCall[]): SessionLogEntry[] {
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
  during: 'submit' | 'stuck',
  calls: LlmCall[],
  record: { type: string; data: Record<string, unknown> }
): SessionLogEntry[] {
  const callEntries = llmCallEntries(during, calls);
  const lastCall = callEntries.at(-1)?.timestamp.getTime() ?? -Infinity;
  return [...callEntries, { ...record, timestamp: new Date(Math.max(Date.now(), lastCall + 1)) }];
}
