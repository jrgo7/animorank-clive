/**
 * clangd's diagnostics in the team's words: which of them survive, what they say,
 * and where the mark lands.
 */
import { describe, expect, it } from 'vitest';
import type { ClangdDiagnostic } from './liveCheck';
import { endOfPreviousLine, liveMarks, type LiveTable } from './liveMarks';

const TABLE: LiveTable = {
  available: true,
  fallback: 'The compiler stopped here.',
  table: [
    {
      kind: 'unfinished_statement',
      say: "This statement isn't finished here.",
      codes: ['expected_semi_after_expr', 'expected_semi_declaration', 'expected_semi_after_stmt']
    },
    { kind: 'undeclared', say: "The compiler doesn't know this name at this point.", codes: ['undeclared_var_use'] }
  ]
};

const diagnostic = (over: Partial<ClangdDiagnostic> = {}): ClangdDiagnostic => ({
  severity: 1,
  code: 'undeclared_var_use',
  message: 'use of undeclared identifier k',
  range: { start: { line: 3, character: 18 }, end: { line: 3, character: 19 } },
  ...over
});

describe('clangd diagnostics in the team words', () => {
  it('words a mapped code, and marks it where clangd pointed, 1-based', () => {
    const [mark] = liveMarks([diagnostic()], 'int a;\nint b;\nint c;\nprintf("%d", k);\n', TABLE);
    expect(mark).toEqual({
      line: 4,
      column: 19,
      severity: 'error',
      kind: 'undeclared',
      say: "The compiler doesn't know this name at this point.",
      raw: 'use of undeclared identifier k'
    });
  });

  it('falls back for a code no entry lists', () => {
    const [mark] = liveMarks([diagnostic({ code: 'something_new' })], 'x\n', TABLE);
    expect(mark.kind).toBe('unknown');
    expect(mark.say).toBe('The compiler stopped here.');
  });

  it('keeps only the first line of the message, without its fix hints', () => {
    const [mark] = liveMarks(
      [
        diagnostic({
          code: 'undeclared_var_use',
          message: "use of undeclared identifier 'print'; did you mean 'printf'? (fix available)\nnote: something"
        })
      ],
      'x\n',
      TABLE
    );
    expect(mark.raw).toBe("use of undeclared identifier 'print'");
  });

  it('drops notes, hints and the language server own checks', () => {
    const kept = liveMarks(
      [
        diagnostic(),
        diagnostic({ severity: 3 }),
        diagnostic({ severity: 4 }),
        diagnostic({ source: 'clangd', code: 'unused-includes' })
      ],
      'x\n',
      TABLE
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].kind).toBe('undeclared');
  });

  it('moves a missing semicolon back to the end of the code above it', () => {
    const code = '#include <stdio.h>\n\nint main(void) {\n  int c\n  printf("%d", c);\n}\n';
    // clangd points at the next token: `printf` on line 5, column 3.
    const [mark] = liveMarks(
      [
        diagnostic({
          code: 'expected_semi_declaration',
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } }
        })
      ],
      code,
      TABLE
    );
    expect(mark.kind).toBe('unfinished_statement');
    expect([mark.line, mark.column]).toEqual([4, 8]);
  });
});

describe('the end of the previous line of code', () => {
  it('leaves a mark that is not alone on its line where it is', () => {
    expect(endOfPreviousLine(['  int c, k;'], 1, 5)).toEqual([1, 5]);
  });

  it('skips comment-only lines on the way back', () => {
    const lines = ['  int c, k', '  // work out the sum', '  printf("%d", c % k);'];
    expect(endOfPreviousLine(lines, 3, 3)).toEqual([1, 11]);
  });

  it('counts a trailing comment as the code before it', () => {
    expect(endOfPreviousLine(['  int c;  // the count'], 2, 1)).toEqual([1, 9]);
  });

  it('gives up and stays put when there is no code above', () => {
    expect(endOfPreviousLine(['', '  printf("x");'], 2, 3)).toEqual([2, 3]);
  });
});
