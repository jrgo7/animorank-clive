/**
 * The larper: an LLM writes one named kind of student answer per category, each
 * goes through CLive's own submit path, and a sheet per phase shows what CLive said.
 *
 * Not a unit test: it makes real model calls and reads the local database (for the
 * problem; it writes to no practice session). See `README.md` beside this file.
 *
 *   LARPER_PROBLEM=<id> LARPER_BASELINE=1 npx vitest run --config vitest.larper.config.ts
 *   LARPER_PROBLEM=<id> LARPER_PHASE=problem_definition npx vitest run --config vitest.larper.config.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import { codeNudge } from '../../plugins/plugin-clive/server/codeNudge';
import { phaseDoc } from '../../plugins/plugin-clive/server/content/load';
import { loadCLiveProblem } from '../../plugins/plugin-clive/server/problem';
import { submit } from '../../plugins/plugin-clive/server/routes';
import { findCategory, loadCategories } from './categories';
import { csv, labelRows, SHEET_FORMULA_COLUMNS } from './labels';
import { localExecutor } from './localExecutor';
import { buildBaseline, flag, runPhase } from './run';
import { runAnswer, runCode, type Deps } from './runner';
import { jsonLines, sheet } from './sheet';
import {
  DEFAULT_ROOT,
  priorFor,
  readAnswers,
  readBaseline,
  requireBaseline,
  writeAnswers,
  writeBaseline
} from './store';
import { PHASES, type PhaseId } from './types';
import { writeAnswer } from './writer';

const BASELINE_TRIES = 3;

it(
  'larps',
  async () => {
    const problemId = process.env.LARPER_PROBLEM;
    if (!problemId) throw new Error('LARPER_PROBLEM is required: the id of a problem in the local database.');
    const phases = process.env.LARPER_PHASE ? [process.env.LARPER_PHASE as PhaseId] : PHASES;
    for (const phase of phases) {
      if (!PHASES.includes(phase)) throw new Error(`LARPER_PHASE: '${phase}' is not one of ${PHASES.join(', ')}.`);
    }
    const variants = Number.parseInt(process.env.LARPER_VARIANTS ?? '3', 10);
    if (!Number.isInteger(variants) || variants < 1)
      throw new Error('LARPER_VARIANTS must be a whole number, 1 or more.');
    const [baselineMode, reuse, dry, repeat] = ['LARPER_BASELINE', 'LARPER_REUSE', 'LARPER_DRY', 'LARPER_REPEAT'].map(
      (name) => flag(name)
    );

    const root = DEFAULT_ROOT;
    const categories = loadCategories();
    const only = process.env.LARPER_CATEGORY;
    if (only && !phases.some((phase) => findCategory(categories, phase, only))) {
      throw new Error(`LARPER_CATEGORY: no phase being run has a category '${only}'.`);
    }
    const problem = await loadCLiveProblem(problemId);
    const deps: Deps = { submit, codeNudge, runCode, executor: localExecutor };
    console.log(`larper: ${problem.title}`);

    if (baselineMode) {
      await buildBaseline({
        tries: BASELINE_TRIES,
        attempt: async (phase, baseline) => {
          const control = findCategory(categories, phase, 'control');
          if (!control) throw new Error(`${phase} has no 'control' category to build a baseline from.`);
          const prior = priorFor(baseline, phase);
          // Always variant 1: a later variant is asked to differ, which pushes a Control answer toward mistakes.
          const answer = await writeAnswer(phaseDoc(phase), problem, problemId, control, prior, 1);
          const result = await runAnswer(answer, control, problem, prior, deps);
          console.log(`baseline ${phase}: ${result.blocked === false && !result.offCategory ? 'passed' : 'not yet'}`);
          return result;
        },
        save: (baseline) => writeBaseline(root, problemId, baseline)
      });
      console.log(`baseline written to ${path.join(root, 'baseline', `${problemId}.json`)}`);
      return;
    }

    // Before anything is paid for: every phase this run reaches needs its earlier work.
    const baseline = readBaseline(root, problemId);
    requireBaseline(baseline, phases);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = process.env.LARPER_OUT ?? path.join(root, 'out', stamp);
    const resultsFile = path.join(outDir, 'results.jsonl');
    if (!dry) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(resultsFile, '');
      // What this run was, for the page that lists runs.
      fs.writeFileSync(
        path.join(outDir, 'run.json'),
        JSON.stringify(
          { problemId, title: problem.title, phases, variants, reuse, repeat, only: only ?? null },
          null,
          2
        )
      );
    }
    const failures: string[] = [];

    for (const phase of phases) {
      if (only && !findCategory(categories, phase, only)) continue;
      const prior = priorFor(baseline, phase);
      const { results, skipped } = await runPhase({
        saved: readAnswers(root, problemId, phase),
        categories: categories[phase],
        only,
        variants,
        reuse,
        dry,
        repeat,
        write: async (category, variant) => {
          const answer = await writeAnswer(phaseDoc(phase), problem, problemId, category, prior, variant);
          console.log(`wrote ${phase}/${category.id} ${variant}${answer.error ? ` (ERROR ${answer.error})` : ''}`);
          return answer;
        },
        run: async (answer, category, earlier) => {
          const result = await runAnswer(answer, category, problem, prior, deps, earlier);
          const outcome =
            result.blocked === null
              ? `ERROR ${result.error}`
              : result.blocked
                ? `blocked (${result.situation})`
                : 'passed';
          console.log(`ran ${phase}/${answer.category} ${answer.variant}${earlier ? ' again' : ''}: ${outcome}`);
          return result;
        },
        save: (answers) => writeAnswers(root, problemId, phase, answers),
        // Each result is on disk before the next answer is run.
        keep: (result) => fs.appendFileSync(resultsFile, jsonLines([result]))
      });
      if (dry) continue;

      // Each file on its own: one that cannot be written does not cost the others, and
      // the results themselves are already in results.jsonl.
      let made: ReturnType<typeof labelRows> | undefined;
      const labels = () => (made ??= labelRows(phase, results, prior));
      const files: [string, () => string][] = [
        [`${phase}.md`, () => sheet(phase, categories[phase], results, skipped)],
        [`${phase}.labels.csv`, () => csv(labels().sheet, SHEET_FORMULA_COLUMNS)],
        [`${phase}.labels-key.csv`, () => csv(labels().key)]
      ];
      for (const [name, content] of files) {
        try {
          fs.writeFileSync(path.join(outDir, name), content());
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    console.log(dry ? `answers written under ${path.join(root, 'answers', problemId)}` : `sheets written to ${outDir}`);
    if (failures.length) throw new Error(`Could not write: ${failures.join('; ')}. The results are in ${resultsFile}.`);
  },
  60 * 60 * 1000
);
