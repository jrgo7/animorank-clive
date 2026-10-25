/**
 * The live feed: a model's reasoning as it streams, for a researcher's window
 * (Ctrl+Shift+L). Ported from the prototype's `clive/live.py`.
 *
 * A route runs its work inside {@link watching}; every model call made inside
 * publishes its start, its reasoning (batched) and its end to an in-memory feed
 * for that practice session. Outside `watching` every function is a no-op. The
 * reasoning weighs criteria a student has not been shown, so it goes only to the
 * loopback-only routes that read this feed — never to the student page.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LiveEvent {
  seq: number;
  call: number;
  kind: 'start' | 'reasoning' | 'end';
  purpose?: string;
  text?: string;
  info?: { latency_ms: number; output_tokens: number | null; error: string | null };
  at: string;
}

/** Characters of reasoning kept per feed; the oldest whole events go first. */
const MAX_CHARS = 400_000;
/** Feeds kept; the least recently used goes first. */
const MAX_FEEDS = 16;
/** At most this often a call's buffered reasoning becomes an event. */
const BATCH_MS = 50;

interface Feed {
  events: LiveEvent[];
  chars: number;
  seq: number;
}

const feeds = new Map<string, Feed>();
const active = new AsyncLocalStorage<string>();
const pending = new Map<number, { session: string; text: string; timer: ReturnType<typeof setTimeout> | null }>();
let nextCall = 0;

function feedFor(session: string): Feed {
  let feed = feeds.get(session);
  if (feed) {
    feeds.delete(session);
  } else {
    feed = { events: [], chars: 0, seq: 0 };
  }
  feeds.set(session, feed);
  while (feeds.size > MAX_FEEDS) feeds.delete(feeds.keys().next().value as string);
  return feed;
}

function push(session: string, event: Omit<LiveEvent, 'seq' | 'at'>): void {
  const feed = feedFor(session);
  feed.seq += 1;
  feed.events.push({ ...event, seq: feed.seq, at: new Date().toISOString() });
  feed.chars += event.text?.length ?? 0;
  while (feed.chars > MAX_CHARS && feed.events.length > 1) {
    feed.chars -= feed.events.shift()?.text?.length ?? 0;
  }
}

/** Run `work` with its model calls published to `session`'s feed. */
export function watching<T>(session: string, work: () => Promise<T>): Promise<T> {
  return active.run(session, work);
}

/** A model call started; returns its id (0 when nothing is watching). */
export function callStarted(purpose: string): number {
  const session = active.getStore();
  if (!session) return 0;
  nextCall += 1;
  push(session, { call: nextCall, kind: 'start', purpose });
  pending.set(nextCall, { session, text: '', timer: null });
  return nextCall;
}

function flush(call: number): void {
  const p = pending.get(call);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  if (p.text) push(p.session, { call, kind: 'reasoning', text: p.text });
  p.text = '';
}

/** More reasoning for a call; published at most every {@link BATCH_MS}. */
export function reasoning(call: number, text: string): void {
  const p = pending.get(call);
  if (!p) return;
  p.text += text;
  p.timer ??= setTimeout(() => flush(call), BATCH_MS);
}

/** Publish every call's buffered reasoning now (for a test, or a call that ends). */
export function flushNow(): void {
  for (const call of pending.keys()) flush(call);
}

/** A model call ended. */
export function callEnded(call: number, info: NonNullable<LiveEvent['info']>): void {
  const p = pending.get(call);
  if (!p) return;
  flush(call);
  pending.delete(call);
  push(p.session, { call, kind: 'end', info });
}

/** Events after `after` for a session, and the newest seq to ask after next time. */
export function eventsAfter(session: string, after: number): { events: LiveEvent[]; last: number } {
  const feed = feeds.get(session);
  if (!feed) return { events: [], last: after };
  return { events: feed.events.filter((e) => e.seq > after), last: feed.seq };
}
