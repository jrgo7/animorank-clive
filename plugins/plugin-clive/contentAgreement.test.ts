/**
 * The client's display config must agree with the phase YAML the server judges
 * from. A field id the two disagree on means a submitted artifact key means
 * nothing to the judge; a divergent `judge`/`layout` changes when things are
 * judged. This is what keeps the hand-port in `windows/phase.ts` honest.
 */
import { describe, expect, it } from 'vitest';
import { phaseDoc } from './server/content/load';
import { PHASES } from './windows/phase';

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

  it('agrees on each task description, wrapping aside', () => {
    const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
    for (const config of PHASES) {
      expect(collapse(config.taskDescription), config.phase).toBe(collapse(phaseDoc(config.phase).task_description));
    }
  });
});
