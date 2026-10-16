/**
 * The client's phase metadata must agree with the phase YAML the server judges
 * from. A field id the two disagree on means a submitted artifact key means
 * nothing to the judge; a divergent `judge`/`layout` changes when things are
 * judged; and a label is prompt-visible, since the client sends it to the judge
 * as `prior_artifacts` and the nudge and stuck prompts render it.
 *
 * Everything else the student reads -- questions, hints, examples, the task
 * description -- now lives in each phase's own window (`ProblemWindow.window.svelte`
 * and its three siblings), written from the same YAML by hand; the YAML keeps its
 * copy because the server renders those words into its own prompts.
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
});
