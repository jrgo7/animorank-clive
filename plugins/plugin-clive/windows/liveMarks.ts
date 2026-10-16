/**
 * clangd's diagnostics in the team's words, for the squiggles shown while the
 * student types in Implement.
 *
 * Ported from the prototype's student page — `student.html`'s `liveList` and
 * `endOfPreviousLine` — spec `2026-10-12-live-c-diagnostics-design.md`. Notes and
 * hints go (they carry "Did you mean…"), clangd's own checks go (they are not the
 * compiler's), and every problem shows as an error, because Submit compiles with
 * `-Werror`.
 *
 * Nothing here touches the editor or the wording table's source: it takes the
 * table the plugin's `/boot` hands over, so this file stays testable without
 * Monaco or a browser.
 */
import type { ClangdDiagnostic } from './liveCheck';

/** One mark to draw: where it goes, and what the hover says. */
export interface LiveMark {
  line: number;
  column: number;
  severity: 'error';
  kind: string;
  say: string;
  /** clang's own message, shown only when the student asks for it. */
  raw: string;
}

/** The boot payload's `live_check`: whether clangd is here, and how to word it. */
export interface LiveTable {
  available: boolean;
  fallback: string;
  table: { kind: string; say: string; codes: string[] }[];
}

/** A line with its line and same-line block comments removed: comments are not code. */
const withoutComments = (text: string): string => text.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

/**
 * Just past the code on the previous line that has any, when `column` is the
 * first thing on `line` — clangd reports a missing `;` at the next token, like
 * gcc. Comment-only lines are skipped. Mirrors `diagnostics._end_of_previous_line`.
 */
export function endOfPreviousLine(lines: string[], line: number, column: number): [number, number] {
  if (
    withoutComments(lines[line - 1] ?? '')
      .slice(0, column - 1)
      .trim()
  )
    return [line, column];
  for (let k = line - 2; k >= 0; k--) {
    const code = withoutComments(lines[k]).replace(/\s+$/, '');
    if (code.trim()) return [k + 1, code.length + 1];
  }
  return [line, column];
}

/** clangd's diagnostics, in the wording the table gives each code. */
export function liveMarks(diagnostics: ClangdDiagnostic[], code: string, table: LiveTable): LiveMark[] {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const marks: LiveMark[] = [];
  for (const diagnostic of diagnostics) {
    // Notes and hints, and clangd's own checks (include-cleaner): not compile errors.
    if (diagnostic.severity === 3 || diagnostic.severity === 4 || diagnostic.source === 'clangd') continue;
    // The first line only, without clangd's own advice: the hover carries our words.
    const raw = String(diagnostic.message ?? '')
      .split('\n')[0]
      .replace(/\s*\(fix(es)? available\)\s*$/, '')
      .replace(/;\s*did you mean '[^']*'\??/i, '');
    const entry = table.table.find((row) => row.codes.includes(String(diagnostic.code)));
    let line = (diagnostic.range?.start.line ?? 0) + 1;
    let column = (diagnostic.range?.start.character ?? 0) + 1;
    const kind = entry ? entry.kind : 'unknown';
    // clangd points a missing `;` at the next token, as gcc does; the mark belongs
    // at the end of the statement that is missing it.
    if (kind === 'unfinished_statement') [line, column] = endOfPreviousLine(lines, line, column);
    marks.push({ line, column, severity: 'error', kind, say: entry ? entry.say : table.fallback, raw });
  }
  return marks;
}
