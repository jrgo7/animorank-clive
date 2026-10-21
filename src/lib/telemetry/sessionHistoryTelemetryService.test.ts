import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_LIMIT_BYTES, SessionHistoryTelemetryService } from './sessionHistoryTelemetryService';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function postedEvents(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as unknown[];
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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buffers entries until flush posts them to the session history in one batch', async () => {
    const service = new SessionHistoryTelemetryService(SESSION_ID);

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
    const service = new SessionHistoryTelemetryService(SESSION_ID);

    await service.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts entries that arrive after a flush on the next flush', async () => {
    const service = new SessionHistoryTelemetryService(SESSION_ID);

    service.record('PING', {});
    await service.flush();
    service.record('PING', { second: true });
    await service.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondEvents = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as unknown[];
    expect(secondEvents).toMatchObject([{ session_id: SESSION_ID, type: 'PING', data: { second: true } }]);
  });

  it('drops the batch with a warning instead of throwing when the request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new SessionHistoryTelemetryService(SESSION_ID);
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    service.record('PING', {});
    await expect(service.flush()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('sends the buffer with keepalive when the page is hidden', () => {
    const service = new SessionHistoryTelemetryService(SESSION_ID);
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('CLIVE_LIVE_RAW_TOGGLE', { on: true });
    page.hide();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
    expect(postedEvents(fetchMock)).toMatchObject([{ type: 'CLIVE_LIVE_RAW_TOGGLE', data: { on: true } }]);
  });

  it('sends the buffer with keepalive when the page is left', () => {
    const service = new SessionHistoryTelemetryService(SESSION_ID);
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('PING', {});
    page.leave();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
  });

  it('ignores the page becoming visible', () => {
    const service = new SessionHistoryTelemetryService(SESSION_ID);
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('PING', {});
    page.show();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a batch too large for keepalive without it', () => {
    const service = new SessionHistoryTelemetryService(SESSION_ID);
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
    const service = new SessionHistoryTelemetryService(SESSION_ID);
    const page = fakeWindow();
    service.attachWindow(page.window);

    service.record('PING', {});
    service.unmountWindow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    service.record('PING', { later: true });
    page.leave();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
