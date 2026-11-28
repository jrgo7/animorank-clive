import { z } from 'zod';
import type { ArtifactValue, JudgeResult, NudgeResult } from './cliveSession.svelte';

const BASE = '/plugin-api/clive';

/** What `GET /boot` answers: only the key gate. */
const bootSchema = z.object({ hasApiKey: z.boolean() });

export type BootInfo = z.infer<typeof bootSchema>;

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
  /** Every earlier nudge in this phase (or step), oldest first: the model sees the last few on its requirement. */
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
 * `/plugin-api/clive` (see `../server/routes.ts`). It judges Problem, Cases and
 * Design. Implement has none: compiling and running its code is AnimoRank's own
 * Run and Submit, and its tests alone decide the phase.
 *
 * `escalate` is the hint ladder's "I'm stuck": a prompt on the requirement the
 * last failed submit's hint was about. `codeFeedback` answers a failed Run or Submit
 * with a hint, and `escalateCode` is "I'm stuck" under it. No reply carries the
 * model's reason, which goes to the server's log.
 */
/** A failing Run or Submit, as the code-feedback call may see it (`./codeFeedback.ts`). */
export interface CodeRun {
  compiled: boolean;
  compilerOutput: string;
  cases: { input: string; expected: string; actual: string; passed: boolean }[];
  hiddenFailed: number;
}

/** One reply about the student's code: a run's hint, or the prompt "I'm stuck" brought. */
export interface CodeFeedbackReply {
  level: NudgeLevel;
  situation: string;
  summary: string;
  focus: string;
  /** What the student reads. */
  nudge: string;
}

/** One earlier reply about the code, as the model is shown it. */
export interface CodeTurn {
  level: NudgeLevel;
  situation: string;
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
  /** Earlier replies about this code, oldest first, hints and prompts. */
  history: CodeTurn[];
  run: CodeRun;
}

/** After a Run or Submit that did not pass: which situation the student is in, and where to look. */
export async function codeFeedback(ctx: CodeFeedbackContext): Promise<CodeFeedbackReply> {
  return call('/code-feedback', ctx);
}

/**
 * "I'm stuck" under the latest run's hint. No code and no results: the server
 * builds the prompt from its own record of that run.
 */
export async function escalateCode(ctx: {
  sessionId: string;
  problemId: string;
  /** The run whose reply is escalated. */
  attempt: number;
  priorArtifacts: JudgeContext['priorArtifacts'];
  history: CodeTurn[];
}): Promise<CodeFeedbackReply> {
  return call('/code-feedback/escalate', ctx);
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
