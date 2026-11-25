/**
 * The reply contracts every provider validates against, and the JSON text a
 * provider is told to match.
 *
 * `JudgeResultSchema` mirrors `content/base/output_schema.json` (which is also
 * shipped verbatim as `JUDGE_JSON_SCHEMA`); the code nudge's shape comes from the
 * pydantic models in `clive-userflow/src/clive/nudge.py`, and the judged nudge's is
 * nudge v9's own (`content/base/nudge.yaml`). Ported from
 * `clive-userflow/src/clive/judge.py`.
 */
import { z } from 'zod';

export const VerdictSchema = z.object({
  criterion_id: z.string(),
  verdict: z.enum(['PASS', 'FAIL']),
  evidence: z.string(),
  confidence: z.enum(['low', 'medium', 'high'])
});

export const JudgeResultSchema = z.object({
  verdicts: z.array(VerdictSchema)
});

/** The nudge's reply (nudge v9): the model no longer picks the requirement, a situation, or a summary. */
export const NudgeSchema = z.object({
  /** For the research log only: what the model thinks is behind the failure. */
  reason: z.string(),
  nudge: z.string()
});

export const CodeNudgeSchema = z.object({
  situation: z.string().default('other'),
  summary: z.string(),
  focus: z.string(),
  nudge: z.string()
});

export type ModelVerdict = z.infer<typeof VerdictSchema>;
export type ModelJudgeResult = z.infer<typeof JudgeResultSchema>;
export type ModelNudge = z.infer<typeof NudgeSchema>;

/** The JSON Schema text for a reply shape, for a provider told the shape in its system message. */
export function jsonSchemaText(schema: z.ZodType<unknown>): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
