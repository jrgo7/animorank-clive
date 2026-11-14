/**
 * Where the larper keeps what it wrote: answers per problem and phase, and one
 * baseline per problem -- the known-good earlier work every later phase's category
 * is written and judged against, so a category's result is never muddied by a bad
 * earlier phase.
 *
 * Plain JSON, pretty-printed: the team edits these files and adds answers by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PriorArtifact } from '../../plugins/plugin-clive/server/artifact';
import { phaseDoc } from '../../plugins/plugin-clive/server/content/load';
import { PHASES, type Answer, type Baseline, type PhaseId } from './types';

export const DEFAULT_ROOT = path.join(process.cwd(), 'scripts/larper');

function readJson<T>(file: string, otherwise: T): T {
  if (!fs.existsSync(file)) return otherwise;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    throw new Error(`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const answersFile = (root: string, problemId: string, phase: PhaseId) =>
  path.join(root, 'answers', problemId, `${phase}.json`);
const baselineFile = (root: string, problemId: string) => path.join(root, 'baseline', `${problemId}.json`);

export function readAnswers(root: string, problemId: string, phase: PhaseId): Answer[] {
  return readJson<Answer[]>(answersFile(root, problemId, phase), []);
}

/** Replaces the phase's file: the caller merges with what it read. */
export function writeAnswers(root: string, problemId: string, phase: PhaseId, answers: Answer[]): void {
  writeJson(answersFile(root, problemId, phase), answers);
}

export function readBaseline(root: string, problemId: string): Baseline {
  return readJson<Baseline>(baselineFile(root, problemId), {});
}

export function writeBaseline(root: string, problemId: string, baseline: Baseline): void {
  writeJson(baselineFile(root, problemId), baseline);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** The baseline's earlier phases, in phase order, shaped as the page carries work forward. */
export function priorFor(baseline: Baseline, phase: PhaseId): PriorArtifact[] {
  const out: PriorArtifact[] = [];
  for (const id of PHASES.slice(0, PHASES.indexOf(phase))) {
    const artifact = baseline[id];
    if (!artifact) throw new Error(`No baseline for ${id}. Run LARPER_BASELINE=1 first.`);
    const doc = phaseDoc(id);
    const fields = doc.artifact_fields
      .filter((f) => !isEmpty(artifact[f.id]))
      .map((f) => ({ label: f.label, value: artifact[f.id] }));
    if (fields.length) out.push({ label: doc.label, fields });
  }
  return out;
}

/** Refuses a run that would reach a phase with no earlier work, before any model call is paid for. */
export function requireBaseline(baseline: Baseline, phases: PhaseId[]): void {
  for (const phase of phases) priorFor(baseline, phase);
}
