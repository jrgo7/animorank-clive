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
import { csv, labelRows } from './labels';
import { localExecutor } from './localExecutor';
import { mergeAnswers, selectAnswers } from './run';
import { runAnswer, runCode, type Deps } from './runner';
import { jsonLines, sheet } from './sheet';
import { DEFAULT_ROOT, priorFor, readAnswers, readBaseline, writeAnswers, writeBaseline } from './store';
import { PHASES, type PhaseId, type Result } from './types';
import { writeAnswer } from './writer';

const BASELINE_TRIES = 3;
const on = (name: string) => process.env[name] === '1';

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

    const root = DEFAULT_ROOT;
    const categories = loadCategories();
    const problem = await loadCLiveProblem(problemId);
    const deps: Deps = { submit, codeNudge, runCode, executor: localExecutor };
    console.log(`larper: ${problem.title}`);

    if (on('LARPER_BASELINE')) {
      // The known-good earlier work every category is written against: a Control
      // answer per phase, kept only once CLive lets it through.
      const baseline = readBaseline(root, problemId);
      for (const phase of PHASES) {
        const control = findCategory(categories, phase, 'control');
        if (!control) throw new Error(`${phase} has no 'control' category to build a baseline from.`);
        const prior = priorFor(baseline, phase);
        let last: Result | undefined;
        for (let attempt = 1; attempt <= BASELINE_TRIES; attempt += 1) {
          const answer = await writeAnswer(phaseDoc(phase), problem, problemId, control, prior, attempt);
          last = await runAnswer(answer, control, problem, prior, deps);
          console.log(
            `baseline ${phase}, try ${attempt}: ${last.blocked === false && !last.offCategory ? 'passed' : 'not yet'}`
          );
          if (last.blocked === false && !last.offCategory) break;
        }
        if (!last || last.blocked !== false || last.offCategory) {
          throw new Error(
            `No Control answer for ${phase} passed in ${BASELINE_TRIES} tries. Last: ${
              last?.error ?? (last?.feedback || `failed ${last?.failed.join(', ')}`)
            }`
          );
        }
        baseline[phase] = last.answer.artifact;
        writeBaseline(root, problemId, baseline);
      }
      console.log(`baseline written to ${path.join(root, 'baseline', `${problemId}.json`)}`);
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = process.env.LARPER_OUT ?? path.join(root, 'out', stamp);
    fs.mkdirSync(outDir, { recursive: true });
    const baseline = readBaseline(root, problemId);
    const only = process.env.LARPER_CATEGORY;

    for (const phase of phases) {
      if (only && !findCategory(categories, phase, only)) {
        if (process.env.LARPER_PHASE) throw new Error(`LARPER_CATEGORY: ${phase} has no category '${only}'.`);
        continue;
      }
      const prior = priorFor(baseline, phase);
      let saved = readAnswers(root, problemId, phase);

      if (!on('LARPER_REUSE')) {
        for (const category of categories[phase].filter((c) => !only || c.id === only)) {
          const written = [];
          for (let variant = 1; variant <= variants; variant += 1) {
            written.push(await writeAnswer(phaseDoc(phase), problem, problemId, category, prior, variant));
            console.log(`wrote ${phase}/${category.id} ${variant}${written.at(-1)?.error ? ' (ERROR)' : ''}`);
          }
          saved = mergeAnswers(saved, category.id, written);
          writeAnswers(root, problemId, phase, saved);
        }
      }
      if (on('LARPER_DRY')) continue;

      const { toRun, skipped } = selectAnswers(saved, categories[phase], only);
      const results: Result[] = [];
      for (const answer of toRun) {
        const category = findCategory(categories, phase, answer.category)!;
        const first = await runAnswer(answer, category, problem, prior, deps);
        results.push(first);
        console.log(
          `ran ${phase}/${answer.category} ${answer.variant}: ${
            first.blocked === null ? `ERROR ${first.error}` : first.blocked ? `blocked (${first.situation})` : 'passed'
          }`
        );
        if (on('LARPER_REPEAT') && first.blocked)
          results.push(await runAnswer(answer, category, problem, prior, deps, first));
      }

      // Written per phase, so a failure in a later phase loses nothing.
      fs.writeFileSync(path.join(outDir, `${phase}.md`), sheet(phase, categories[phase], results, skipped));
      fs.appendFileSync(path.join(outDir, 'results.jsonl'), jsonLines(results));
      const labels = labelRows(phase, results, prior);
      fs.writeFileSync(path.join(outDir, `${phase}.labels.csv`), csv(labels.sheet));
      fs.writeFileSync(path.join(outDir, `${phase}.labels-key.csv`), csv(labels.key));
    }
    console.log(
      on('LARPER_DRY')
        ? `answers written under ${path.join(root, 'answers', problemId)}`
        : `sheets written to ${outDir}`
    );
  },
  60 * 60 * 1000
);
