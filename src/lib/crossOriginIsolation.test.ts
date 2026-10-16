/**
 * Which page carries cross-origin isolation: the solve page, and nothing else.
 * clangd's threads need it, and restricting it to one route is what keeps the
 * rest of the app out of its blast radius.
 */
import { describe, expect, it } from 'vitest';
import { ISOLATION_HEADERS, isCrossOriginIsolatedPage } from './crossOriginIsolation';

describe('cross-origin isolation', () => {
  it('names the two headers clangd needs', () => {
    expect(ISOLATION_HEADERS).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless'
    });
  });

  it('covers a solve page and no other route', () => {
    expect(isCrossOriginIsolatedPage('/problem/abc/session-1')).toBe(true);
    expect(isCrossOriginIsolatedPage('/problem/abc/session-1/')).toBe(true);
    expect(isCrossOriginIsolatedPage('/problem/abc')).toBe(false);
    expect(isCrossOriginIsolatedPage('/problem/abc/session-1/edit')).toBe(false);
    expect(isCrossOriginIsolatedPage('/problemSets')).toBe(false);
    expect(isCrossOriginIsolatedPage('/')).toBe(false);
    expect(isCrossOriginIsolatedPage('/plugins/clive/client.js')).toBe(false);
  });
});
