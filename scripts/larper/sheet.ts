/**
 * A run's results as something to read: one Markdown sheet per phase, and every
 * result in full as JSON Lines.
 *
 * The sheet is for the team to read each response against the behaviour they
 * expect. A filled expectation is marked ✓ or ✗ here and nowhere fails a run.
 */
import { caseRows, outlineRows, outlineText } from '../../plugins/plugin-clive/server/artifact';
import { phaseDoc } from '../../plugins/plugin-clive/server/content/load';
import type { Category, Expect, PhaseId, Result } from './types';

const yesNo = (value: boolean | undefined) => (value === undefined ? 'unknown' : value ? 'yes' : 'no');

function expectLine(expect: Expect | null): string {
  if (!expect) return 'Expected: not decided yet';
  const parts: string[] = [];
  if (expect.blocks !== undefined) parts.push(expect.blocks ? 'blocks' : 'does not block');
  if (expect.fails?.length) parts.push(`unmet: ${expect.fails.join(', ')}`);
  if (expect.situations?.length) parts.push(`situation: ${expect.situations.join(' or ')}`);
  return `Expected: ${parts.join('; ') || 'not decided yet'}`;
}

/** The answer as the student would see their own work on the page. */
function written(phase: PhaseId, artifact: Record<string, unknown> | undefined): string[] {
  const lines: string[] = [];
  if (!artifact) return lines;
  for (const field of phaseDoc(phase).artifact_fields) {
    const value = artifact[field.id];
    if (value === undefined) continue;
    lines.push(`**${field.label}**`, '');
    if (field.kind === 'code') {
      lines.push('```c', String(value).replace(/\n+$/, ''), '```');
    } else if (field.kind === 'cases') {
      for (const row of caseRows(value) ?? []) {
        lines.push('```', `Input: ${row.input}`, `Output: ${row.output}`, `Working: ${row.working}`, '```');
      }
    } else if (field.kind === 'steps' && outlineRows(value) !== null) {
      lines.push('```', outlineText(value), '```');
    } else {
      lines.push(
        ...String(value)
          .split('\n')
          .map((l) => `> ${l}`)
      );
    }
    lines.push('');
  }
  return lines;
}

function row(phase: PhaseId, r: Result): string[] {
  const marks = [
    r.pass === 2 ? '(repeat)' : '',
    r.offCategory ? '**off-category**' : '',
    r.matches === null ? '' : r.matches ? '✓' : '✗'
  ].filter(Boolean);
  const lines = [
    `### Variant ${r.answer.variant}${r.answer.writtenBy === 'hand' ? ' (written by hand)' : ''} ${marks.join(' ')}`.trimEnd(),
    ''
  ];
  if (r.pass === 1) lines.push(...written(phase, r.answer.artifact));
  if (r.blocked === null) {
    lines.push(`ERROR: ${r.error ?? 'unknown'}`, '');
    return lines;
  }
  if (phase === 'implement') {
    lines.push(`- Compiled: ${yesNo(r.observed.compiled)}; examples passed: ${yesNo(r.observed.publicPassed)}`);
  }
  lines.push(
    `- Blocked: ${r.blocked ? 'yes' : 'no'}`,
    `- Failed: ${r.failed.join(', ') || 'none'}`,
    `- Optional points unmet: ${r.advisoryUnmet.join(', ') || 'none'}`,
    `- Situation: ${r.situation ?? 'none (no feedback given)'}`
  );
  if (r.focusFields.length) lines.push(`- Feedback shown on: ${r.focusFields.join(', ')}`);
  if (r.error) lines.push(`- ERROR: ${r.error}`);
  if (r.feedback) lines.push('', ...r.feedback.split('\n').map((l) => `> ${l}`));
  lines.push('', `_${(r.ms / 1000).toFixed(1)} s_`, '');
  return lines;
}

function situationCounts(results: Result[]): string {
  const counts = new Map<string, number>();
  for (const r of results) if (r.situation) counts.set(r.situation, (counts.get(r.situation) ?? 0) + 1);
  return [...counts].map(([id, n]) => `${id} ×${n}`).join(', ') || 'none';
}

export function sheet(phase: PhaseId, categories: Category[], results: Result[], skipped: string[]): string {
  const of = (id: string) => results.filter((r) => r.answer.category === id);
  const lines = [
    `# Larper: ${phaseDoc(phase).label}`,
    '',
    '| Category | Variants | Blocked | Situations | Off-category |',
    '|---|---|---|---|---|'
  ];
  for (const c of categories) {
    const mine = of(c.id);
    const first = mine.filter((r) => r.pass === 1);
    lines.push(
      `| ${c.name} | ${first.length} | ${first.filter((r) => r.blocked).length} | ${situationCounts(mine)} | ${first.filter((r) => r.offCategory).length} |`
    );
  }
  lines.push('');
  for (const c of categories) {
    lines.push(`## ${c.name}`, '', expectLine(c.expect), '');
    const mine = of(c.id);
    if (!mine.length) lines.push('no answers', '');
    for (const r of mine) lines.push(...row(phase, r));
  }
  if (skipped.length) {
    lines.push(
      '## Skipped',
      '',
      'Saved answers whose category is no longer in `categories.yaml`; they were not run.',
      '',
      ...skipped.map((id) => `- ${id}`),
      ''
    );
  }
  return lines.join('\n');
}

export function jsonLines(results: Result[]): string {
  return results.map((r) => `${JSON.stringify(r)}\n`).join('');
}
