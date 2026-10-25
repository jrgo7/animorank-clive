import type { SessionLogEntry } from '$lib/analytics/sessionLogView';

/** One log event, with the model calls it served. */
export interface CliveLogEvent {
  entry: SessionLogEntry;
  calls: SessionLogEntry[];
}

/** A request whose calls never reached a record: the page was closed mid-request, say. */
const ORPHAN_CALLS = 'CLIVE_ORPHAN_CALLS';

/** The server's model-call entry; the other records name which request they served. */
const LLM_CALL = 'CLIVE_LLM_CALL';

/** The request a record's calls belong to. */
const SERVED_BY: Record<string, 'submit' | 'stuck' | 'code-feedback'> = {
  CLIVE_SUBMIT: 'submit',
  CLIVE_STUCK: 'stuck',
  CLIVE_CODE_FEEDBACK: 'code-feedback'
};

/**
 * An entry's `data` as an object. The column is JSON and could hold anything;
 * every reader here wants named fields, so anything else reads as empty.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Fold each model call into the record it served, as the prototype's
 * `_attach_calls` did. The server writes a request's calls immediately before
 * its record, but page events can land between the two, so a call is held until
 * a record for its own request turns up rather than going to the next entry.
 * Calls still held at the end are returned as one orphan entry.
 */
export function attachCalls(entries: SessionLogEntry[]): CliveLogEvent[] {
  // The page hands entries newest first; a session reads oldest first. Reversing
  // before the stable sort keeps same-millisecond entries in recorded order.
  const ordered = [...entries].reverse().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const events: CliveLogEvent[] = [];
  let held: SessionLogEntry[] = [];

  for (const entry of ordered) {
    if (entry.type === LLM_CALL) {
      held.push(entry);
      continue;
    }
    const data = asRecord(entry.data);
    const during =
      entry.type === 'CLIVE_ERROR'
        ? data.call === 'submit' || data.call === 'stuck' || data.call === 'code-feedback'
          ? data.call
          : null
        : (SERVED_BY[entry.type] ?? null);
    const calls = during ? held.filter((call) => asRecord(call.data).during === during) : [];
    if (during) held = held.filter((call) => asRecord(call.data).during !== during);
    events.push({ entry, calls });
  }

  if (held.length) {
    const first = held[0];
    events.push({
      entry: { id: ORPHAN_CALLS, type: ORPHAN_CALLS, timestamp: first.timestamp, data: null },
      calls: held
    });
  }
  return events;
}

/** An event's offset from the session's first entry, as the prototype's `+m:ss`. */
export function offsetLabel(timestamp: string, start: string | null): string {
  if (!start) return '';
  const seconds = Math.max(0, Math.round((Date.parse(timestamp) - Date.parse(start)) / 1000));
  return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * A field's value as text. Design's artifact is an outline of steps, so it is
 * numbered and indented as the judge read it; everything else is JSON, indented
 * so a long reply stays readable.
 */
export function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((row) => row && typeof row === 'object' && 'text' in (row as Record<string, unknown>))
  ) {
    const counts = [0, 0, 0];
    const roman = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
    return value
      .filter((row) => String((row as Record<string, unknown>).text ?? '').trim())
      .map((row) => {
        const level = Math.max(0, Math.min(2, Number((row as Record<string, unknown>).level) || 0));
        counts[level] += 1;
        for (let deeper = level + 1; deeper < 3; deeper += 1) counts[deeper] = 0;
        const index = counts[level];
        const label =
          level === 0
            ? `${index}.`
            : level === 1
              ? `${'abcdefghijklmnopqrstuvwxyz'[(index - 1) % 26]}.`
              : `${roman[index - 1] ?? index}.`;
        return `${'   '.repeat(level)}${label} ${String((row as Record<string, unknown>).text ?? '').trim()}`;
      })
      .join('\n');
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}
