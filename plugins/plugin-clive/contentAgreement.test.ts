/**
 * The client's display config must agree with the phase YAML the server judges
 * from. A field id the two disagree on means a submitted artifact key means
 * nothing to the judge; a divergent `judge`/`layout` changes when things are
 * judged; and everything the student reads — labels, questions, hints, examples,
 * the task description — is authored in the YAML, so a sync with the prototype is
 * a matter of copying the YAML in and following what this test reports.
 */
import { describe, expect, it } from 'vitest';
import { phaseDoc } from './server/content/load';
import { PHASES } from './windows/phase';

/** Prose wrapped differently in the two files still reads the same. */
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const collapseExample = (example: unknown): unknown => (typeof example === 'string' ? collapse(example) : example);

describe('phase display config', () => {
  it('covers every phase the server knows, in the same order', () => {
    expect(PHASES.map((p) => p.phase)).toEqual(['problem_definition', 'case_design', 'algorithm_design', 'implement']);
  });

  it('agrees with the phase YAML on labels, layout, judge and fields', () => {
    for (const config of PHASES) {
      const doc = phaseDoc(config.phase);
      expect(config.label, config.phase).toBe(doc.label);
      expect(config.layout, config.phase).toBe(doc.layout);
      expect(config.judge, config.phase).toBe(doc.judge);
      expect(
        config.artifactFields.map((f) => f.id),
        config.phase
      ).toEqual(doc.artifact_fields.map((f) => f.id));
      expect(
        config.artifactFields.map((f) => f.label),
        config.phase
      ).toEqual(doc.artifact_fields.map((f) => f.label));
      expect(
        config.artifactFields.map((f) => f.kind),
        config.phase
      ).toEqual(doc.artifact_fields.map((f) => f.kind));
      expect(
        config.artifactFields.map((f) => !!f.added),
        config.phase
      ).toEqual(doc.artifact_fields.map((f) => !!f.added));
    }
  });

  it('agrees on every word the student reads', () => {
    for (const config of PHASES) {
      const doc = phaseDoc(config.phase);
      expect(collapse(config.taskDescription), config.phase).toBe(collapse(doc.task_description));
      expect(collapse(config.exampleProblem ?? ''), config.phase).toBe(collapse(doc.example_problem ?? ''));

      config.artifactFields.forEach((field, i) => {
        const source = doc.artifact_fields[i];
        const where = `${config.phase}.${field.id}`;
        expect(collapse(field.prompt ?? ''), `${where} prompt`).toBe(collapse(source.prompt ?? ''));
        expect(collapse(field.hint ?? ''), `${where} hint`).toBe(collapse(source.hint ?? ''));
        expect(collapseExample(field.example), `${where} example`).toEqual(collapseExample(source.example));
        expect(field.rows, `${where} rows`).toBe(source.rows);
        expect(field.language, `${where} language`).toBe(source.language);
      });
    }
  });
});
