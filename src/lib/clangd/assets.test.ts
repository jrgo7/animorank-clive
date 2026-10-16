/**
 * Which clangd files the app will serve, and when it says live checking is
 * possible. Both read `CLIVE_CLANGD_DIR`, so these run against a temporary
 * folder instead of the real 126 MB files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clangdAssetPath, clangdPresent } from './assets.server';

let folder: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

function vendored(): string {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-clangd-'));
  vi.stubEnv('CLIVE_CLANGD_DIR', folder);
  return folder;
}

describe('the vendored clangd files', () => {
  it('counts as present only with both files', () => {
    const dir = vendored();
    expect(clangdPresent()).toBe(false);
    fs.writeFileSync(path.join(dir, 'clangd.js'), 'export default 1;');
    expect(clangdPresent()).toBe(false);
    fs.writeFileSync(path.join(dir, 'clangd.wasm'), '\0asm');
    expect(clangdPresent()).toBe(true);
  });

  it('resolves the two names it serves', () => {
    const dir = vendored();
    fs.writeFileSync(path.join(dir, 'clangd.wasm'), '\0asm');
    expect(clangdAssetPath('clangd.wasm')).toBe(path.join(dir, 'clangd.wasm'));
    // Present in the folder, but not a name the route serves.
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'no');
    expect(clangdAssetPath('secret.txt')).toBeNull();
    // Nor anything that tries to walk out of the folder.
    expect(clangdAssetPath('../clangd.wasm')).toBeNull();
    expect(clangdAssetPath('clangd.wasm.br')).toBeNull();
  });

  it('resolves nothing for a file that is not there', () => {
    vendored();
    expect(clangdAssetPath('clangd.js')).toBeNull();
  });
});
