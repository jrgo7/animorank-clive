/**
 * `/clangd/<name>`: what the student's browser downloads to run clangd, and the
 * only two files it may ever download from there.
 *
 * The handler is called directly with a hand-built event, so these run against a
 * temporary folder of small stand-ins — no 126 MB, no server.
 */
import { brotliCompressSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISOLATION_HEADERS } from '$lib/crossOriginIsolation';
import { GET } from './+server';
import type { RequestEvent } from './$types';

const RAW = Buffer.from('\0asm-raw-wasm');

let folder: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

function vendored({ brotli = false, wasm = true } = {}): void {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-clangd-'));
  vi.stubEnv('CLIVE_CLANGD_DIR', folder);
  fs.writeFileSync(path.join(folder, 'clangd.js'), 'export default 1;');
  fs.writeFileSync(path.join(folder, 'secret.txt'), 'no');
  if (!wasm) return;
  fs.writeFileSync(path.join(folder, 'clangd.wasm'), RAW);
  if (brotli) fs.writeFileSync(path.join(folder, 'clangd.wasm.br'), brotliCompressSync(RAW));
}

/** Only `params` and `request` are read by the handler. */
function request(name: string, accept?: string): RequestEvent {
  const headers = accept ? { 'accept-encoding': accept } : undefined;
  return {
    params: { name },
    request: new Request(`http://localhost/clangd/${name}`, { headers })
  } as unknown as RequestEvent;
}

/** A refused name: SvelteKit's `error` throws, so the status is read off the throw. */
function refusal(name: string): unknown {
  try {
    GET(request(name));
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('/clangd/<name>', () => {
  it('sends the wasm brotli-encoded to a browser that accepts it', async () => {
    vendored({ brotli: true });
    const response = await GET(request('clangd.wasm', 'gzip, br'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('content-type')).toBe('application/wasm');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('vary')).toBe('accept-encoding');
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(Buffer.from(await response.arrayBuffer())).toEqual(brotliCompressSync(RAW));
  });

  it('sends the raw file otherwise', async () => {
    vendored({ brotli: true });
    const response = await GET(request('clangd.wasm'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(RAW);
  });

  it('sends the loader as JavaScript', async () => {
    vendored({ brotli: true });
    const response = await GET(request('clangd.js', 'br'));
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toBe('export default 1;');
  });

  it('404s every other name in the folder, and the brotli copy', () => {
    vendored({ brotli: true });
    for (const name of ['secret.txt', 'clangd.wasm.br', '..', 'clangd.wasm.x']) {
      expect(refusal(name)).toMatchObject({ status: 404 });
    }
  });

  it('404s a file the fetch script has not written yet', () => {
    vendored({ wasm: false });
    expect(refusal('clangd.wasm')).toMatchObject({ status: 404 });
  });
});
