import type { ArtifactValue, HintEntry, JudgeResult } from './cliveSession.svelte';

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

/**
 * These mirror CLive's own `/api/student/{hint,submit}` one for one -- only
 * the transport changes, from the standalone Python app to this plugin's
 * Fastify routes under `/plugin-api/clive` (see `../server/routes.ts`). There is
 * no `run` here: compiling and running the Implement phase's code is
 * AnimoRank's own native Submit flow, not this plugin's -- `submitPhase` for the
 * `implement` phase is the plan-vs-code judge call that runs *after* AnimoRank's
 * own tests pass, not a replacement for them.
 */
export async function askHint(ctx: JudgeContext & { history: { role: 'hint'; text: string }[] }): Promise<HintEntry> {
  return call('/hint', ctx);
}

export async function submitPhase(ctx: JudgeContext): Promise<JudgeResult> {
  return call('/submit', ctx);
}
