/**
 * Anthropic provider: `client.messages.parse` with schema-enforced output.
 *
 * Ported from `clive-userflow/src/clive/providers/anthropic.py`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { JudgeError } from '../content/errors';
import { apiKey, BaseProvider, type JudgeJsonOptions, type ProviderResult } from './provider';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

/** A message from `messages.parse`, whose `parsed_output` holds the schema-validated reply. */
type ParsedReplyMessage = Anthropic.Message & { parsed_output: unknown };

export class AnthropicProvider extends BaseProvider {
  public readonly name = 'anthropic';
  public readonly defaultModel = 'claude-opus-5';
  public readonly apiKeyEnv = 'ANTHROPIC_API_KEY';
  public readonly modelPrefixes = ['claude-'];

  public async judgeJson(options: JudgeJsonOptions): Promise<ProviderResult> {
    const client = new Anthropic({ apiKey: apiKey(this) });
    const effort: Effort = (EFFORTS as readonly string[]).includes(options.effort)
      ? (options.effort as Effort)
      : 'medium';

    let message: ParsedReplyMessage;
    try {
      // The cast narrows the SDK's conditional return type (`ParsedMessage<P>`) to the
      // schema passed below; `parsed_output` is validated against it a few lines down.
      message = (await client.messages.parse({
        model: options.model,
        max_tokens: options.maxOutputTokens,
        system: options.system,
        messages: [{ role: 'user', content: options.user }],
        thinking: { type: 'adaptive' },
        output_config: { effort, format: zodOutputFormat(options.schema) }
      })) as unknown as ParsedReplyMessage;
    } catch (error) {
      throw translate(error, options.model);
    }

    // The text blocks only: adaptive thinking is not part of the reply and is not kept.
    const raw = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (message.stop_reason === 'refusal') {
      throw new JudgeError(
        `The model declined to answer (${message.stop_details?.explanation ?? 'no explanation given'}).`,
        { raw }
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new JudgeError('Response hit max_tokens and the verdict list is truncated. Raise max_output_tokens.', {
        raw
      });
    }

    const result = options.schema.safeParse(message.parsed_output);
    if (!result.success) {
      throw new JudgeError(`Anthropic did not return a valid reply: ${result.error.message}`, { raw });
    }

    return {
      parsed: result.data,
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      rawText: raw,
      stopReason: message.stop_reason ?? undefined,
      requestId: message.id
    };
  }
}

function translate(error: unknown, model: string): JudgeError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new JudgeError('The API key was rejected. Check ANTHROPIC_API_KEY.');
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new JudgeError(`The model '${model}' does not exist or is not available to this key.`);
  }
  if (error instanceof Anthropic.RateLimitError) {
    const retryAfter = error.headers?.get('retry-after') ?? '60';
    return new JudgeError(`Rate limited; retry after ${retryAfter}s.`);
  }
  if (error instanceof Anthropic.APIError) {
    return new JudgeError(`API error ${error.status}: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new JudgeError('Could not reach the API. Check your connection.');
  }
  return new JudgeError(`Anthropic call failed: ${error instanceof Error ? error.message : String(error)}`);
}
