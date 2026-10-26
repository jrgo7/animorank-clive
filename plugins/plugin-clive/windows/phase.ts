/**
 * The four PCDIT phases, in the order CLive gates them (Problem, Cases, Design,
 * Implement -- `case_design` runs before `algorithm_design` despite the name
 * order, per each phase's own `order` in the YAML).
 *
 * Load-bearing metadata only. Each phase's UI, flow and wording is its own window
 * (`ProblemWindow.window.svelte`, `CaseDesignWindow.window.svelte`,
 * `AlgorithmDesignWindow.window.svelte`, `ImplementWindow.window.svelte`); what
 * stays here is what the server contract and the shared state need: the phase id
 * and its fields' ids, labels, kinds and `added` flags, plus the layout and judge
 * shape. A label is prompt-visible -- the client sends it to the judge as
 * `prior_artifacts`, and the nudge and stuck prompts render it -- so it cannot
 * drift from the YAML.
 *
 * A hand-port of `plugins/plugin-clive/content/phases/*.yaml`'s metadata: the
 * server judges from the YAML itself, and `contentAgreement.test.ts` pins the two
 * to agree, since a field id the server does not know means a submitted artifact
 * key means nothing to the judge.
 *
 * This module is plain TypeScript (no Svelte, no YAML) so the browser and the
 * tests can both import it.
 */

/** One row of a `cases`-kind artifact field: an input, its expected output, and how the student got it. */
export interface CaseRow {
  input: string;
  output: string;
  working: string;
}

/** One row of a `steps`-kind artifact field: a step's text and its nesting depth (0-2). */
export interface OutlineRow {
  text: string;
  level: number;
}

export type ArtifactValue = string | CaseRow[] | OutlineRow[];

export type ArtifactFieldKind = 'text' | 'cases' | 'code' | 'steps';

export interface ArtifactField {
  id: string;
  /** Prompt-visible: the judge receives it as part of `prior_artifacts`. */
  label: string;
  kind: ArtifactFieldKind;
  /** An optional extra case (Cases 3-5), offered only after every required case has passed. */
  added?: boolean;
}

export interface PhaseConfig {
  phase: string;
  /** Prompt-visible: the judge receives it as part of `prior_artifacts`. */
  label: string;
  artifactFields: ArtifactField[];
  /** A phase that shows one field at a time (`layout: steps`). */
  layout?: 'steps';
  /** A phase submitted one field at a time, each judged on its own. */
  judge?: 'per_step';
}

/** Nesting a Design outline may express. */
export const STEP_LEVELS = 3;

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

const CASE_ROW_KEYS = ['input', 'output', 'working'] as const;

export function blankRow(): CaseRow {
  return { input: '', output: '', working: '' };
}

function rowFilled(row: CaseRow | undefined): boolean {
  return !!row && CASE_ROW_KEYS.some((key) => String(row[key] || '').trim());
}

/** A `cases` value as rows; a legacy free-text value keeps its writing as one row's working. */
export function rowsOf(value: unknown): CaseRow[] {
  if (Array.isArray(value) && value.length) {
    return (value as Record<string, unknown>[]).map((r) => ({
      input: String(r?.input ?? ''),
      output: String(r?.output ?? ''),
      working: String(r?.working ?? '')
    }));
  }
  if (typeof value === 'string' && value.trim()) return [{ ...blankRow(), working: value }];
  return [blankRow()];
}

export function isOutline(value: unknown): value is OutlineRow[] {
  return Array.isArray(value) && value.every((r) => r && typeof r === 'object' && 'text' in r);
}

/** Whether a field's value holds anything a phase can be judged on. */
export function isFilled(value: unknown): boolean {
  if (isOutline(value)) return value.some((r) => String(r.text || '').trim());
  if (Array.isArray(value)) return value.some((r) => rowFilled(r as CaseRow));
  return String(value ?? '').trim() !== '';
}

/** A `steps` value with levels made valid: first 0, each at most one deeper than the last. */
export function normaliseOutline(rows: OutlineRow[]): OutlineRow[] {
  let prev = -1;
  for (const row of rows) {
    row.level = Math.max(0, Math.min(row.level || 0, prev + 1, STEP_LEVELS - 1));
    prev = row.level;
  }
  return rows;
}

/**
 * Outline rows from text: one step per non-blank line, one leading marker
 * stripped, the level read from indentation relative to the lines around it.
 * The same rules as the server's `parseOutline`.
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
    const body = line.trim();
    const stripped = body.replace(/^(?:(?:\d+|[a-z]|[ivx]{1,4})[.)]|[-*])\s+/i, '');
    rows.push({ text: stripped || body, level: widths.length - 1 });
  }
  return normaliseOutline(rows);
}

/**
 * Each row's marker -- `1.` / `a.` / `i.` -- restarting under each parent. Blank
 * rows get one too while editing, so the student sees where the next step lands.
 */
export function markersFor(rows: OutlineRow[]): string[] {
  const counts = [0, 0, 0];
  return rows.map((row) => {
    counts[row.level] += 1;
    for (let deeper = row.level + 1; deeper < STEP_LEVELS; deeper++) counts[deeper] = 0;
    const n = counts[row.level];
    if (row.level === 0) return `${n}.`;
    if (row.level === 1) return `${'abcdefghijklmnopqrstuvwxyz'[(n - 1) % 26]}.`;
    return `${ROMAN[n - 1] || n}.`;
  });
}

/** An outline as the indented, numbered text a model reads. */
export function outlineText(rows: OutlineRow[]): string {
  const kept = normaliseOutline(rows.filter((r) => String(r.text || '').trim()).map((r) => ({ ...r })));
  const marks = markersFor(kept);
  return kept.map((row, i) => `${'   '.repeat(row.level)}${marks[i]} ${row.text.trim()}`).join('\n');
}

export function isStepped(config: PhaseConfig): boolean {
  return config.layout === 'steps';
}

export function isPerStep(config: PhaseConfig): boolean {
  return config.judge === 'per_step';
}

/** The fields a student is working on: every field, less the added cases not yet added. */
export function inPlay(config: PhaseConfig, added: number): ArtifactField[] {
  let left = added || 0;
  return config.artifactFields.filter((field) => !field.added || left-- > 0);
}

/** How many optional cases a phase offers. */
export function maxAdded(config: PhaseConfig): number {
  return config.artifactFields.filter((field) => field.added).length;
}

/** A field's starting value. */
export function blankValueFor(field: ArtifactField, startingCode: string): ArtifactValue {
  if (field.kind === 'code') return startingCode;
  if (field.kind === 'cases') return [blankRow()];
  if (field.kind === 'steps') return [{ text: '', level: 0 }];
  return '';
}

/**
 * The earlier in-play case field whose input this one repeats, or `null`. The
 * same input twice passes every check and teaches nothing, so Submit waits for a
 * new one. Whitespace is ignored: "2 80 90" and "2\n80 90" are the same input.
 */
export function duplicateOf(
  config: PhaseConfig,
  artifact: Record<string, ArtifactValue>,
  field: ArtifactField,
  added: number
): ArtifactField | null {
  if (config.judge !== 'per_step' || field.kind !== 'cases') return null;
  const norm = (value: unknown) =>
    String((rowsOf(value)[0] || {}).input || '')
      .split(/\s+/)
      .filter(Boolean)
      .join(' ');
  const mine = norm(artifact[field.id]);
  if (!mine) return null;
  const fields = inPlay(config, added);
  return (
    fields
      .slice(0, fields.indexOf(field))
      .find((other) => other.kind === 'cases' && norm(artifact[other.id]) === mine) ?? null
  );
}

export const PHASES: readonly PhaseConfig[] = [
  {
    phase: 'problem_definition',
    label: 'Problem',
    layout: 'steps',
    artifactFields: [
      { id: 'summary', label: 'Summary', kind: 'text' },
      { id: 'inputs', label: 'Inputs', kind: 'text' },
      { id: 'outputs', label: 'Outputs', kind: 'text' }
    ]
  },
  {
    phase: 'case_design',
    label: 'Cases',
    layout: 'steps',
    judge: 'per_step',
    artifactFields: [
      { id: 'normal_cases', label: 'Case 1', kind: 'cases' },
      { id: 'edge_cases', label: 'Case 2', kind: 'cases' },
      { id: 'case_3', label: 'Case 3', kind: 'cases', added: true },
      { id: 'case_4', label: 'Case 4', kind: 'cases', added: true },
      { id: 'case_5', label: 'Case 5', kind: 'cases', added: true }
    ]
  },
  {
    phase: 'algorithm_design',
    label: 'Design',
    layout: 'steps',
    artifactFields: [{ id: 'steps', label: 'Algorithm steps', kind: 'steps' }]
  },
  {
    phase: 'implement',
    label: 'Implement',
    artifactFields: [{ id: 'code', label: 'Your C program', kind: 'code' }]
  }
];

/** The phase whose window needs AnimoRank's own code editor and test-case results. */
export const IMPLEMENT_PHASE = 'implement';

/** The panel the Implement phase is shown in. */
export const IMPLEMENT_WINDOW_KEY = `clive:${IMPLEMENT_PHASE}`;

/** Every window the CLive plugin owns on the solve page. */
export const CLIVE_WINDOW_KEYS: readonly string[] = ['clive:track', ...PHASES.map((phase) => `clive:${phase.phase}`)];

/**
 * AnimoRank's own problem-statement panel. It stays open beside CLive: the
 * student reads the problem while they work on a phase, rather than reopening
 * the same text inside the phase window.
 */
export const PROBLEM_INFO_WINDOW_KEY = 'problem_info';

/** The AnimoRank windows the Implement phase needs: the code the student writes, and its results. */
export const IMPLEMENT_WINDOW_KEYS: readonly string[] = ['code_editor', 'test_cases'];

/**
 * The window the phase window goes into when it has to be created: AnimoRank's
 * own code editor, whose group is the right-hand column. Joining it rather than
 * asking for a column of its own keeps the page's two columns as the page's own
 * default layout made them -- the statement on the left, the phases on the right
 * -- instead of squeezing the statement to make room for a third.
 */
export const PHASE_PLACEMENT_REFERENCE = 'code_editor';

/**
 * The windows that stay open while `phase` is the one the student is on: the
 * problem statement, CLive's own, plus the two the Implement phase needs -- and
 * only while it is open, since the rest of the page belongs to CLive.
 */
export function solveLayoutKeys(phase: string): string[] {
  const keys = [PROBLEM_INFO_WINDOW_KEY, ...CLIVE_WINDOW_KEYS];
  return phase === IMPLEMENT_PHASE ? [...keys, ...IMPLEMENT_WINDOW_KEYS] : keys;
}

/**
 * The CLive strip's height, in pixels: its one row of phase tiles, the line above
 * them, its padding, and dockview's tab header -- measured on the page. Pinned at
 * both ends: with only a minimum, closing the page's editor windows handed the
 * freed space to the strip as well as the phase window, leaving it half the column.
 */
const PHASE_TRACK_HEIGHT = 124;

export const PHASE_TRACK_SIZING = {
  initialHeight: PHASE_TRACK_HEIGHT,
  minimumHeight: PHASE_TRACK_HEIGHT,
  maximumHeight: PHASE_TRACK_HEIGHT
};
