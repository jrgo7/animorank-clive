/**
 * A record of every model call a request made, for the session log.
 *
 * Ported from the prototype's `clive.llm_log`: a route runs its work inside
 * {@link captureLlmCalls}, every model call made inside goes through
 * {@link callModel}, and the route gets back one {@link LlmCall} per call, in the
 * order they were made, to write beside the submission or stuck ask they served.
 * A call that fails is recorded too, with whatever the model sent before it
 * failed, so a failed request can still be explained afterwards.
 *
 * The capture follows the async work (`AsyncLocalStorage`), so the judge, nudge
 * and stuck modules need no collector passed through them, and two requests
 * served at once never see each other's calls.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { JudgeError } from './content/errors';
import type { JudgeJsonOptions, Provider, ProviderResult } from './providers';

/** What a call was for: one per model call a CLive route makes. */
export type LlmPurpose = 'judge' | 'nudge' | 'nudge_code' | 'stuck';

/** One model call, named the way the prototype's `llm_call` lines are, so an analysis reads the same fields. */
export interface LlmCall {
  purpose: LlmPurpose;
  /** When the call was sent, ISO 8601. */
  started: string;
  provider: string;
  model_requested: string;
  effort: string;
  max_output_tokens: number;
  system: string;
  user: string;
  /** The model that answered; null when the call failed. */
  model: string | null;
  raw_text: string | null;
  reasoning: string | null;
  reasoning_tokens: number | null;
  stop_reason: string | null;
  request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  error: string | null;
  /** For a judge call, its audit: the ids the reply left out or invented, and the quotes not found in the artifact. */
  checks?: { missing_ids: string[]; unexpected_ids: string[]; evidence_not_found: string[] };
}

const active = new AsyncLocalStorage<LlmCall[]>();

/**
 * Run `run`, collecting every model call it makes. Whether `run` succeeds or
 * throws, the calls come back: a failed call is the reason for the failure.
 */
export async function captureLlmCalls<T>(
  run: () => Promise<T>
): Promise<{ calls: LlmCall[]; result: { ok: true; value: T } | { ok: false; error: unknown } }> {
  const calls: LlmCall[] = [];
  try {
    const value = await active.run(calls, run);
    return { calls, result: { ok: true, value } };
  } catch (error) {
    return { calls, result: { ok: false, error } };
  }
}

/** Make one model call, recording it in the capture it runs inside, if any. */
export async function callModel(
  provider: Provider,
  purpose: LlmPurpose,
  options: JudgeJsonOptions
): Promise<ProviderResult> {
  const started = new Date();
  const t0 = performance.now();
  const base = {
    purpose,
    started: started.toISOString(),
    provider: provider.name,
    model_requested: options.model,
    effort: options.effort,
    max_output_tokens: options.maxOutputTokens,
    system: options.system,
    user: options.user
  };
  try {
    const result = await provider.judgeJson(options);
    active.getStore()?.push({
      ...base,
      model: result.model,
      raw_text: result.rawText ?? null,
      reasoning: result.reasoningText ?? null,
      reasoning_tokens: result.reasoningTokens ?? null,
      stop_reason: result.stopReason ?? null,
      request_id: result.requestId ?? null,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      latency_ms: Math.round(performance.now() - t0),
      error: null
    });
    return result;
  } catch (error) {
    active.getStore()?.push({
      ...base,
      model: null,
      raw_text: error instanceof JudgeError ? (error.raw ?? null) : null,
      reasoning: error instanceof JudgeError ? (error.reasoning ?? null) : null,
      reasoning_tokens: null,
      stop_reason: null,
      request_id: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: Math.round(performance.now() - t0),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/** Attach the judge's audit to the latest judge call in the current capture. */
export function noteJudgeChecks(checks: NonNullable<LlmCall['checks']>): void {
  const call = active.getStore()?.findLast((c) => c.purpose === 'judge');
  if (call) call.checks = checks;
}
