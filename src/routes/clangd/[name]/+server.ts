/**
 * clangd's two files, vendored by `scripts/fetchClangd.ts`, served to the
 * student's browser for live C diagnostics in the CLive plugin.
 *
 * Long-cached and immutable, unlike the rest of the app: the files are pinned
 * by SHA-256 when they are fetched, so a name never changes content. The wasm is
 * about 126 MB raw, so the fetch script also writes a brotli copy beside it
 * (about 13 MB) and this sends that to a browser that accepts `br`.
 */
import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { CLANGD_TYPES, clangdAssetPath } from '$lib/clangd/assets.server';
import { ISOLATION_HEADERS } from '$lib/crossOriginIsolation';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, request }) => {
  const contentType = CLANGD_TYPES[params.name];
  const raw = clangdAssetPath(params.name);
  if (!contentType || !raw) throw error(404, 'Not found');

  // `clangd.wasm.br` is written by the fetch script; a browser that does not
  // accept it gets the raw file, which is still correct, just larger.
  const compressed = `${raw}.br`;
  const acceptsBrotli = (request.headers.get('accept-encoding') ?? '')
    .split(',')
    .some((encoding) => encoding.split(';')[0].trim() === 'br');
  const file = acceptsBrotli && fs.existsSync(compressed) ? compressed : raw;

  const headers = new Headers({
    'content-type': contentType,
    'content-length': String(fs.statSync(file).size),
    'cache-control': 'public, max-age=31536000, immutable',
    vary: 'accept-encoding',
    ...ISOLATION_HEADERS
  });
  if (file === compressed) headers.set('content-encoding', 'br');

  // Streamed rather than read into memory: the raw wasm is 126 MB.
  return new Response(Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream, { headers });
};
