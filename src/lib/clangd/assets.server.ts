/**
 * Where clangd (compiled to WebAssembly) lives, and the only place that knows
 * which of its files exist.
 *
 * The CLive plugin's live C diagnostics run clangd in the student's browser
 * (ported from `clive-userflow`'s `2026-10-12-live-c-diagnostics-design.md`).
 * The two files are about 126 MB raw — far past what belongs in git — so they
 * are fetched once per machine by `scripts/fetchClangd.ts` into `vendor/clangd/`
 * (gitignored) and served from `/clangd/<name>` by
 * `src/routes/clangd/[name]/+server.ts`.
 *
 * `plugins/plugin-clive/server/live.ts` reads {@link clangdPresent} to tell the
 * browser whether live checking can run at all; a machine without the files
 * behaves exactly as it did before, with no squiggles while typing.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Both files are needed for live checking: the loader and the wasm itself. */
export const CLANGD_FILES = ['clangd.js', 'clangd.wasm'] as const;

/**
 * The content type of each, and the only names `/clangd/` will serve. Anything
 * else in the folder is unreachable through that route by construction.
 */
export const CLANGD_TYPES: Readonly<Record<string, string>> = {
  'clangd.js': 'text/javascript; charset=utf-8',
  'clangd.wasm': 'application/wasm'
};

/**
 * The vendored clangd folder. `CLIVE_CLANGD_DIR` moves it, which the tests use
 * to run against a temporary folder of small stand-ins instead of the real
 * 126 MB files.
 *
 * Read from the process environment rather than `$env/dynamic/private` (which
 * the model providers use for their keys, and which an `.env` file feeds): this
 * is an optional path for the machine serving the app, like `FILE_LOGGER_FILE`,
 * and it is read at the moment it is needed.
 */
export function clangdDir(): string {
  return process.env.CLIVE_CLANGD_DIR || path.resolve('vendor/clangd');
}

/** Whether both files are present, i.e. whether live checking can run here. */
export function clangdPresent(): boolean {
  const dir = clangdDir();
  return CLANGD_FILES.every((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * The file `/clangd/<name>` serves, or null for any other name or a missing
 * file. Only {@link CLANGD_TYPES} names are ever resolved, so no other path in
 * the folder — and nothing outside it — can be reached through this.
 */
export function clangdAssetPath(name: string): string | null {
  if (!Object.hasOwn(CLANGD_TYPES, name)) return null;
  const file = path.join(clangdDir(), name);
  return fs.existsSync(file) ? file : null;
}
