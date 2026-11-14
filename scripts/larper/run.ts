/** Which saved answers a run writes over and which it submits. */
import type { Answer, Category } from './types';

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
