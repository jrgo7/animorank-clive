/**
 * Fetch clangd (compiled to WebAssembly) for live C diagnostics in Implement.
 *
 *     npm run scripts:fetchClangd
 *     npm run scripts:fetchClangd -- --source file:///path/to/folder/
 *
 * Run once per machine that serves the app: the CLive plugin runs clangd in the
 * student's browser from these files, and without them live checking is simply
 * off. Ported from `clive-userflow/scripts/fetch_clangd.py` — spec
 * `2026-10-12-live-c-diagnostics-design.md`.
 *
 * The files are clangd-in-browser's build (github.com/guyutongxue/clangd-in-browser,
 * MIT; clangd from LLVM 21), pinned by SHA-256: if the upstream files ever
 * change, this refuses them rather than serving something untested. They are too
 * big for git (the wasm is 126 MB), so they live in `vendor/clangd/`, which is
 * gitignored. The wasm is also written brotli-compressed (about 13 MB), which is
 * what `/clangd/clangd.wasm` sends to a browser that accepts it. The page never
 * fetches from the upstream site.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { constants, createBrotliCompress } from 'node:zlib';

const SOURCE = 'https://clangd.guyutongxue.site/wasm/';

/** The two files and the SHA-256 each must have, as the prototype pins them. */
const FILES: Record<string, string> = {
  'clangd.js': 'a7ff1c588eb5374783bbda84d949b92b8027c2381c786072448b96eba90c7027',
  'clangd.wasm': '0d71e7a7f8e6dd369cb2a0b22cc4016d649f370e5b905adb6092536deb0ee019'
};

/** Where the files go; `CLIVE_CLANGD_DIR` matches the folder the route serves from. */
const DIR = process.env.CLIVE_CLANGD_DIR || path.resolve('vendor/clangd');

/** A file's SHA-256, streamed: the wasm is 126 MB and never needs to be whole in memory. */
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Download each file that is not already present with the right hash; return their names. */
async function fetchClangd(source: string): Promise<string[]> {
  fs.mkdirSync(DIR, { recursive: true });
  const got: string[] = [];
  for (const [name, digest] of Object.entries(FILES)) {
    const target = path.join(DIR, name);
    if (fs.existsSync(target) && (await sha256(target)) === digest) continue;
    const part = `${target}.part`;
    const response = await fetch(source + name);
    if (!response.ok || !response.body) {
      throw new Error(`${response.status} ${response.statusText} for ${source + name}`);
    }
    // `response.body` is the runtime's own ReadableStream; `Readable.fromWeb` takes it as-is.
    const body = Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>);
    await pipeline(body, fs.createWriteStream(part));
    if ((await sha256(part)) !== digest) {
      fs.rmSync(part, { force: true });
      fs.rmSync(target, { force: true });
      throw new Error(
        `${name} from ${source} does not match its pinned hash; the upstream files have ` +
          'changed. Nothing was installed for it.'
      );
    }
    fs.renameSync(part, target);
    got.push(name);
  }

  const wasm = path.join(DIR, 'clangd.wasm');
  const compressed = `${wasm}.br`;
  if (
    fs.existsSync(wasm) &&
    (!fs.existsSync(compressed) || fs.statSync(compressed).mtimeMs < fs.statSync(wasm).mtimeMs)
  ) {
    await pipeline(
      fs.createReadStream(wasm),
      createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 24 } }),
      fs.createWriteStream(compressed)
    );
  }
  return got;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: SOURCE, help: 'folder URL ending in / (default: the upstream site)' }
    }
  });
  const got = await fetchClangd(values.source);
  console.log(`clangd in ${DIR}: ${got.length ? `fetched ${got.join(', ')}` : 'already up to date'}`);
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
