import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  FLUSH_INTERVAL_SECONDS,
  KEEPALIVE_LIMIT_BYTES,
  SNAPSHOT_INTERVAL_FRAMES,
  SessionHistoryTelemetryService
} from './sessionHistoryTelemetryService';
import type { Entry } from './telemetryHook';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const INTERVAL_MS = FLUSH_INTERVAL_SECONDS * 1000;

/** fetch's arguments: the request the service posts and how it posts it. */
type FetchArguments = [input: string | URL | Request, init?: RequestInit];
type FetchMock = Mock<FetchArguments, Promise<Response>>;

/** Exposes the protected callback so tests can emit entries directly. */
class TestSessionHistoryService extends SessionHistoryTelemetryService {
  /** What the editor would prove when asked; `undefined` models a mid-burst read. */
  public code: string | undefined = 'code';

  public emit(entry: Entry): void {
    this.telemetryCallback(entry);
  }

  protected override snapshotText(): string | undefined {
    return this.code;
  }
}

function postedEvents(fetchMock: FetchMock): unknown[] {
  const init = fetchMock.mock.calls[0][1];
  return JSON.parse(init?.body as string) as unknown[];
}

/** Events of the call at `index`, as posted. */
function eventsOfCall(fetchMock: FetchMock, index: number): unknown[] {
  const init = fetchMock.mock.calls[index][1];
  return JSON.parse(init?.body as string) as unknown[];
}

/** A window as far as the page lifecycle goes: `pagehide` on it, `visibilitychange` on its document. */
function fakeWindow() {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const window = Object.assign(new EventTarget(), { document });
  return {
    window: window as unknown as Window,
    hide: () => {
      document.visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    show: () => {
      document.visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    leave: () => window.dispatchEvent(new Event('pagehide'))
  };
}

describe('SessionHistoryTelemetryService', () => {
  let fetchMock: FetchMock;
  /** Every service a test built, so no poll outlives the test that started it. */
  let services: SessionHistoryTelemetryService[];

  const build = (): TestSessionHistoryService => {
    const service = new TestSessionHistoryService(SESSION_ID);
    services.push(service);
    return service;
  };

  beforeEach(() => {
    fetchMock = vi.fn<FetchArguments, Promise<Response>>().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    services = [];
  });

  afterEach(() => {
    for (const service of services) service.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('buffers entries until flush posts them to the session history in one batch', async () => {
    const service = build();

    service.record('TEXT_MODIFIED', { new: 'a' });
    service.record('RUN_ATTEMPT', { success: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await service.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/updateHistory');
    const events = postedEvents(fetchMock);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ session_id: SESSION_ID, type: 'TEXT_MODIFIED', data: { new: 'a' } });
    expect(events[1]).toMatchObject({ session_id: SESSION_ID, type: 'RUN_ATTEMPT', data: { success: false } });
    for (const event of events as { timestamp: string }[]) {
      expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
    }

    // The buffer is drained: a second flush has nothing to post.
    await service.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when flush is called with no buffered entries', async () => {
    const service = build();

    await service.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts entries that arrive after a flush on the next flush', async () => {
    const service = build();

    service.record('PING', {});
    await service.flush();
    service.record('PING', { second: true });
    await service.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(eventsOfCall(fetchMock, 1)).toMatchObject([
      { session_id: SESSION_ID, type: 'PING', data: { second: true } }
    ]);
  });

  it('drops the batch with a warning instead of throwing when the request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = build();
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    service.record('PING', {});
    await expect(service.flush()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('sends the buffer with keepalive when the page is hidden', () => {
    const service = build();
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('CLIVE_LIVE_RAW_TOGGLE', { on: true });
    page.hide();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
    expect(postedEvents(fetchMock)).toMatchObject([{ type: 'CLIVE_LIVE_RAW_TOGGLE', data: { on: true } }]);
  });

  it('sends the buffer with keepalive when the page is left', () => {
    const service = build();
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('PING', {});
    page.leave();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
  });

  it('ignores the page becoming visible', () => {
    const service = build();
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('PING', {});
    page.show();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a batch too large for keepalive without it', () => {
    const service = build();
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('TEXT_MODIFIED', { new: 'x'.repeat(KEEPALIVE_LIMIT_BYTES) });
    page.leave();

    // Over the browser's keepalive quota the request would be refused outright, so it goes as a plain one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBeFalsy();
    expect(postedEvents(fetchMock)).toHaveLength(1);
  });

  it('stops listening and sends what is left when the solve page goes away', () => {
    const service = build();
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('PING', {});
    service.unmountWindow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    service.record('PING', { later: true });
    page.leave();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts the buffered entries by itself once the interval elapses', async () => {
    vi.useFakeTimers();
    const service = build();

    service.emit({ type: 'TEXT_MODIFIED', data: { new: 'a' } });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedEvents(fetchMock)).toMatchObject([{ session_id: SESSION_ID, type: 'TEXT_MODIFIED' }]);
  });

  it('posts nothing while the queue is empty', async () => {
    vi.useFakeTimers();
    build();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stands down while a batch is still in flight, then posts what arrived after it', async () => {
    vi.useFakeTimers();
    let release: (_response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const service = build();

    service.emit({ type: 'PING', data: { first: true } });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    service.emit({ type: 'PING', data: { second: true } });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release({ ok: true } as Response);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(eventsOfCall(fetchMock, 1)).toMatchObject([{ data: { second: true } }]);
  });

  it('stops polling once disposed', async () => {
    vi.useFakeTimers();
    const service = build();
    service.dispose();

    service.emit({ type: 'PING', data: {} });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes a full-code checkpoint after every interval of frames', async () => {
    const service = build();

    for (let i = 0; i < SNAPSHOT_INTERVAL_FRAMES - 1; i += 1) service.emit({ type: 'PING', data: { i } });
    await service.flush();

    const batch = postedEvents(fetchMock) as { type: string; data: unknown }[];
    expect(batch).toHaveLength(SNAPSHOT_INTERVAL_FRAMES);
    expect(batch.at(-1)).toMatchObject({ type: 'CODE_SNAPSHOT', data: { submittedCode: 'code' } });

    // The counter restarted: the next group ends with its own checkpoint.
    for (let i = 0; i < SNAPSHOT_INTERVAL_FRAMES - 1; i += 1) service.emit({ type: 'PING', data: { i } });
    await service.flush();

    const second = eventsOfCall(fetchMock, 1) as { type: string; data: unknown }[];
    expect(second).toHaveLength(SNAPSHOT_INTERVAL_FRAMES);
    expect(second.at(-1)).toMatchObject({ type: 'CODE_SNAPSHOT', data: { submittedCode: 'code' } });
  });

  it('defers the checkpoint to the first frame the editor can prove', async () => {
    const service = build();
    service.code = undefined;

    // A burst spans the boundary: the document is ahead of the history, so it
    // must not be recorded here.
    for (let i = 0; i < SNAPSHOT_INTERVAL_FRAMES; i += 1) service.emit({ type: 'PING', data: { i } });
    await service.flush();

    const first = postedEvents(fetchMock) as { type: string }[];
    expect(first).toHaveLength(SNAPSHOT_INTERVAL_FRAMES);
    expect(first.every((event) => event.type === 'PING')).toBe(true);

    // The next frame is quiescent, so the deferred checkpoint follows it.
    service.code = 'late';
    service.emit({ type: 'PING', data: { i: SNAPSHOT_INTERVAL_FRAMES } });
    await service.flush();

    const second = eventsOfCall(fetchMock, 1) as { type: string; data: unknown }[];
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({ type: 'PING', data: { i: SNAPSHOT_INTERVAL_FRAMES } });
    expect(second[1]).toMatchObject({ type: 'CODE_SNAPSHOT', data: { submittedCode: 'late' } });
  });
});
