/**
 * What the page is told about live checking: whether clangd is vendored on this
 * machine, and the wording to show a clangd complaint in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveTable } from './live';

let folder: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

/** A vendored-clangd folder of the test's own, so the result does not depend on the machine. */
function vendoredDir(): string {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-clangd-'));
  vi.stubEnv('CLIVE_CLANGD_DIR', folder);
  return folder;
}

describe('the live-diagnostics table', () => {
  it('is available only once both clangd files are there', () => {
    const dir = vendoredDir();
    expect(liveTable().available).toBe(false);
    fs.writeFileSync(path.join(dir, 'clangd.js'), 'export default 1;');
    expect(liveTable().available).toBe(false);
    fs.writeFileSync(path.join(dir, 'clangd.wasm'), '\0asm');
    expect(liveTable().available).toBe(true);
  });

  it('hands over the wording and the codes, and nothing else', () => {
    vendoredDir();
    const live = liveTable();
    expect(Object.keys(live).sort()).toEqual(['available', 'fallback', 'table']);
    expect(live.fallback).toBe('The compiler stopped here.');
    expect(live.table.length).toBeGreaterThan(0);
    for (const row of live.table) {
      expect(Object.keys(row).sort()).toEqual(['codes', 'kind', 'say']);
      // A row with no codes would be a wording the page can never reach.
      expect(row.codes.length).toBeGreaterThan(0);
      expect(row.say.length).toBeGreaterThan(0);
    }
    // Only entries that name clang codes appear: the page maps a code to a row.
    expect(live.table.some((row) => row.kind === 'unfinished_statement')).toBe(true);
    expect(live.table.some((row) => row.kind === 'argument_count')).toBe(false);
  });
});
