/* clangd, compiled to WebAssembly, as a language server in a module worker.
 *
 * The CLive plugin's live C diagnostics run this while the student types in
 * Implement; `plugins/plugin-clive/windows/liveCheck.ts` is the client that talks
 * to it. Ported from `clive-userflow/src/clive/studio/static/clangd-worker.js`
 * (itself adapted from clangd-in-browser's main.worker.ts,
 * github.com/guyutongxue/clangd-in-browser, MIT) — spec
 * `2026-10-12-live-c-diagnostics-design.md`, without vscode-languageserver:
 * messages arrive as plain objects and go back the same way. clangd reads LSP
 * from stdin and writes it to stdout, framed as "Content-Length: N\r\n\r\n" + N
 * bytes of JSON; this file does the framing both ways.
 *
 * It lives in `static/` rather than in the plugin package on purpose: a worker
 * module with a runtime `import()` picks up Vite's browser-only HMR client in
 * dev, which throws in a worker. Here the file is served exactly as written, in
 * dev and in a build — which is also how the prototype serves it.
 *
 * `liveCheck.ts` runs this from a blob URL (see there for why), so the two files
 * it loads are named against `self.location.origin` rather than as bare paths:
 * an absolute path does not resolve against a blob URL.
 *
 * Posts {type: "ready", loadMs}, {type: "lsp", msg} or {type: "failed", reason}.
 * The files come from `/clangd/` (vendored by `scripts/fetchClangd.ts`). Needs
 * cross-origin isolation: clangd runs threads on SharedArrayBuffer.
 *
 * Kept in plain JavaScript on purpose: it is served verbatim, so nothing
 * compiles or type-checks it. `plugins/plugin-clive/windows/liveCheck.ts` holds
 * the message contract in types.
 */

const T0 = performance.now();
const FLAGS = [
  '-xc',
  '-std=gnu17',
  '-Wall',
  '--target=wasm32-wasi',
  '-isystem/usr/include',
  '-isystem/usr/include/wasm32-wasi'
];

// The page's own origin, whether this file is served from a URL or from a blob.
const ORIGIN = self.location.origin;

const fail = (reason) => self.postMessage({ type: 'failed', reason: String(reason) });

async function main() {
  const wasm = await (await fetch(`${ORIGIN}/clangd/clangd.wasm`)).blob();
  const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
  // A runtime URL — the file `/clangd/` serves — never a module this file could
  // have imported at load time.
  const { default: Clangd } = await import(`${ORIGIN}/clangd/clangd.js`);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const queue = [];
  let current = [];
  let wake = () => {};
  const stdin = () => {
    if (current.length === 0) {
      const next = queue.shift();
      if (next === undefined) return null;
      current = [...encoder.encode(next), null];
    }
    return current.shift() ?? null;
  };
  const stdinReady = async () => {
    if (queue.length === 0) return new Promise((resolve) => (wake = resolve));
  };

  let bytes = [];
  let need = -1;
  const stdout = (chunk) => {
    bytes.push(chunk);
    if (need < 0) {
      const n = bytes.length;
      if (n >= 4 && bytes[n - 4] === 13 && bytes[n - 3] === 10 && bytes[n - 2] === 13 && bytes[n - 1] === 10) {
        const length = /Content-Length: (\d+)/i.exec(decoder.decode(new Uint8Array(bytes)))?.[1];
        need = length ? Number(length) : -1;
        bytes = [];
      }
    } else if (bytes.length === need) {
      self.postMessage({ type: 'lsp', msg: JSON.parse(decoder.decode(new Uint8Array(bytes))) });
      bytes = [];
      need = -1;
    }
  };
  const aborted = () => fail('clangd stopped');

  const clangd = await Clangd({
    thisProgram: '/usr/bin/clangd',
    locateFile: (file, prefix) => (file.endsWith('.wasm') ? wasmUrl : `${prefix}${file}`),
    stdinReady,
    stdin,
    stdout,
    stderr: () => {},
    onExit: aborted,
    onAbort: aborted
  });
  clangd.FS.writeFile('/home/web_user/main.c', '');
  // clangd's own include checks are not the compiler's: gcc -Werror accepts an
  // unused #include (count_vowels' starter code has one), so they would mark code
  // that builds.
  clangd.FS.writeFile(
    '/home/web_user/.clangd',
    JSON.stringify({
      CompileFlags: { Add: FLAGS },
      Diagnostics: { UnusedIncludes: 'None', MissingIncludes: 'None' }
    })
  );
  clangd.callMain(['--log=error']);

  self.onmessage = (event) => {
    // Content-Length counts bytes; escaping every non-ASCII character keeps
    // bytes == chars.
    const body = JSON.stringify(event.data).replace(/[\u007F-\uFFFF]/g, (ch) => {
      return '\\u' + (ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0');
    });
    queue.push(`Content-Length: ${body.length}\r\n`, '\r\n', body);
    wake();
  };
  self.postMessage({ type: 'ready', loadMs: performance.now() - T0 });
}

void main().catch(fail);
