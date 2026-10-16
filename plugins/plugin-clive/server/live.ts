/**
 * Live C diagnostics in Implement: what the page needs to show clangd's
 * complaints in the team's words.
 *
 * Ported from `clive-userflow`'s `studio/student.py` (`clangd_present`,
 * `live_table`) — spec `2026-10-12-live-c-diagnostics-design.md`. clangd itself
 * runs in the student's browser, from the files `scripts/fetchClangd.ts` vendors;
 * the server only says whether they are there and hands over the wording.
 *
 * `available` is what makes the feature silent when a machine has not fetched the
 * files: the client starts nothing, and the page behaves exactly as it did before
 * live checking existed.
 */
import { clangdPresent } from '$lib/clangd/assets.server';
import { DIAGNOSTICS_DOC } from './content/load';

/** One wording row as the page needs it: the description and the codes it covers. */
export interface LiveTableRow {
  kind: string;
  say: string;
  codes: string[];
}

/** The boot payload's `live_check`: whether clangd is here, and how to word it. */
export interface LiveTable {
  available: boolean;
  fallback: string;
  table: LiveTableRow[];
}

/**
 * Each entry's description with the clangd codes it covers. Only `say` and the
 * codes leave the server: `match` is gcc's, and of no use to the page.
 */
export function liveTable(): LiveTable {
  return {
    available: clangdPresent(),
    fallback: DIAGNOSTICS_DOC.fallback,
    table: DIAGNOSTICS_DOC.entries
      .filter((entry) => entry.clang?.length)
      .map((entry) => ({ kind: entry.id, say: entry.say, codes: [...(entry.clang as string[])] }))
  };
}
