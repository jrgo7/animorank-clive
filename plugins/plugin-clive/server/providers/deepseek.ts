/**
 * DeepSeek provider: the OpenAI SDK pointed at `api.deepseek.com`.
 *
 * DeepSeek's API is OpenAI-compatible but has no schema-enforced structured
 * output: the target JSON Schema is appended to the system prompt and the reply
 * is validated here. Thinking is always on and asked for explicitly, and it is
 * paid for out of `max_tokens`, so a cap that is too small leaves an empty reply
 * (`finish_reason === 'length'`) and only partial reasoning.
 *
 * Ported from `clive-userflow/src/clive/providers/deepseek.py`.
 */
import OpenAI from 'openai';
import { JudgeError } from '../content/errors';
import { apiKey, BaseProvider, type JudgeJsonOptions, type ProviderResult } from './provider';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** The SDK's params plus DeepSeek's own `thinking` field, which is not in the SDK types. */
type DeepSeekParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
  thinking: { type: 'enabled' };
};

export class DeepSeekProvider extends BaseProvider {
  public readonly name = 'deepseek';
  public readonly defaultModel = 'deepseek-flash';
  public readonly apiKeyEnv = 'DEEPSEEK_API_KEY';
  public readonly modelPrefixes = ['deepseek-'];

  public async judgeJson(options: JudgeJsonOptions): Promise<ProviderResult> {
    const client = new OpenAI({ apiKey: apiKey(this), baseURL: DEEPSEEK_BASE_URL });

    // DeepSeek has no schema-enforced structured output; spelling the shape out in the
    // system prompt is also what satisfies json_object mode's "mention json" rule.
    const params: DeepSeekParams = {
      model: options.model,
      max_tokens: options.maxOutputTokens,
      messages: [
        {
          role: 'system',
          content:
            options.system +
            '\n\nReturn a single JSON object matching this JSON Schema exactly: ' +
            'every required key present, no extra or renamed keys, no prose, no ' +
            'code fences.\n' +
            options.schemaText
        },
        { role: 'user', content: options.user }
      ],
      response_format: { type: 'json_object' },
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' }
    };

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    let finishReason: string | null = null;
    let usage: OpenAI.Completions.CompletionUsage | undefined;
    let servedModel: string | undefined;
    let requestId: string | undefined;

    try {
      const stream = await client.chat.completions.create(params);
      for await (const chunk of stream) {
        requestId = requestId ?? chunk.id;
        servedModel = chunk.model || servedModel;
        usage = chunk.usage ?? usage;
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta;
          // `reasoning_content` is not a field the SDK types know about; `in` narrows
          // the read to unknown, and the typeof check validates it.
          if ('reasoning_content' in delta && typeof delta.reasoning_content === 'string') {
            reasoningParts.push(delta.reasoning_content);
          }
          if (typeof delta.content === 'string' && delta.content) textParts.push(delta.content);
          finishReason = choice.finish_reason ?? finishReason;
        }
      }
    } catch (error) {
      throw translate(error, options.model, {
        raw: textParts.join('') || undefined,
        reasoning: reasoningParts.join('') || undefined
      });
    }

    const text = textParts.join('');
    const reasoning = reasoningParts.join('') || undefined;

    if (finishReason === 'length') {
      throw new JudgeError(
        'Response hit max_tokens before the verdicts were finished. The model’s reasoning counts ' +
          'against that limit too. Raise max_output_tokens.',
        { raw: text, reasoning }
      );
    }
    if (finishReason === 'content_filter') {
      throw new JudgeError('The model declined to answer (content filtered).', { raw: text, reasoning });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (cause) {
      throw new JudgeError(
        `DeepSeek did not return valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        { raw: text, reasoning }
      );
    }
    const result = options.schema.safeParse(parsed);
    if (!result.success) {
      throw new JudgeError(`DeepSeek did not return a valid reply: ${result.error.message}`, {
        raw: text,
        reasoning
      });
    }

    return {
      parsed: result.data,
      model: servedModel ?? options.model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      rawText: text,
      stopReason: finishReason ?? undefined,
      reasoningText: reasoning
    };
  }
}

/**
 * The outermost `{...}` span of `text`, with any markdown fence stripped. JSON
 * mode returns a bare object, but a model can still wrap it in a fence or a
 * sentence, so this peels that off rather than trusting the mode.
 */
function extractJson(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.indexOf('```', 3) !== -1 ? s.split('```')[1] : s.slice(3);
    if (s.startsWith('json')) s = s.slice(4);
    s = s.trim();
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object found in model output: ${text.slice(0, 200)}`);
  }
  return s.slice(start, end + 1);
}

function translate(error: unknown, model: string, parts: { raw?: string; reasoning?: string }): JudgeError {
  if (error instanceof OpenAI.AuthenticationError) {
    return new JudgeError('The API key was rejected. Check DEEPSEEK_API_KEY.');
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new JudgeError(`The model '${model}' does not exist or is not available to this key.`);
  }
  if (error instanceof OpenAI.RateLimitError) {
    const retryAfter = error.headers?.get('retry-after') ?? '60';
    return new JudgeError(`Rate limited; retry after ${retryAfter}s.`);
  }
  if (error instanceof OpenAI.APIError) {
    return new JudgeError(`API error ${error.status}: ${error.message}`, parts);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new JudgeError('Could not reach the API. Check your connection.', parts);
  }
  return new JudgeError(
    `The reply stopped arriving: ${error instanceof Error ? error.name : typeof error}: ${
      error instanceof Error ? error.message.slice(0, 200) : String(error)
    }`,
    parts
  );
}
