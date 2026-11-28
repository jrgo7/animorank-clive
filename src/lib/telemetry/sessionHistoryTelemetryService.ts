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
 * How often the buffered queue is checked, in seconds.
 *
 * Constant for now. One second: an entry is worth recording promptly — the
 * history is the raw material of the session replay — and a closed tab takes
 * whatever was still buffered with it.
 */
export const FLUSH_INTERVAL_SECONDS = 1;

/**
 * How many history frames pass between full-code checkpoints. A run or submit
 * is otherwise the only known-good document in a recording, so a long stretch
 * of typing leaves hundreds of frames with nothing to anchor a reconstruction
 * that drifted. One snapshot every 50 frames bounds that.
 */
export const SNAPSHOT_INTERVAL_FRAMES = 1;

/**
 * Records telemetry entries into the practice session's history
 * (`/api/updateHistory`): entries are buffered as they arrive and written out
 * in one batch.
 *
 * Two things send a batch. A poll checks the queue every
 * {@link FLUSH_INTERVAL_SECONDS} and posts it when it holds anything, so an
 * idle page costs one comparison per interval and no traffic. An explicit
 * {@link flush} from the app posts immediately, which is what keeps an entry
 * caused by a save, run or submit from waiting for the next tick.
 *
 * A batch also carries a full-code checkpoint every
 * {@link SNAPSHOT_INTERVAL_FRAMES} frames, which bounds the replay's
 * reconstruction on its own, independently of runs and submits.
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
  /**
   * Frames recorded since the last checkpoint. The checkpoint is written when
   * this reaches the interval, and only then reset, so a snapshot the editor
   * could not prove yet is retried at the next frame instead of being lost.
   */
  private framesSinceSnapshot = 0;

  /**
   * Set while a batch is in flight. A tick that lands mid-request stands down:
   * the next one carries what has been buffered since, instead of posting a
   * second batch on top of the first.
   */
  private flushing = false;

  /** Handle for the poll, for {@link dispose} to stop. */
  private readonly poll = setInterval(() => void this.flushIfPending(), FLUSH_INTERVAL_SECONDS * 1000);

  /** Stop polling. The page calls this as it unmounts. */
  public override dispose(): void {
    clearInterval(this.poll);
  }

  protected telemetryCallback(entry: Entry): void {
    this.pending.push({ entry, timestamp: new Date() });

    // The checkpoint is the 50th frame of the group: 49 entries and the
    // document they lead to.
    this.framesSinceSnapshot += 1;
    if (this.framesSinceSnapshot < SNAPSHOT_INTERVAL_FRAMES - 1) return;

    // A document that is ahead of the history would be recorded after an entry
    // it already includes, so a mid-burst boundary waits for a quiescent frame.
    const code = this.snapshotText();
    if (code === undefined) return;

    this.pending.push({
      entry: { type: 'CODE_SNAPSHOT', data: { submittedCode: code } },
      timestamp: new Date()
    });
    this.framesSinceSnapshot = 0;
  }

  /** One poll: post whatever has accumulated since the last batch. */
  private async flushIfPending(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    await this.flush();
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

    this.flushing = true;
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
    } finally {
      this.flushing = false;
    }
  }
}
