/** The live reasoning feed: what a researcher's window reads while a call streams. */
import { describe, expect, it } from 'vitest';
import { callEnded, callStarted, eventsAfter, flushNow, reasoning, watching } from './liveFeed';

describe('live feed', () => {
  it('records a call’s start, its reasoning and its end for the session being watched', async () => {
    await watching('feed-1', async () => {
      const id = callStarted('nudge');
      reasoning(id, 'ab');
      reasoning(id, 'cd');
      flushNow();
      callEnded(id, { latency_ms: 10, output_tokens: 5, error: null });
    });
    const { events, last } = eventsAfter('feed-1', 0);
    expect(events.map((e) => e.kind)).toEqual(['start', 'reasoning', 'end']);
    expect(
      events
        .filter((e) => e.kind === 'reasoning')
        .map((e) => e.text)
        .join('')
    ).toBe('abcd');
    expect(last).toBeGreaterThanOrEqual(3);
    expect(eventsAfter('feed-1', last).events).toEqual([]);
  });

  it('records nothing outside a watched request', () => {
    const id = callStarted('judge');
    reasoning(id, 'hidden');
    callEnded(id, { latency_ms: 1, output_tokens: null, error: null });
    expect(eventsAfter('feed-unwatched', 0).events).toEqual([]);
  });
});
