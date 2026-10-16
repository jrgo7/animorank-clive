/**
 * The compiler wording table: what Implement says beside a compiler's complaint.
 *
 * The table is authored by the team in `content/base/diagnostics.yaml`, so these
 * pin the checks that make a bad edit fail at load — naming the file — rather
 * than in the middle of a student's session. Each failure case re-imports the
 * loader against a doctored table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTICS_DOC } from './load';

const TABLE = '../../content/base/diagnostics.yaml?raw';

afterEach(() => {
  vi.doUnmock(TABLE);
  vi.resetModules();
});

async function loadWith(source: string): Promise<unknown> {
  vi.resetModules();
  vi.doMock(TABLE, () => ({ default: source }));
  return import('./load');
}

describe('the compiler wording table', () => {
  it('reads every clang code the prototype maps, each under one entry', () => {
    expect(DIAGNOSTICS_DOC.fallback).toBe('The compiler stopped here.');
    const owner = new Map<string, string>();
    for (const entry of DIAGNOSTICS_DOC.entries) {
      for (const code of entry.clang ?? []) {
        expect(owner.get(code), `${code} sits under two entries`).toBeUndefined();
        owner.set(code, entry.id);
      }
    }
    expect(owner.get('expected_semi_after_expr')).toBe('unfinished_statement');
    expect(owner.get('undeclared_var_use')).toBe('undeclared');
    expect(owner.get('-Wformat')).toBe('format_mismatch');
    expect(owner.get('typecheck_expression_not_modifiable_lvalue')).toBe('store_into_non_variable');
  });

  it('refuses a clang code claimed by two entries', async () => {
    const table =
      'fallback: x\nentries:\n  - {id: a, match: a, say: A, clang: [same]}\n  - {id: b, match: b, say: B, clang: [same]}\n';
    await expect(loadWith(table)).rejects.toThrow(/'same' is under both/);
  });

  it('refuses a clang list that is not a list of codes', async () => {
    const table = 'fallback: x\nentries:\n  - {id: a, match: a, say: A, clang: oops}\n';
    await expect(loadWith(table)).rejects.toThrow(/bad clang list/);
  });

  it('refuses a table with no fallback', async () => {
    const table = 'entries:\n  - {id: a, match: a, say: A}\n';
    await expect(loadWith(table)).rejects.toThrow(/has no fallback/);
  });

  it('refuses a match that is not a regular expression', async () => {
    const table = 'fallback: x\nentries:\n  - {id: a, match: "(", say: A}\n';
    await expect(loadWith(table)).rejects.toThrow(/bad match/);
  });

  it('refuses an entry with no id, match or say', async () => {
    const table = 'fallback: x\nentries:\n  - {id: a, match: a}\n';
    await expect(loadWith(table)).rejects.toThrow(/entry 1 has no say/);
  });
});
