import { z } from 'zod';
import type { ArtifactValue, JudgeResult } from './cliveSession.svelte';
import type { LiveTable } from './liveMarks';

const BASE = '/plugin-api/clive';

/** What `GET /boot` answers: the key gate, and the live-diagnostics wording table. */
const bootSchema = z.object({
  hasApiKey: z.boolean(),
  live_check: z.object({
    available: z.boolean(),
    fallback: z.string(),
    table: z.array(z.object({ kind: z.string(), say: z.string(), codes: z.array(z.string()) }))
  })
});

export type BootInfo = Omit<z.infer<typeof bootSchema>, 'live_check'> & { live_check: LiveTable };

/** The one GET this plugin makes: what the page needs before the student does anything. */
export async function fetchBoot(): Promise<BootInfo> {
  const res = await fetch(`${BASE}/boot`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return bootSchema.parse(await res.json());
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export interface JudgeContext {
  /** The practice session the server records the request in. */
  sessionId: string;
  phase: string;
  problemId: string;
  artifact: Record<string, ArtifactValue>;
  attempt: number;
  priorArtifacts: { label: string; fields: { label: string; value: ArtifactValue }[] }[];
  /** The field id a per-step phase is submitting. */
  step?: string;
  /** The current code, for the Implement phase's plan-vs-code judge. */
  code?: string;
}

/** What a stuck ask sends: what the student says is hard, and where they are. */
export interface StuckContext extends Omit<JudgeContext, 'step'> {
  statement: string;
  /** The field the student is on, when the phase shows exactly one. */
  fieldId: string | null;
  /** Earlier asks in this phase and the replies, oldest first. */
  history: { statement: string; feedback: string }[];
}

/**
 * These mirror CLive's own `/api/student/{stuck,submit}` one for one -- only
 * the transport changes, from the standalone Python app to this plugin's
 * Fastify routes under `/plugin-api/clive` (see `../server/routes.ts`). There is
 * no `run` here: compiling and running the Implement phase's code is
 * AnimoRank's own native Submit flow, not this plugin's -- `submitPhase` for the
 * `implement` phase is the plan-vs-code judge call that runs *after* AnimoRank's
 * own tests pass, not a replacement for them.
 *
 * The stuck reply is the feedback alone: the diagnosis the model made goes to the
 * server's log, never to the page.
 */
/** A failing Run or Submit, as the code-feedback call may see it (`./codeFeedback.ts`). */
export interface CodeRun {
  compiled: boolean;
  compilerOutput: string;
  cases: { input: string; expected: string; actual: string; passed: boolean }[];
  hiddenFailed: number;
}

/** One reply about the student's code. */
export interface CodeFeedbackReply {
  situation: string;
  summary: string;
  focus: string;
  nudge: string;
}

export interface CodeFeedbackContext {
  sessionId: string;
  problemId: string;
  code: string;
  runType: 'run' | 'submit';
  attempt: number;
  priorArtifacts: JudgeContext['priorArtifacts'];
  /** Earlier replies about this code, oldest first. */
  history: { situation: string; focus: string; nudge: string }[];
  run: CodeRun;
}

/** After a Run or Submit that did not pass: which situation the student is in, and one thing to do. */
export async function codeFeedback(ctx: CodeFeedbackContext): Promise<CodeFeedbackReply> {
  return call('/code-feedback', ctx);
}

export async function askStuck(ctx: StuckContext): Promise<{ feedback: string }> {
  return call('/stuck', ctx);
}

export async function submitPhase(ctx: JudgeContext): Promise<JudgeResult> {
  return call('/submit', ctx);
}

/** What `POST /log-check` answers: whether the check's own entry could be read back. */
const logCheckSchema = z.object({
  ok: z.boolean(),
  file: z.string(),
  error: z.string()
});

type LogCheck = z.infer<typeof logCheckSchema>;

/**
 * Prove this practice session's history can be written: the server writes a
 * `CLIVE_LOG_CHECK` entry with a fresh nonce and reads it back. Called once as
 * the solve page opens, beside `CLIVE_SESSION_START`.
 */
export async function checkLog(sessionId: string, problemId: string): Promise<LogCheck> {
  return logCheckSchema.parse(await call('/log-check', { sessionId, problemId }));
}
