/**
 * The categories of student answer the larper writes: content, read from
 * `categories.yaml` and checked against the phase's own rubric and situations, so
 * an expectation can only name what CLive can actually return.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { rubricDoc } from '../../plugins/plugin-clive/server/content/load';
import { SITUATIONS } from '../../plugins/plugin-clive/server/situations';
import { PHASES, type Category, type PhaseId } from './types';

const DEFAULT_FILE = path.join(process.cwd(), 'scripts/larper/categories.yaml');

const expectSchema = z.strictObject({
  blocks: z.boolean().optional(),
  fails: z.array(z.string()).optional(),
  situations: z.array(z.string()).optional()
});

const categorySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().trim().min(1),
  writes: z.string().trim().min(1),
  expect: expectSchema.nullish()
});

export function loadCategories(file: string = DEFAULT_FILE): Record<PhaseId, Category[]> {
  const doc = (parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(doc).filter((key) => !(PHASES as string[]).includes(key));
  if (unknown.length) throw new Error(`${file}: unknown phase '${unknown.join("', '")}'.`);

  const out = {} as Record<PhaseId, Category[]>;
  for (const phase of PHASES) {
    const parsed = z.array(categorySchema).safeParse(doc[phase] ?? []);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${file}: ${phase}: ${issue.path.join('.')}: ${issue.message}`);
    }
    const criteria = new Set(rubricDoc(phase).criteria.map((c) => c.id));
    const situations = new Set<string>(SITUATIONS[phase]);
    const seen = new Set<string>();
    out[phase] = parsed.data.map((c) => {
      if (seen.has(c.id)) throw new Error(`${file}: ${phase}: category '${c.id}' is listed twice.`);
      seen.add(c.id);
      for (const id of c.expect?.fails ?? []) {
        if (!criteria.has(id)) throw new Error(`${file}: ${phase}/${c.id}: '${id}' is not a criterion of this phase.`);
      }
      for (const id of c.expect?.situations ?? []) {
        if (!situations.has(id))
          throw new Error(`${file}: ${phase}/${c.id}: '${id}' is not a situation of this phase.`);
      }
      return { id: c.id, name: c.name, writes: c.writes, expect: c.expect ?? null };
    });
  }
  return out;
}

export function findCategory(all: Record<PhaseId, Category[]>, phase: PhaseId, id: string): Category | undefined {
  return all[phase].find((c) => c.id === id);
}
