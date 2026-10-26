/**
 * Replays real past submissions through CLive's current prompts, with the real
 * provider, and writes what CLive would say now beside what it said then.
 *
 * Not a test: it costs a few cents and reads local, gitignored research logs.
 *
 *   npx vitest run --config vitest.replay.config.ts
 *   REPLAY_ONLY=avril-cases REPLAY_DRY=1 REPLAY_OUT=/tmp/replay.md npx vitest run --config vitest.replay.config.ts
 *   (REPLAY_EVIDENCE=1 adds the judged work and every verdict to the output)
 *
 * Sources (selection and expected situations in `cliveReplay.cases.json`):
 * - `port`: Avril's Red Wildlings session from this app (problem read from the database).
 * - `proto`: the clive-userflow prototype's human sessions (problem from its YAML).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { it } from 'vitest';
import type { CodeExecutor } from '$lib/executor';
import { phaseDoc, rubricDoc } from '../plugins/plugin-clive/server/content/load';
import type { ProblemForPrompt } from '../plugins/plugin-clive/server/content/templates';
import { judgeWithChecks } from '../plugins/plugin-clive/server/referenceCheck';
import { nudge } from '../plugins/plugin-clive/server/nudge';
import { codeNudge, type CodeRun } from '../plugins/plugin-clive/server/codeNudge';
import { cut, isPerStep } from '../plugins/plugin-clive/server/steps';
import { loadCLiveProblem } from '../plugins/plugin-clive/server/problem';
import { toCodeRun } from '../plugins/plugin-clive/windows/codeFeedback';
import type { PriorArtifact } from '../plugins/plugin-clive/server/artifact';

const ROOT = process.cwd();
const AVRIL = path.join(
  ROOT,
  'docs/interview/round6/session-log-avril-red-wildlings-ba3fe823-dcfc-4652-911a-c35a5dd36276.jsonl'
);
const PROTO_LOGS = path.join(ROOT, '../clive-userflow/logs');
const PROTO_PROBLEMS = path.join(ROOT, '../clive-userflow/cases/problems');
const PHASE_ORDER = ['problem_definition', 'case_design', 'algorithm_design', 'implement'];

interface CaseSpec {
  tag: string;
  source: 'port' | 'port-runs' | 'proto' | 'proto-runs';
  participant?: string;
  problem?: string;
  phase?: string;
  attempts?: number[];
  /** Replay passing submits too (a gate that should have failed). */
  includePassed?: boolean;
  expect: Record<string, string[]> | null;
}

/** One event either log format holds, in one shape. */
interface Event {
  ts: string;
  problem: string;
  kind: 'submit' | 'run';
  phase: string;
  step: string | null;
  attempt: number;
  artifact: Record<string, unknown>;
  code: string;
  run: CodeRun | null;
  passed: boolean;
  oldFeedback: string;
}

/** A gcc on this machine standing in for Judge0, so the reference check can run here. */
const localExecutor = {
  async execute(request: {
    files: { path: string; content: Buffer }[];
    processes: { command: string; args: string[]; stdin?: Buffer }[];
  }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clive-replay-'));
    for (const f of request.files) fs.writeFileSync(path.join(dir, f.path), f.content);
    const processOutputs = [];
    for (const p of request.processes) {
      const r = spawnSync(p.command, p.args, { cwd: dir, input: p.stdin, timeout: 5000 });
      processOutputs.push({
        exitCode: r.status ?? undefined,
        stdout: r.stdout ?? Buffer.from(''),
        stderr: r.stderr ?? Buffer.from('')
      });
      if (r.status !== 0) break;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { processOutputs };
  }
} as unknown as CodeExecutor;

function readJsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

function nudgeText(response: Record<string, unknown> | undefined): string {
  const n = response?.nudge as { nudge?: string } | undefined;
  return n?.nudge ?? '';
}

function portEvents(): Event[] {
  return readJsonl(AVRIL)
    .slice(1)
    .flatMap((e): Event[] => {
      const d = e.data as Record<string, unknown>;
      const ts = String(e.timestamp);
      if (e.type === 'CLIVE_SUBMIT') {
        const response = d.response as Record<string, unknown>;
        return [
          {
            ts,
            problem: String(d.problem_id),
            kind: 'submit',
            phase: String(d.phase_id),
            step: (d.step as string) ?? null,
            attempt: Number(d.attempt),
            artifact: d.artifact as Record<string, unknown>,
            code: '',
            run: null,
            passed: Boolean(response?.passed),
            oldFeedback: nudgeText(response)
          }
        ];
      }
      if (e.type === 'RUN_ATTEMPT') {
        return [
          {
            ts,
            problem: '',
            kind: 'run',
            phase: 'implement',
            step: null,
            attempt: 0,
            artifact: {},
            code: String(d.submittedCode),
            run: toCodeRun(d.publicTestResults as unknown[]),
            passed: false,
            oldFeedback: '(no feedback then)'
          }
        ];
      }
      return [];
    });
}

function protoRun(r: Record<string, unknown>): CodeRun {
  const cases = (r.cases as Record<string, unknown>[] | undefined) ?? [];
  return {
    compiled: Boolean(r.compiled),
    compilerOutput: String(r.compile_error ?? ''),
    cases: cases
      .filter((c) => !c.hidden)
      .map((c) => ({
        input: String(c.input ?? ''),
        expected: String(c.expected ?? ''),
        actual: String(c.actual ?? ''),
        passed: Boolean(c.passed)
      })),
    hiddenFailed: cases.filter((c) => c.hidden && !c.passed).length
  };
}

function protoEvents(participant: string): Event[] {
  const files = execFileSync('find', [PROTO_LOGS, '-name', `${participant}_*.jsonl`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    // The curated copies first; the originals in sessions/ are duplicates of them.
    .filter((f, _i, all) => !f.includes('/sessions/') || !all.some((g) => g.includes('/prototype-sessions/')));
  return files
    .flatMap(readJsonl)
    .flatMap((e): Event[] => {
      const ts = String(e.ts);
      const response = e.response as Record<string, unknown> | undefined;
      if (e.event === 'submit') {
        const testRun = response?.test_run as Record<string, unknown> | undefined;
        const artifact = (e.artifact as Record<string, unknown>) ?? {};
        return [
          {
            ts,
            problem: String(e.problem_id),
            kind: 'submit',
            phase: String(e.phase_id),
            step: (e.step as string) ?? null,
            attempt: Number(e.attempt),
            artifact,
            code: String(artifact.code ?? ''),
            run: testRun ? protoRun(testRun) : null,
            passed: Boolean(response?.passed),
            oldFeedback: nudgeText(response)
          }
        ];
      }
      if (e.event === 'run' && response && !response.compiled) {
        return [
          {
            ts,
            problem: String(e.problem_id),
            kind: 'run',
            phase: 'implement',
            step: null,
            attempt: 0,
            artifact: {},
            code: String(e.code ?? ''),
            run: protoRun(response),
            passed: false,
            oldFeedback: '(no feedback then)'
          }
        ];
      }
      return [];
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Earlier phases' work as the page carries it forward: each phase's latest passing submit before `ts`. */
function priorFor(events: Event[], phase: string, ts: string, problem: string): PriorArtifact[] {
  const out: PriorArtifact[] = [];
  for (const id of PHASE_ORDER.slice(0, PHASE_ORDER.indexOf(phase))) {
    const merged: Record<string, unknown> = {};
    for (const e of events)
      if (e.kind === 'submit' && e.phase === id && e.passed && e.ts < ts && (!problem || e.problem === problem))
        Object.assign(merged, e.artifact);
    const doc = phaseDoc(id);
    const fields = doc.artifact_fields
      .filter((f) => merged[f.id] !== undefined && JSON.stringify(merged[f.id]) !== '""')
      .map((f) => ({ label: f.label, value: merged[f.id] }));
    if (fields.length) out.push({ label: doc.label, fields } as PriorArtifact);
  }
  return out;
}

function protoProblem(slug: string): ProblemForPrompt {
  const doc = parse(fs.readFileSync(path.join(PROTO_PROBLEMS, `${slug}.yaml`), 'utf8'));
  return {
    slug,
    title: doc.title,
    statement: doc.statement,
    starter_code: '',
    public_test_cases: (doc.public_test_cases ?? []).map((c: { input: unknown; output: unknown }) => ({
      input: String(c.input),
      output: String(c.output)
    })),
    reference_solution: doc.reference_solution ?? '',
    functions: []
  };
}

function expected(spec: CaseSpec, e: Event, index: number): string[] | null {
  if (!spec.expect) return null;
  const key = e.step ? `${e.step}:${e.attempt}` : `${index + 1}`;
  return spec.expect[key] ?? (e.step ? spec.expect[`${e.step}:*`] : undefined) ?? spec.expect['*'] ?? null;
}

it('replays past submissions through the current prompts', async () => {
  const only = process.env.REPLAY_ONLY;
  const dry = process.env.REPLAY_DRY === '1';
  const outFile = process.env.REPLAY_OUT ?? path.join(os.tmpdir(), 'clive-replay.md');
  const specs: CaseSpec[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/cliveReplay.cases.json'), 'utf8'));
  const lines: string[] = [`# CLive replay — ${new Date().toISOString()}`, ''];
  let hits = 0;
  let misses = 0;

  for (const spec of specs) {
    if (only && !spec.tag.startsWith(only)) continue;
    const isPort = spec.source.startsWith('port');
    const events = isPort ? portEvents() : protoEvents(spec.participant ?? '');
    const problem = isPort
      ? await loadCLiveProblem(String(readJsonl(AVRIL)[0].problem_id))
      : protoProblem(spec.problem ?? '');
    const selected = events.filter((e) =>
      spec.source.endsWith('runs')
        ? e.kind === 'run' && (isPort || e.problem === spec.problem)
        : e.kind === 'submit' &&
          e.phase === spec.phase &&
          (isPort || e.problem === spec.problem) &&
          (spec.includePassed || !e.passed) &&
          (!spec.attempts || spec.attempts.includes(e.attempt))
    );
    lines.push(`## ${spec.tag} (${selected.length} items)`, '');
    const judgedHistory: { attempt: number; situation: string; focus_id: string; nudge: string }[] = [];
    const codeHistory: { situation: string; focus: string; nudge: string }[] = [];

    for (const [index, e] of selected.entries()) {
      const prior = priorFor(events, e.phase, e.ts, isPort ? '' : (spec.problem ?? ''));
      const want = expected(spec, e, index);
      lines.push(`### ${e.kind} ${e.phase}${e.step ? `/${e.step}` : ''} attempt ${e.attempt || index + 1} — ${e.ts}`);
      if (dry) {
        lines.push(
          '```',
          JSON.stringify(
            e.kind === 'run' || e.phase === 'implement' ? { code: e.code.slice(0, 300), run: e.run } : e.artifact
          ).slice(0, 1200),
          '```',
          ''
        );
        continue;
      }
      let situation = '';
      let reply = '';
      try {
        if (e.kind === 'run' || e.phase === 'implement') {
          const r = await codeNudge(problem, e.code, e.run as CodeRun, prior, codeHistory.slice(-5), index + 1);
          situation = r.situation;
          reply = r.nudge;
          codeHistory.push({ situation: r.situation, focus: r.focus, nudge: r.nudge });
        } else {
          const whole = phaseDoc(e.phase);
          const rubric = rubricDoc(e.phase).criteria;
          // A per-step phase is judged one step at a time. A prototype submission names no
          // step (the prototype judged the phase at once), so every step it filled in is
          // judged in turn, and the first that blocks is the one answered.
          const steps = !isPerStep(whole)
            ? [null]
            : e.step
              ? [e.step]
              : [...new Set(rubric.flatMap((c) => c.fields ?? []))].filter((id) => {
                  const value = (e.artifact as Record<string, unknown>)[id];
                  return typeof value === 'string' && value.trim() !== '';
                });
          situation = '(passes now: no nudge)';
          for (const step of steps) {
            const scoped = step
              ? cut(whole, e.artifact, rubric, step)
              : { phase: whole, artifact: e.artifact, criteria: rubric };
            const { phase, artifact } = scoped;
            const judged = await judgeWithChecks(
              phase,
              problem,
              artifact,
              scoped.criteria,
              e.attempt,
              prior,
              undefined,
              localExecutor
            );
            const failing = judged.verdicts
              .filter((v) => v.verdict === 'FAIL')
              .map((v) => {
                const gate = judged.criteria.find((c) => c.id === v.criterion_id)?.gate;
                return `${v.criterion_id}${gate === 'advisory' ? '(adv)' : ''}${v.source === 'reference' ? '[ref]' : ''}`;
              });
            lines.push(
              `- ${step && steps.length > 1 ? `${step}: ` : ''}verdicts now: ${failing.length ? failing.join(', ') : 'all pass'}; reference check: ${judged.referenceCheck?.status ?? 'n/a'}`
            );
            // REPLAY_EVIDENCE=1 also writes what was judged and every verdict, to see why one passed.
            if (process.env.REPLAY_EVIDENCE === '1') {
              lines.push('```json', JSON.stringify({ step, artifact, verdicts: judged.verdicts }, null, 2), '```');
            }
            const blocking = judged.verdicts.some(
              (v) => v.verdict === 'FAIL' && judged.criteria.find((c) => c.id === v.criterion_id)?.gate !== 'advisory'
            );
            if (!blocking) continue;
            const n = await nudge(
              phase,
              problem,
              artifact,
              judged.criteria,
              judged.verdicts,
              e.attempt,
              prior,
              judgedHistory.slice(-5)
            );
            situation = n.situation;
            reply = n.nudge;
            judgedHistory.push({ attempt: e.attempt, situation: n.situation, focus_id: n.focus_id, nudge: n.nudge });
            break;
          }
        }
      } catch (error) {
        situation = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      const ok = want ? want.includes(situation) : null;
      if (ok === true) hits += 1;
      if (ok === false) misses += 1;
      lines.push(
        `- old: ${e.oldFeedback.replace(/\n/g, ' / ') || '(none)'}`,
        `- **new situation: ${situation}**${want ? ` (expected ${want.join(' | ')}) ${ok ? '✓' : '✗'}` : ''}`,
        ...reply
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => `  > ${l}`),
        ''
      );
    }
  }
  lines.splice(1, 0, `Expected situations: ${hits} ✓, ${misses} ✗`, '');
  fs.writeFileSync(outFile, lines.join('\n'));
  console.log(`replay written to ${outFile} — ${hits} ✓, ${misses} ✗`);
});
