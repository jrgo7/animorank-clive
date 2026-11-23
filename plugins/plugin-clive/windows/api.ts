import { z } from 'zod';
import type { ArtifactValue, JudgeResult, NudgeResult } from './cliveSession.svelte';
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
  /** Every earlier nudge in this phase (or step), oldest first: the server reads the level from them. */
  history?: NudgeTurn[];
}

/** A rung of the hint ladder: a hint points to where to look, a prompt asks for the one missing piece. */
export type NudgeLevel = 'hint' | 'prompt';

/** One earlier nudge: what the student was told, about which requirement, at which level. */
export interface NudgeTurn {
  attempt: number;
  level: NudgeLevel;
  focus_id: string;
  nudge: string;
}

/**
 * What "I'm stuck" sends: where the student is and the nudges they have had. No
 * work and no verdicts: the server builds the prompt from its own record of the
 * last submit.
 */
interface EscalateContext {
  sessionId: string;
  phase: string;
  problemId: string;
  /** The field id a per-step phase submitted. */
  step?: string;
  /** The failed submit being escalated. */
  attempt: number;
  priorArtifacts: JudgeContext['priorArtifacts'];
  history: NudgeTurn[];
}

/**
 * `submitPhase` mirrors CLive's own `/api/student/submit` -- only the transport
 * changes, from the standalone Python app to this plugin's Fastify routes under
 * `/plugin-api/clive` (see `../server/routes.ts`). There is no `run` here:
 * compiling and running the Implement phase's code is AnimoRank's own native
 * Submit flow, not this plugin's -- `submitPhase` for the `implement` phase is the
 * plan-vs-code judge call that runs *after* AnimoRank's own tests pass, not a
 * replacement for them.
 *
 * `escalate` is the hint ladder's "I'm stuck": a prompt on the requirement the
 * last failed submit's hint was about. Neither reply carries the model's reason,
 * which goes to the server's log, never to the page.
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

/**
 * Tag this session with the participant working in it, or (`next`) start a fresh
 * session for the next participant: the answer names the session they are now in.
 */
export async function setParticipant(ctx: {
  sessionId: string;
  problemId: string;
  participant: string;
  next: boolean;
}): Promise<{ sessionId: string }> {
  return call('/participant', ctx);
}

export async function escalate(ctx: EscalateContext): Promise<NudgeResult> {
  return call('/escalate', ctx);
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
