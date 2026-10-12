/**
 * The four PCDIT phases, in the order CLive gates them (Problem, Cases, Design,
 * Implement -- `case_design` runs before `algorithm_design` despite the name
 * order, per each phase's own `order`).
 *
 * A hand-port of `plugins/plugin-clive/content/phases/*.yaml` for the *display*:
 * labels, fields, hints, examples and task descriptions. The server judges from
 * the YAML itself; `contentAgreement.test.ts` pins the two to agree on field
 * metadata, since a field id the server does not know means a submitted artifact
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
  label: string;
  kind: ArtifactFieldKind;
  /** The question heading a stepped phase shows above the field. */
  prompt?: string;
  hint?: string;
  /** A worked example shown under the field. A `cases` field's example is a list of rows. */
  example?: string | CaseRow[] | OutlineRow[];
  rows?: number;
  /** An optional extra case (Cases 3-5), offered only after every required case has passed. */
  added?: boolean;
  language?: string;
}

export interface PhaseReference {
  label: string;
  url: string;
}

export interface PhaseConfig {
  phase: string;
  label: string;
  order: number;
  taskDescription: string;
  /** The sample problem every field's example answers, shown above the example. */
  exampleProblem?: string;
  artifactFields: ArtifactField[];
  references?: PhaseReference[];
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
 * Whether a step holds enough to judge: every box of a case card (input may be
 * empty -- an empty line is a real case for a problem that reads text), any text
 * for the others.
 */
export function stepComplete(field: ArtifactField, value: unknown): boolean {
  if (field.kind === 'cases') {
    const row = rowsOf(value)[0] ?? blankRow();
    return ['output', 'working'].every((key) => String(row[key as 'output' | 'working'] || '').trim());
  }
  return isFilled(value);
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

const RECTANGLE =
  'Read the length and width of a rectangle, each a whole number of centimeters from 1 to\n100. Print the area.';

const CASE_PROMPT =
  'Try to think of a normal use of the program. What values would you type in? What should the program display, and how did you get it?';
const CASE_HINT = 'Type the input as you would in the program, then work out the output by hand and show how.';

const NORMAL_EXAMPLE: CaseRow[] = [{ input: '4 6', output: '24', working: '4 * 6 = 24.' }];
const EDGE_EXAMPLE: CaseRow[] = [
  { input: '1 1', output: '1', working: 'The smallest length and width allowed are 1 and 1. 1 * 1 = 1.' }
];

export const PHASES: readonly PhaseConfig[] = [
  {
    phase: 'problem_definition',
    label: 'Problem',
    order: 1,
    layout: 'steps',
    taskDescription: 'Describe the problem in your own words, without writing any code yet.',
    exampleProblem: RECTANGLE,
    artifactFields: [
      {
        id: 'summary',
        label: 'Summary',
        kind: 'text',
        prompt: 'In your own words, what is the program supposed to do?',
        hint: "Please write around 2-3 sentences, as if explaining to a classmate who hasn't read the problem.",
        example: "The program asks for a rectangle's length and width and prints its area.",
        rows: 4
      },
      {
        id: 'inputs',
        label: 'Inputs',
        kind: 'text',
        prompt: 'What should the program ask for?',
        hint: 'List each value in the order the program reads it. Give each a C type (int, float, double or char) and any limits the problem gives, like "between 1 and 100". If the problem gives no limits, say so.',
        example: '1. length: an int from 1 to 100.\n2. width: an int from 1 to 100.\nLength is read first, then width.',
        rows: 4
      },
      {
        id: 'outputs',
        label: 'Outputs',
        kind: 'text',
        prompt: 'What should the program display?',
        hint: 'If it prints a single value, give its C type (int, float, double or char). Say exactly what it looks like: how many decimal places, any words around the number (such as Age: ), in one line or several. If it prints text or a pattern of several values, describing exactly how it looks is enough.',
        example: 'The area as an int, for example, 24.',
        rows: 3
      }
    ]
  },
  {
    phase: 'case_design',
    label: 'Cases',
    order: 2,
    layout: 'steps',
    judge: 'per_step',
    taskDescription: 'Work out two examples of the problem by hand.',
    exampleProblem: RECTANGLE,
    artifactFields: [
      {
        id: 'normal_cases',
        label: 'Case 1',
        kind: 'cases',
        prompt: CASE_PROMPT,
        hint: CASE_HINT,
        example: NORMAL_EXAMPLE
      },
      {
        id: 'edge_cases',
        label: 'Case 2',
        kind: 'cases',
        prompt: CASE_PROMPT,
        hint: CASE_HINT,
        example: EDGE_EXAMPLE
      },
      {
        id: 'case_3',
        label: 'Case 3',
        kind: 'cases',
        added: true,
        prompt: CASE_PROMPT,
        hint: CASE_HINT,
        example: EDGE_EXAMPLE
      },
      {
        id: 'case_4',
        label: 'Case 4',
        kind: 'cases',
        added: true,
        prompt: CASE_PROMPT,
        hint: CASE_HINT,
        example: EDGE_EXAMPLE
      },
      {
        id: 'case_5',
        label: 'Case 5',
        kind: 'cases',
        added: true,
        prompt: CASE_PROMPT,
        hint: CASE_HINT,
        example: EDGE_EXAMPLE
      }
    ]
  },
  {
    phase: 'algorithm_design',
    label: 'Design',
    order: 3,
    layout: 'steps',
    taskDescription: 'Plan the solution in plain English without using C yet.',
    exampleProblem: 'Read a whole number n, which is 1 or more. Print the sum 1 + 2 + ... + n.',
    artifactFields: [
      {
        id: 'steps',
        label: 'Algorithm steps',
        kind: 'steps',
        prompt: 'What sequence of steps would solve the problem?',
        hint: 'Place one action per step. You may use indentation to express conditional or repeating statements.',
        example: [
          { text: 'Read n.', level: 0 },
          { text: 'Set the total to 0 and the counter to 1.', level: 0 },
          { text: 'While the counter is at most n:', level: 0 },
          { text: 'Add the counter to the total.', level: 1 },
          { text: 'Add 1 to the counter.', level: 1 },
          { text: 'Print the total.', level: 0 }
        ]
      }
    ]
  },
  {
    phase: 'implement',
    label: 'Implement',
    order: 4,
    taskDescription:
      'Write the C program for your plan. Press Run to test it on the examples. Press Submit when ' +
      "it works for a final check against test cases you haven't seen. Print only what the problem " +
      'asks for, with no extra messages like "Enter a number:". Don\'t use AI tools like ChatGPT.',
    artifactFields: [
      {
        id: 'code',
        label: 'Your C program',
        kind: 'code',
        language: 'c',
        hint: 'Write your whole program here.',
        rows: 20
      }
    ]
  }
];
