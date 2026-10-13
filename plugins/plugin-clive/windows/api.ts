import type { ArtifactValue, JudgeResult } from './cliveSession.svelte';

const BASE = '/plugin-api/clive';

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
export async function askStuck(ctx: StuckContext): Promise<{ feedback: string }> {
  return call('/stuck', ctx);
}

export async function submitPhase(ctx: JudgeContext): Promise<JudgeResult> {
  return call('/submit', ctx);
}
