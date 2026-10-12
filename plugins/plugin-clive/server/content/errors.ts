/**
 * A judging run failed for a reason worth showing the user verbatim.
 *
 * Ported from `clive-userflow/src/clive/providers/base.py`. Every provider and
 * engine module raises this rather than a vendor exception, so a route can turn
 * any of them into the same 400 with a readable message.
 *
 * `raw` is whatever text the model did send before the failure (a truncated or
 * unparseable reply); `reasoning` is the same for its thinking. Both are for a
 * call log; the message stays short enough to show a user.
 */
export class JudgeError extends Error {
  public readonly raw?: string;
  public readonly reasoning?: string;

  constructor(message: string, parts: { raw?: string; reasoning?: string } = {}) {
    super(message);
    this.name = 'JudgeError';
    this.raw = parts.raw;
    this.reasoning = parts.reasoning;
  }
}
