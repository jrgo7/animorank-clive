/**
 * Cross-origin isolation, which the solve page needs for live C diagnostics.
 *
 * clangd-in-browser runs clangd's threads on `SharedArrayBuffer`, and a browser
 * hands that over only to a cross-origin isolated document. The solve page is
 * the only page in the app that runs clangd, so it is the only page isolated —
 * every other page, and every other route, is unchanged.
 *
 * `credentialless` rather than `require-corp` on the embedder policy: the app's
 * fonts come from Google's CDN, and credentialless loads them (and any other
 * cross-origin no-cors subresource) without asking them to opt in with
 * `Cross-Origin-Resource-Policy`. Same-origin chunks — Monaco included, which
 * this app bundles rather than loading from a CDN — are unaffected either way.
 */
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
};

/** A practice session's solve page: `/problem/<problem_id>/<session_id>`. */
const SOLVE_PAGE = /^\/problem\/[^/]+\/[^/]+\/?$/;

/**
 * Whether a request path is the solve page — the one document that is served
 * isolated. Matched on the path rather than the route id so the hooks can decide
 * before the request is resolved.
 */
export function isCrossOriginIsolatedPage(pathname: string): boolean {
  return SOLVE_PAGE.test(pathname);
}
