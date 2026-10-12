/**
 * Any artifact value as the text a model reads.
 *
 * Ported from `clive-userflow/src/clive/prompts.py:61-198`. A value is a string,
 * a list of case rows (`kind: cases`, `{input, output, working}`), or an outline
 * (`kind: steps`, `{text, level}`). Every model call, the evidence audit and the
 * carry-forward read a value through {@link fieldText}, so this is the one path
 * from an artifact to model text.
 */

export interface CaseRow {
  input: string;
  output: string;
  working: string;
}

export interface OutlineRow {
  text: string;
  level: number;
}

export type ArtifactValue = string | CaseRow[] | OutlineRow[];

/** Nesting a Design outline may express. */
export const STEP_LEVELS = 3;

const CASE_ROW_KEYS = ['input', 'output', 'working'] as const;

/** A `cases` value as string-valued rows, or `null` if it is not one. */
export function caseRows(value: unknown): CaseRow[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((row) => {
    const r = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const out = {} as CaseRow;
    for (const key of CASE_ROW_KEYS) out[key] = String(r[key] ?? '').replace(/\r\n/g, '\n');
    return out;
  });
}

const MARKER = /^(?:(?:\d+|[a-z]|[ivx]{1,4})[.)]|[-*])\s+/i;

/**
 * A `steps` value as `{text, level}` rows with levels made valid, or `null` if it
 * is not one. Valid: the first step at level 0, each step at most one level
 * deeper than the step before it, and no deeper than `STEP_LEVELS - 1`.
 */
export function outlineRows(value: unknown): OutlineRow[] | null {
  if (!Array.isArray(value) || !value.every((r) => r !== null && typeof r === 'object' && 'text' in r)) {
    return null;
  }
  const rows: OutlineRow[] = [];
  let prev = -1;
  for (const raw of value as Record<string, unknown>[]) {
    let level = Number.parseInt(String(raw.level ?? 0), 10);
    if (Number.isNaN(level)) level = 0;
    level = Math.max(0, Math.min(level, prev + 1, STEP_LEVELS - 1));
    rows.push({
      text: String(raw.text ?? '')
        .replace(/\r\n/g, ' ')
        .replace(/\n/g, ' '),
      level
    });
    prev = level;
  }
  return rows;
}

/**
 * Outline rows from text: one step per non-blank line, one leading marker
 * stripped, the level read from indentation relative to the lines around it.
 */
export function parseOutline(text: string): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const widths: number[] = [];
  for (const line of String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')) {
    if (!line.trim()) continue;
    const lead = line.slice(0, line.length - line.trimStart().length);
    const width = (lead.match(/ /g)?.length ?? 0) + 4 * (lead.match(/\t/g)?.length ?? 0);
    while (widths.length && widths[widths.length - 1] > width) widths.pop();
    if (!widths.length || widths[widths.length - 1] < width) widths.push(width);
    const level = widths.length - 1;
    const body = line.trim();
    const stripped = body.replace(MARKER, '');
    rows.push({ text: stripped || body, level });
  }
  return outlineRows(rows) ?? [];
}

/** The marker a numbered/indented outline shows for step `n` at `level`. */
export function marker(level: number, n: number): string {
  if (level === 0) return `${n}.`;
  if (level === 1) return `${'abcdefghijklmnopqrstuvwxyz'[(n - 1) % 26]}.`;
  let out = '';
  let value = n;
  for (const [v, sym] of [
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i']
  ] as const) {
    while (value >= v) {
      out += sym;
      value -= v;
    }
  }
  return `${out}.`;
}

/**
 * Outline rows as the numbered, indented text a model reads (three spaces per
 * level). Blank steps are dropped before numbering; numbering restarts under
 * each parent.
 */
export function outlineText(value: unknown): string {
  const kept = (outlineRows(value) ?? []).filter((r) => r.text.trim());
  const rows = outlineRows(kept) ?? [];
  const counts = new Array<number>(STEP_LEVELS).fill(0);
  const lines: string[] = [];
  for (const r of rows) {
    counts[r.level] += 1;
    for (let deeper = r.level + 1; deeper < STEP_LEVELS; deeper += 1) counts[deeper] = 0;
    lines.push(`${'   '.repeat(r.level)}${marker(r.level, counts[r.level])} ${r.text.trim()}`);
  }
  return lines.join('\n');
}

/** Any artifact value as the text a model reads. */
export function fieldText(value: unknown): string {
  if (outlineRows(value) !== null) return outlineText(value);
  const rows = caseRows(value);
  if (rows === null) return value === null || value === undefined ? '' : String(value);
  const blocks: string[] = [];
  rows.forEach((r, i) => {
    if (![r.input, r.output, r.working].some((v) => v.trim())) return;
    const lines = [`Case ${i + 1}`, `Input: ${r.input.trim()}`, `Expected output: ${r.output.trim()}`];
    if (r.working.trim()) lines.push(`How I got it: ${r.working.trim()}`);
    blocks.push(lines.join('\n'));
  });
  return blocks.join('\n\n');
}

/** `artifact` with every value rendered by {@link fieldText}. */
export function textArtifact(artifact: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(artifact ?? {})) out[key] = fieldText(value);
  return out;
}

/** `priorArtifacts` with each field's value rendered by {@link fieldText}. */
export function textPrior(
  priorArtifacts: PriorArtifact[] | null | undefined
): { label: string; fields: { label: string; value: string }[] }[] {
  return (priorArtifacts ?? []).map((p) => ({
    label: p.label,
    fields: (p.fields ?? []).map((f) => ({ label: f.label, value: fieldText(f.value) }))
  }));
}

/** One earlier phase's work, carried into a later phase's prompt as context. */
export interface PriorArtifact {
  label: string;
  fields: { label: string; value: unknown }[];
}
