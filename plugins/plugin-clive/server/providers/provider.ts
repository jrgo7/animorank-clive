/**
 * The provider seam: one call that turns a rendered prompt into a validated
 * result. Ported from `clive-userflow/src/clive/providers/base.py`.
 *
 * `judge.ts` builds the prompts and audits the reply; it never imports a vendor
 * SDK. A provider takes the system/user text, the model knobs and the zod schema
 * the reply must satisfy, and returns a {@link ProviderResult}, having translated
 * its own auth, rate-limit, not-found, connection, refusal and truncation
 * failures into a {@link JudgeError}.
 */
import { env } from '$env/dynamic/private';
import type { z } from 'zod';

export interface JudgeJsonOptions {
  system: string;
  user: string;
  model: string;
  maxOutputTokens: number;
  effort: string;
  /** The shape the reply is validated against. */
  schema: z.ZodType<unknown>;
  /** The same schema as JSON text, for a provider told the shape in its system message. */
  schemaText: string;
}

export interface ProviderResult {
  /** The reply, already validated against `schema`. */
  parsed: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The reply text as the model sent it, before parsing. */
  rawText?: string;
  stopReason?: string;
  /** The model's reasoning before it replied, when the provider returns it. */
  reasoningText?: string;
}

export interface Provider {
  readonly name: string;
  /** Used when a phase document does not pin `model.id`. */
  readonly defaultModel: string;
  /** Environment variable holding this provider's API key. */
  readonly apiKeyEnv: string;
  /** Model-id prefixes this provider serves. */
  readonly modelPrefixes: readonly string[];
  ownsModel(_modelId: string): boolean;
  /** Whether this provider's API key is present in the environment. */
  hasApiKey(): boolean;
  judgeJson(_options: JudgeJsonOptions): Promise<ProviderResult>;
}

/**
 * Shared behavior: which model ids a provider serves. A phase pinning a
 * `claude-*` or `deepseek-*` model reaches the right provider even when
 * `CLIVE_PROVIDER` names the other one.
 */
export abstract class BaseProvider implements Provider {
  public abstract readonly name: string;
  public abstract readonly defaultModel: string;
  public abstract readonly apiKeyEnv: string;
  public abstract readonly modelPrefixes: readonly string[];

  public ownsModel(modelId: string): boolean {
    const id = (modelId ?? '').toLowerCase();
    return this.modelPrefixes.some((prefix) => id.startsWith(prefix));
  }

  public hasApiKey(): boolean {
    return apiKey(this) !== undefined;
  }

  public abstract judgeJson(_options: JudgeJsonOptions): Promise<ProviderResult>;
}

/** This provider's API key, or `undefined` when the environment does not set one. */
export function apiKey(provider: Provider): string | undefined {
  const value = (env as Record<string, string | undefined>)[provider.apiKeyEnv];
  return value ? value : undefined;
}
