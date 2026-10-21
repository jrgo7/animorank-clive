import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JudgeError } from './content/errors';
import { callModel, captureLlmCalls, noteJudgeChecks } from './llmCalls';
import type { JudgeJsonOptions, Provider, ProviderResult } from './providers';

function fakeProvider(judgeJson: (_options: JudgeJsonOptions) => Promise<ProviderResult>): Provider {
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    apiKeyEnv: 'UNUSED',
    modelPrefixes: ['fake-'],
    ownsModel: () => true,
    hasApiKey: () => true,
    judgeJson
  };
}

const options: JudgeJsonOptions = {
  system: 'You judge.',
  user: 'STUDENT ARTIFACT\n...',
  model: 'fake-flash',
  maxOutputTokens: 32000,
  effort: 'medium',
  schema: z.unknown(),
  schemaText: '{}'
};

const answered = fakeProvider(async () => ({
  parsed: { verdicts: [] },
  model: 'fake-flash-0601',
  inputTokens: 1586,
  outputTokens: 259,
  rawText: '{"verdicts":[]}',
  stopReason: 'stop',
  reasoningText: 'All three pass.',
  requestId: 'req-1',
  reasoningTokens: 120
}));

describe('callModel', () => {
  it('records a successful call with its prompts, reply and timing', async () => {
    const { calls, result } = await captureLlmCalls(() => callModel(answered, 'judge', options));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: 'judge',
      provider: 'fake',
      model_requested: 'fake-flash',
      effort: 'medium',
      max_output_tokens: 32000,
      system: 'You judge.',
      user: 'STUDENT ARTIFACT\n...',
      model: 'fake-flash-0601',
      raw_text: '{"verdicts":[]}',
      reasoning: 'All three pass.',
      reasoning_tokens: 120,
      stop_reason: 'stop',
      request_id: 'req-1',
      input_tokens: 1586,
      output_tokens: 259,
      error: null
    });
    expect(calls[0].latency_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(calls[0].started))).toBe(false);
  });

  it('records a failed call with the error and the partial reply, then rethrows', async () => {
    const cutOff = fakeProvider(async () => {
      throw new JudgeError('cut off', { raw: '{"ver', reasoning: 'thinking' });
    });

    const { calls, result } = await captureLlmCalls(() => callModel(cutOff, 'nudge', options));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(JudgeError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: 'nudge',
      error: 'cut off',
      raw_text: '{"ver',
      reasoning: 'thinking',
      model: null,
      input_tokens: null,
      output_tokens: null
    });
  });

  it('keeps calls in the order they were made', async () => {
    const { calls } = await captureLlmCalls(async () => {
      await callModel(answered, 'judge', options);
      await callModel(answered, 'nudge', options);
    });

    expect(calls.map((c) => c.purpose)).toEqual(['judge', 'nudge']);
  });

  it('notes the judge audit on the judge call', async () => {
    const { calls } = await captureLlmCalls(async () => {
      await callModel(answered, 'judge', options);
      noteJudgeChecks({ missing_ids: ['a'], unexpected_ids: [], evidence_not_found: ['b'] });
    });

    expect(calls[0].checks).toEqual({ missing_ids: ['a'], unexpected_ids: [], evidence_not_found: ['b'] });
  });

  it('keeps two captures running at once apart', async () => {
    const [first, second] = await Promise.all([
      captureLlmCalls(() => callModel(answered, 'judge', options)),
      captureLlmCalls(() => callModel(answered, 'stuck', options))
    ]);

    expect(first.calls.map((c) => c.purpose)).toEqual(['judge']);
    expect(second.calls.map((c) => c.purpose)).toEqual(['stuck']);
  });

  it('calls the provider normally outside a capture', async () => {
    await expect(callModel(answered, 'judge', options)).resolves.toMatchObject({ model: 'fake-flash-0601' });
  });
});
