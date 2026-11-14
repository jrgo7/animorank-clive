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

  for (const result of results) {
    if (result.pass !== 1 || result.blocked === null) continue;
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
      const own =
        shown.length === 1
          ? fieldText(result.answer.artifact[shown[0].id])
          : shown.map((f) => `${f.label}: ${fieldText(result.answer.artifact[f.id])}`).join('\n\n');
      const earlier = (NEEDS_EARLIER[verdict.criterion_id] ?? [])
        .map((id) => prior.find((p) => p.label === phaseDoc(id).label))
        .filter((p): p is PriorArtifact => p !== undefined)
        .map(
          (p) =>
            `${p.label} (the student's earlier work):\n${p.fields.map((f) => `${f.label}: ${fieldText(f.value)}`).join('\n')}`
        );
      const text = earlier.length ? [`${doc.label}:\n${own}`, ...earlier].join('\n\n') : own;
      const question = `${LETTER[phase]}${Math.max(0, doc.artifact_fields.indexOf(shown[0])) + 1}`;
      const line = sheet.length + 1;
      sheet.push([
        id,
        question,
        verdict.criterion_id,
        text,
        '',
        '',
        '',
        '',
        `=IF(OR(E${line}="",G${line}=""),"",IF(E${line}=G${line},"Agree","Disagree"))`
      ]);
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

/** CSV a spreadsheet opens as UTF-8, with formulas left as formulas. */
export function csv(rows: string[][]): string {
  const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return `﻿${rows.map((r) => `${r.map(cell).join(',')}\r\n`).join('')}`;
}
