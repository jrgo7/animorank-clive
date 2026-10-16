/**
 * The clangd client: one document, one version per check, and only the newest
 * answer reaching the page. Driven with a fake worker, so no clangd is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClangdDiagnostic } from './liveCheck';
import { createLiveCheckClient, type LiveCheckClient } from './liveCheck';

const URI = 'file:///home/web_user/main.c';
const DIAGNOSTICS: ClangdDiagnostic[] = [
  {
    severity: 1,
    code: 'expected_semi_after_expr',
    message: 'expected ;',
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }
  }
];

interface Sent {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: { textDocument?: { uri?: string; version?: number; text?: string }; contentChanges?: { text: string }[] };
}

/**
 * A module worker that answers `initialize` and lets a test push LSP messages
 * in. It holds messages until a handler is attached: a worker really does start
 * before the client's `start()` runs, and its `ready` can arrive first.
 */
class FakeWorker {
  onerror: ((_event: ErrorEvent) => void) | null = null;
  readonly sent: Sent[] = [];
  terminated = false;
  #handler: ((_event: MessageEvent) => void) | null = null;
  #queued: MessageEvent[] = [];

  get onmessage(): ((_event: MessageEvent) => void) | null {
    return this.#handler;
  }

  set onmessage(handler: ((_event: MessageEvent) => void) | null) {
    this.#handler = handler;
    const queued = this.#queued;
    this.#queued = [];
    for (const event of queued) handler?.(event);
  }

  postMessage(message: Sent): void {
    this.sent.push(message);
    if (message.method === 'initialize') {
      // The real worker's clangd answers the handshake with a result.
      this.lsp({ id: message.id, result: { capabilities: {} } });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The worker's own lifecycle/relay messages, as the real one posts them. */
  ready(loadMs = 7): void {
    this.deliver({ data: { type: 'ready', loadMs } } as MessageEvent);
  }

  lsp(msg: unknown): void {
    this.deliver({ data: { type: 'lsp', msg } } as MessageEvent);
  }

  /** The worker giving up before clangd ever started. */
  fail(reason: string): void {
    this.deliver({ data: { type: 'failed', reason } } as MessageEvent);
  }

  private deliver(event: MessageEvent): void {
    if (this.#handler) this.#handler(event);
    else this.#queued.push(event);
  }

  /** What clangd publishes for the current text. */
  publish(version: number, diagnostics: ClangdDiagnostic[] = DIAGNOSTICS): void {
    this.lsp({ method: 'textDocument/publishDiagnostics', params: { uri: URI, version, diagnostics } });
  }

  didChangeCount(): number {
    return this.sent.filter((message) => message.method === 'textDocument/didChange').length;
  }
}

function started(): { client: LiveCheckClient; worker: FakeWorker } {
  const worker = new FakeWorker();
  const client = createLiveCheckClient({
    worker: worker as unknown as Worker,
    limits: { checkMs: 50, firstCheckMs: 50 }
  });
  worker.ready();
  return { client, worker };
}

beforeEach(() => {
  vi.stubGlobal('crossOriginIsolated', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('starting the clangd client', () => {
  it('resolves with the load time the worker reported', async () => {
    const worker = new FakeWorker();
    const client = createLiveCheckClient({ worker: worker as unknown as Worker });
    const starting = client.start();
    worker.ready(1234);
    await expect(starting).resolves.toEqual({ loadMs: 1234 });
    expect(worker.sent.some((message) => message.method === 'initialized')).toBe(true);
    expect(client.dead).toBe(false);
  });

  it('refuses to start without cross-origin isolation, and touches no worker', async () => {
    vi.stubGlobal('crossOriginIsolated', false);
    const worker = new FakeWorker();
    const client = createLiveCheckClient({ worker: worker as unknown as Worker });
    await expect(client.start()).rejects.toThrow('not isolated');
    expect(client.dead).toBe(true);
    expect(worker.terminated).toBe(false);
    expect(worker.sent).toHaveLength(0);
  });

  it('goes dead when the worker fails to start', async () => {
    const worker = new FakeWorker();
    const client = createLiveCheckClient({ worker: worker as unknown as Worker });
    const reasons: string[] = [];
    client.onDead((reason) => reasons.push(reason));
    const starting = client.start();
    worker.fail('no wasm');
    await expect(starting).rejects.toThrow('no wasm');
    expect(reasons).toEqual(['no wasm']);
    expect(worker.terminated).toBe(true);
  });
});

describe('checking', () => {
  it('opens the document once, then sends each new text as its own version', async () => {
    const { client, worker } = started();
    await client.start();
    client.check('int main(void) {}\n');
    client.check('int main(void) { return 0; }\n');
    expect(worker.sent.filter((message) => message.method === 'textDocument/didOpen')).toHaveLength(1);
    expect(worker.didChangeCount()).toBe(1);
    const versions = worker.sent
      .filter((message) => message.method === 'textDocument/didChange')
      .map((message) => message.params?.textDocument?.version);
    expect(versions).toEqual([2]);
  });

  it('hands back the last answer for text it has already checked', async () => {
    const { client, worker } = started();
    await client.start();
    const seen: ClangdDiagnostic[][] = [];
    client.onDiagnostics((diagnostics) => seen.push(diagnostics));
    client.check('int x;\n');
    worker.publish(1);
    client.check('int x;\n');
    expect(worker.sent.filter((message) => message.method === 'textDocument/didOpen')).toHaveLength(1);
    expect(worker.didChangeCount()).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(DIAGNOSTICS);
  });

  it('drops an answer for text the student has already typed past', async () => {
    const { client, worker } = started();
    await client.start();
    const seen: number[] = [];
    client.onDiagnostics((diagnostics) => seen.push(diagnostics.length));
    client.check('int x;\n');
    client.check('int x; return 0;\n');
    worker.publish(1, DIAGNOSTICS);
    expect(seen).toEqual([]);
    worker.publish(2, []);
    expect(seen).toEqual([0]);
  });

  it('ignores diagnostics for another document', async () => {
    const { client, worker } = started();
    await client.start();
    const seen: number[] = [];
    client.onDiagnostics((diagnostics) => seen.push(diagnostics.length));
    client.check('int x;\n');
    worker.lsp({
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///home/web_user/other.c', version: 1, diagnostics: DIAGNOSTICS }
    });
    expect(seen).toEqual([]);
  });

  it('dies after three checks in a row go unanswered, and keeps every answer after that', async () => {
    vi.useFakeTimers();
    const { client, worker } = started();
    const reasons: string[] = [];
    client.onDead((reason) => reasons.push(reason));
    await client.start();
    for (let i = 0; i < 3; i++) {
      client.check(`int x${i};\n`);
      vi.advanceTimersByTime(100);
    }
    expect(reasons).toEqual(['timeout']);
    expect(client.dead).toBe(true);
    expect(worker.terminated).toBe(true);
    const sentBefore = worker.sent.length;
    client.check('int much later;\n');
    expect(worker.sent).toHaveLength(sentBefore);
  });

  it('forgives a slow check when the next one is answered', async () => {
    vi.useFakeTimers();
    const { client, worker } = started();
    const reasons: string[] = [];
    client.onDead((reason) => reasons.push(reason));
    await client.start();
    client.check('int a;\n');
    vi.advanceTimersByTime(100); // one miss
    worker.publish(1, []);
    client.check('int b;\n');
    vi.advanceTimersByTime(100); // the miss count started again
    expect(reasons).toEqual([]);
    expect(client.dead).toBe(false);
  });
});
