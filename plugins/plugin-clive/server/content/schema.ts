/**
 * The reply contracts every provider validates against, and the JSON text a
 * provider is told to match.
 *
 * `JudgeResultSchema` mirrors `content/base/output_schema.json` (which is also
 * shipped verbatim as `JUDGE_JSON_SCHEMA`); the nudge and hint shapes come from
 * the pydantic models in `clive-userflow/src/clive/{nudge,hint}.py`. Ported from
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

export const NudgeSchema = z.object({
  /** Which situation the student is in (`../situations.ts`); `other` when the model gave none. */
  situation: z.string().default('other'),
  summary: z.string(),
  focus_id: z.string(),
  reason: z.string(),
  nudge: z.string()
});

export const CodeNudgeSchema = z.object({
  situation: z.string().default('other'),
  summary: z.string(),
  focus: z.string(),
  nudge: z.string()
});

export const StuckSchema = z.object({
  /** The idea the student lacks, for the researcher: `student.stuck` logs it and the page never gets it. */
  diagnosis: z.string(),
  feedback: z.string()
});

export type ModelVerdict = z.infer<typeof VerdictSchema>;
export type ModelJudgeResult = z.infer<typeof JudgeResultSchema>;
export type ModelNudge = z.infer<typeof NudgeSchema>;
export type ModelStuck = z.infer<typeof StuckSchema>;

/** The JSON Schema text for a reply shape, for a provider told the shape in its system message. */
export function jsonSchemaText(schema: z.ZodType<unknown>): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
