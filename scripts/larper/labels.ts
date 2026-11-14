/**
 * A run's judged answers in the layout the team labels by hand: one row per answer
 * and criterion, with the part of the answer the criterion is about and blank
 * columns for two labellers.
 *
 * Two tables, joined by row id. The sheet is what a labeller sees, and holds
 * nothing of what CLive decided or which category the answer was written as, so
 * the labels are made blind. The key holds the rest.
 */
import { fieldText, type PriorArtifact } from '../../plugins/plugin-clive/server/artifact';
import { phaseDoc, rubricDoc } from '../../plugins/plugin-clive/server/content/load';
import type { PhaseId, Result } from './types';

const LETTER: Record<PhaseId, string> = {
  problem_definition: 'P',
  case_design: 'C',
  algorithm_design: 'D',
  implement: 'I'
};

/**
 * The criteria judged against the student's earlier work as well as this phase's:
 * a labeller needs both in front of them. Read off each criterion's guidance in
 * `content/criteria/`; a test checks every id here is a real criterion.
 */
export const NEEDS_EARLIER: Record<string, PhaseId[]> = {
  traceable_on_own_case: ['case_design'],
  covers_own_edge_cases: ['case_design'],
  follows_own_design: ['algorithm_design'],
  state_matches_design: ['algorithm_design'],
  handles_own_edge_cases: ['case_design']
};

const SHEET_HEAD = [
  'Row ID',
  'Question',
  'Criterion',
  'Student artifact',
  'Label A',
  'Reason A',
  'Label B',
  'Reason B',
  'A and B agreement'
];
const KEY_HEAD = [
  'Row ID',
  'Phase',
  'Category',
  'Variant',
  'Criterion',
  'Required',
  'CLive verdict',
  'Decided by',
  'CLive evidence',
  'Situation',
  'Feedback'
];

interface RecordedVerdict {
  criterion_id: string;
  verdict: string;
  gate?: string;
  evidence?: string;
  source?: string;
}

/** The same in every row, so it stays right wherever the row is pasted. */
const AGREEMENT =
  '=IF(OR(INDEX(E:E,ROW())="",INDEX(G:G,ROW())=""),"",IF(INDEX(E:E,ROW())=INDEX(G:G,ROW()),"Agree","Disagree"))';
const AGREEMENT_COLUMN = SHEET_HEAD.indexOf('A and B agreement');

/**
 * The answers in an order that does not follow their categories: the team wrote
 * the category list, so answers in its order would tell a labeller which is which.
 * Seeded, so two runs over the same answers give the same sheet.
 */
function shuffled<T>(items: T[], seed = 20261114): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function verdictsOf(result: Result): RecordedVerdict[] {
  const record = result.record as { response?: { verdicts?: RecordedVerdict[] } } | null;
  return record?.response?.verdicts ?? [];
}

/** `prior` is the earlier work every answer of this phase was written and judged against. */
export function labelRows(
  phase: PhaseId,
  results: Result[],
  prior: PriorArtifact[] = []
): { sheet: string[][]; key: string[][] } {
  const doc = phaseDoc(phase);
  const criteria = new Map(rubricDoc(phase).criteria.map((c) => [c.id, c]));
  const sheet = [SHEET_HEAD];
  const key = [KEY_HEAD];
  let n = 0;

  for (const result of shuffled(results.filter((r) => r.pass === 1 && r.blocked !== null))) {
    for (const verdict of verdictsOf(result)) {
      n += 1;
      const id = `L${LETTER[phase]}${String(n).padStart(3, '0')}`;
      const about = criteria.get(verdict.criterion_id)?.fields ?? [];
      // The fields the criterion is about that this answer filled in; the whole answer otherwise.
      const named = doc.artifact_fields.filter(
        (f) => about.includes(f.id) && result.answer.artifact[f.id] !== undefined
      );
      const shown = named.length
        ? named
        : doc.artifact_fields.filter((f) => result.answer.artifact[f.id] !== undefined);
      // Every block starts with its field's label: the labeller sees which box it was, and a
      // cell never starts with a character a spreadsheet would read as a formula.
      const own = shown.map((f) => `${f.label}:\n${fieldText(result.answer.artifact[f.id])}`).join('\n\n');
      const earlier = (NEEDS_EARLIER[verdict.criterion_id] ?? [])
        .map((id) => prior.find((p) => p.label === phaseDoc(id).label))
        .filter((p): p is PriorArtifact => p !== undefined)
        .map(
          (p) =>
            `${p.label} (the student's earlier work):\n${p.fields.map((f) => `${f.label}: ${fieldText(f.value)}`).join('\n')}`
        );
      const text = [own, ...earlier].join('\n\n');
      const question = `${LETTER[phase]}${Math.max(0, doc.artifact_fields.indexOf(shown[0])) + 1}`;
      sheet.push([id, question, verdict.criterion_id, text, '', '', '', '', AGREEMENT]);
      key.push([
        id,
        phase,
        result.answer.category,
        String(result.answer.variant),
        verdict.criterion_id,
        verdict.gate === 'advisory' ? 'no' : 'yes',
        verdict.verdict,
        verdict.source ?? 'judge',
        verdict.evidence ?? '',
        result.situation ?? '',
        result.feedback
      ]);
    }
  }
  return { sheet, key };
}

/** The mark that tells a spreadsheet the file is UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** The columns of the labelling sheet that hold a formula on purpose. */
export const SHEET_FORMULA_COLUMNS = [AGREEMENT_COLUMN];

/**
 * CSV a spreadsheet opens as UTF-8. Text that starts with a character a spreadsheet
 * reads as a formula (a student's "- first, read the number") is given a leading
 * apostrophe; only `formulaColumns` are left to be formulas.
 */
export function csv(rows: string[][], formulaColumns: number[] = []): string {
  const safe = (value: string, column: number) =>
    !formulaColumns.includes(column) && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return `${BOM}${rows.map((r) => `${r.map((value, column) => cell(safe(value, column))).join(',')}\r\n`).join('')}`;
}
