/**
 * A small LSP client for the clangd running in `static/clive/clangd-worker.js`.
 *
 * Ported from `clive-userflow/src/clive/studio/static/live-check.js` — spec
 * `2026-10-12-live-c-diagnostics-design.md`. It knows nothing about the wording,
 * the editor or the log: one document, `file:///home/web_user/main.c`; each check
 * sends its full text as a new version, and only the diagnostics for the newest
 * version reach `onDiagnostics`, so a slow answer for older text never paints over
 * a newer one. Text identical to the last check is not sent — clangd publishes
 * nothing for it — and the last answer is handed back instead.
 *
 * A slow check is only late (the first one builds stdio.h's preamble, which a weak
 * PC may take a while over); three unanswered in a row count as dead. Once dead —
 * not isolated, failed to start, aborted, or those three misses — it stays dead:
 * restarting would hold another ~750 MB on a machine that may already be short of
 * it.
 */

const URI = 'file:///home/web_user/main.c';
const START_LIMIT_MS = 120_000;
const CHECK_LIMIT_MS = 10_000;
const FIRST_CHECK_LIMIT_MS = 30_000;
const MAX_MISSES = 3;

/** One diagnostic as clangd publishes it, narrowed to what this client reads. */
export interface ClangdDiagnostic {
  severity?: number;
  source?: string;
  code?: string | number;
  message: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/** A message from the worker: its lifecycle, or one LSP message from clangd. */
type WorkerMessage =
  | { type: 'ready'; loadMs: number }
  | { type: 'failed'; reason: string }
  | { type: 'lsp'; msg: LspMessage };

/** The parts of an LSP message this client reads. */
interface LspMessage {
  id?: number;
  result?: unknown;
  method?: string;
  params?: { uri?: string; version?: number; diagnostics?: ClangdDiagnostic[] };
}

export interface LiveCheckLimits {
  startMs?: number;
  checkMs?: number;
  firstCheckMs?: number;
  maxMisses?: number;
}

/**
 * What the page gets back: clangd's diagnostics for the newest text and only
 * that, a reason when live checking gives up, and a way to send the current text.
 */
export interface LiveCheckClient {
  readonly dead: boolean;
  onDiagnostics(_handler: DiagnosticsHandler): void;
  onDead(_handler: DeadHandler): void;
  start(): Promise<{ loadMs: number }>;
  check(_code: string): void;
}

/** Called with the diagnostics for the newest text, never an older one's. */
export type DiagnosticsHandler = (_diagnostics: ClangdDiagnostic[]) => void;

/** Called once when live checking gives up, with the reason. */
export type DeadHandler = (_reason: string) => void;

/** The worker script, served verbatim from the app's static files. */
export const CLANGD_WORKER = '/clive/clangd-worker.js';

/**
 * The clangd worker, ready to be talked to.
 *
 * Its source is fetched and handed to the Worker as a blob rather than loaded
 * from its own URL: under the cross-origin isolation live checking needs, a
 * worker script fetched from the network must carry a
 * `Cross-Origin-Resource-Policy` header, which the app's static files cannot —
 * the browser answers `net::ERR_BLOCKED_BY_RESPONSE` — while a blob inherits the
 * page's own origin and needs no header. The file is the prototype's worker,
 * kept in plain JavaScript because nothing compiles it.
 */
export async function createClangdWorker(source = CLANGD_WORKER): Promise<Worker> {
  const text = await (await fetch(source)).text();
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  const worker = new Worker(url, { type: 'module' });
  // Safe to drop straight away: the worker has already been handed the source.
  URL.revokeObjectURL(url);
  return worker;
}

/**
 * `worker` is the seam the tests use: a fake stands in for the clangd worker, so
 * the version bookkeeping, the identical-text shortcut and the miss counting are
 * all testable without clangd's 126 MB. Building a real one is the caller's job
 * ({@link createClangdWorker}), which keeps this module free of the environment.
 */
export function createLiveCheckClient(options: { worker: Worker; limits?: LiveCheckLimits }): LiveCheckClient {
  const limits = options.limits ?? {};
  const startMs = limits.startMs ?? START_LIMIT_MS;
  const checkMs = limits.checkMs ?? CHECK_LIMIT_MS;
  const firstCheckMs = limits.firstCheckMs ?? FIRST_CHECK_LIMIT_MS;
  const maxMisses = limits.maxMisses ?? MAX_MISSES;

  const worker = options.worker;
  let dead = false;
  let version = 0;
  let opened = false;
  let checkTimer: number | NodeJS.Timeout | undefined;
  let nextId = 0;
  let lastText: string | null = null;
  let answered = false;
  let misses = 0;
  /** The newest answer handed to the page, and the text version it was for. */
  let answer: { version: number; diagnostics: ClangdDiagnostic[] } | null = null;
  const pending = new Map<number, (_result: unknown) => void>();
  let onDiag: DiagnosticsHandler = () => {};
  let onDeadFn: DeadHandler = () => {};

  const post = (message: Record<string, unknown>) => worker.postMessage({ jsonrpc: '2.0', ...message });
  const request = (method: string, params: unknown): Promise<unknown> => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const id = ++nextId;
    pending.set(id, resolve);
    post({ id, method, params });
    return promise;
  };
  const kill = (reason: string) => {
    if (dead) return;
    dead = true;
    clearTimeout(checkTimer);
    worker.terminate();
    onDeadFn(reason);
  };
  const receive = (message: LspMessage) => {
    if (message.id != null && pending.has(message.id)) {
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
      return;
    }
    if (message.method !== 'textDocument/publishDiagnostics' || message.params?.uri !== URI) return;
    // A reply for older text: the student has typed since, so it is stale.
    if (message.params.version != null && message.params.version !== version) return;
    clearTimeout(checkTimer);
    misses = 0;
    answered = true;
    answer = { version, diagnostics: message.params.diagnostics ?? [] };
    onDiag(answer.diagnostics);
  };

  return {
    get dead() {
      return dead;
    },
    onDiagnostics(fn) {
      onDiag = fn;
    },
    onDead(fn) {
      onDeadFn = fn;
    },
    start() {
      const { promise, resolve, reject } = Promise.withResolvers<{ loadMs: number }>();
      if (!globalThis.crossOriginIsolated) {
        dead = true;
        reject(new Error('not isolated'));
        return promise;
      }
      const limit = setTimeout(() => {
        kill('timeout');
        reject(new Error('timeout'));
      }, startMs);
      worker.onerror = (event: ErrorEvent) => {
        clearTimeout(limit);
        const reason = event.message || 'worker error';
        kill(reason);
        reject(new Error(reason));
      };
      worker.onmessage = async (event: MessageEvent<WorkerMessage>) => {
        const data = event.data;
        if (data.type === 'failed') {
          clearTimeout(limit);
          kill(data.reason);
          reject(new Error(data.reason));
          return;
        }
        if (data.type === 'lsp') {
          receive(data.msg);
          return;
        }
        await request('initialize', {
          processId: null,
          rootUri: 'file:///home/web_user',
          capabilities: { textDocument: { publishDiagnostics: { versionSupport: true } } }
        });
        post({ method: 'initialized', params: {} });
        clearTimeout(limit);
        resolve({ loadMs: data.loadMs });
      };
      return promise;
    },
    check(code) {
      if (dead) return;
      if (code === lastText) {
        // Answered already: hand it back. Still in flight: its answer is on the way.
        if (answer && answer.version === version) onDiag(answer.diagnostics);
        return;
      }
      lastText = code;
      version += 1;
      if (!opened) {
        opened = true;
        post({
          method: 'textDocument/didOpen',
          params: { textDocument: { uri: URI, languageId: 'c', version, text: code } }
        });
      } else {
        post({
          method: 'textDocument/didChange',
          params: { textDocument: { uri: URI, version }, contentChanges: [{ text: code }] }
        });
      }
      clearTimeout(checkTimer);
      checkTimer = setTimeout(
        () => {
          misses += 1;
          if (misses >= maxMisses) kill('timeout');
        },
        answered ? checkMs : firstCheckMs
      );
    }
  };
}
