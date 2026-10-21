import type { Entry } from './telemetryHook';
import { TelemetryService } from './telemetryService';

/** A collated entry plus the moment it was captured. */
interface PendingEntry {
  entry: Entry;
  timestamp: Date;
}

interface FlushOptions {
  /**
   * Send so the request outlives the page: for a flush made as the page is hidden
   * or closed, when an ordinary request would be cancelled with it.
   */
  keepalive?: boolean;
}

/**
 * The largest batch sent with `keepalive`. Browsers refuse a keepalive request
 * once the bodies of all keepalive requests in flight pass 64 KiB, so a batch
 * stays well under that; a larger one goes as an ordinary request instead.
 */
export const KEEPALIVE_LIMIT_BYTES = 60 * 1024;

/**
 * Records telemetry entries into the practice session's history
 * (`/api/updateHistory`): entries are buffered as they arrive and written out
 * in one batch when {@link flush} is called. The app calls flush when the
 * session is saved, so history traffic rides on the session's existing save
 * cadence instead of its own timer.
 *
 * Some entries arrive with no save after them, so a page that is closed straight
 * after would take them with it. Once {@link attachWindow} has been given the
 * page's window, the buffer is also sent, with `keepalive`, whenever the page is
 * hidden or left — as the prototype sent each of its events the moment it
 * happened — and once more when the solve page goes away ({@link unmountWindow}).
 *
 * The request is best-effort — a failed batch is dropped with a warning
 * rather than retried, so an offline client cannot accumulate an unbounded
 * buffer.
 */
export class SessionHistoryTelemetryService extends TelemetryService {
  private pending: PendingEntry[] = [];

  private stopWatchingPage: (() => void) | null = null;

  protected telemetryCallback(entry: Entry): void {
    this.pending.push({ entry, timestamp: new Date() });
  }

  public override attachWindow(window: Window): void {
    super.attachWindow(window);
    this.stopWatchingPage?.();

    const onVisibilityChange = () => {
      if (window.document.visibilityState === 'hidden') void this.flush({ keepalive: true });
    };
    const onPageHide = () => void this.flush({ keepalive: true });
    window.document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    this.stopWatchingPage = () => {
      window.document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }

  public override unmountWindow(): void {
    super.unmountWindow();
    this.stopWatchingPage?.();
    this.stopWatchingPage = null;
    void this.flush();
  }

  /** Post every collated entry for this session in one request. */
  public override async flush(options: FlushOptions = {}): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length === 0) return;

    const events = batch.map(({ entry, timestamp }) => ({
      session_id: this.sessionId,
      timestamp,
      type: entry.type,
      data: entry.data
    }));
    const body = JSON.stringify(events);
    const keepalive = options.keepalive === true && new TextEncoder().encode(body).length <= KEEPALIVE_LIMIT_BYTES;

    try {
      const response = await fetch('/api/updateHistory', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json'
        },
        keepalive
      });
      if (!response.ok) {
        console.warn(`Failed to record session history batch: ${response.status}`);
      }
    } catch (error) {
      console.warn('Failed to record session history batch', error);
    }
  }
}
