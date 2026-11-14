/** Which saved answers a run writes over and which it submits. */
import { PHASES, type Answer, type Baseline, type Category, type PhaseId, type Result } from './types';

/** `written` replace the larper's earlier answers for `category`; hand-written ones and other categories stay. */
export function mergeAnswers(saved: Answer[], category: string, written: Answer[]): Answer[] {
  return [...saved.filter((a) => a.category !== category || a.writtenBy === 'hand'), ...written];
}

/**
 * The saved answers to submit, in the categories file's order then by variant.
 * An answer whose category the file no longer lists is set aside by name, never run.
 */
export function selectAnswers(
  saved: Answer[],
  categories: Category[],
  only?: string
): { toRun: Answer[]; skipped: string[] } {
  const known = categories.map((c) => c.id);
  const wanted = only ? [only] : known;
  const toRun = wanted.flatMap((id) => saved.filter((a) => a.category === id).sort((a, b) => a.variant - b.variant));
  const skipped = only ? [] : [...new Set(saved.map((a) => a.category).filter((id) => !known.includes(id)))];
  return { toRun, skipped };
}

/** An on/off switch from the environment. A value that is neither is refused: a mistyped `LARPER_DRY` must not spend money. */
export function flag(name: string, env: Record<string, string | undefined> = process.env): boolean {
  const value = (env[name] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['', '0', 'false', 'no'].includes(value)) return false;
  throw new Error(`${name}: '${env[name]}' is not a setting. Use 1 to turn it on, or leave it unset.`);
}

/** One phase of a run. The model calls arrive as `write` and `run`, so the flow can be tested without them. */
export interface PhaseRun {
  saved: Answer[];
  categories: Category[];
  only?: string;
  variants: number;
  /** Write nothing new; submit the saved answers. */
  reuse: boolean;
  /** Write and save answers; submit nothing. */
  dry: boolean;
  /** Submit each blocked answer a second time, with the first feedback as history. */
  repeat: boolean;
  write: (_category: Category, _variant: number) => Promise<Answer>;
  run: (_answer: Answer, _category: Category, _earlier?: Result) => Promise<Result>;
  /** Called with the phase's whole answer list after each category is written. */
  save: (_answers: Answer[]) => void;
  /** Called with each result the moment it is known, so a later failure loses nothing paid for. */
  keep: (_result: Result) => void;
}

export async function runPhase(run: PhaseRun): Promise<{ results: Result[]; skipped: string[]; saved: Answer[] }> {
  let saved = run.saved;
  if (!run.reuse) {
    for (const category of run.categories.filter((c) => !run.only || c.id === run.only)) {
      const written: Answer[] = [];
      for (let variant = 1; variant <= run.variants; variant += 1) written.push(await run.write(category, variant));
      saved = mergeAnswers(saved, category.id, written);
      run.save(saved);
    }
  }
  if (run.dry) return { results: [], skipped: [], saved };

  const { toRun, skipped } = selectAnswers(saved, run.categories, run.only);
  const results: Result[] = [];
  const add = (result: Result) => {
    results.push(result);
    run.keep(result);
  };
  for (const answer of toRun) {
    const category = run.categories.find((c) => c.id === answer.category) as Category;
    const first = await run.run(answer, category);
    add(first);
    if (run.repeat && first.blocked) add(await run.run(answer, category, first));
  }
  return { results, skipped, saved };
}

/**
 * A problem's baseline, built from nothing: a Control answer per phase, each kept
 * only once CLive lets it through, each written on the ones before. It never starts
 * from an older baseline, so a run that stops half-way leaves the phases that passed
 * and nothing written against different earlier work.
 */
export async function buildBaseline(run: {
  tries: number;
  attempt: (_phase: PhaseId, _baseline: Baseline) => Promise<Result>;
  save: (_baseline: Baseline) => void;
}): Promise<Baseline> {
  const baseline: Baseline = {};
  for (const phase of PHASES) {
    let last: Result | undefined;
    for (let attempt = 1; attempt <= run.tries; attempt += 1) {
      last = await run.attempt(phase, baseline);
      if (last.blocked === false && !last.offCategory) break;
    }
    if (!last || last.blocked !== false || last.offCategory) {
      const why = last?.error ?? (last?.feedback || `failed ${last?.failed.join(', ') || 'for no stated reason'}`);
      throw new Error(`No Control answer for ${phase} passed in ${run.tries} tries. Last: ${why}`);
    }
    baseline[phase] = last.answer.artifact;
    run.save(baseline);
  }
  return baseline;
}
