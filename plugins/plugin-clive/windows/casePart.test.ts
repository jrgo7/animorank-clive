/** Which box of a case the feedback is about, so the page can mark it. */
import { describe, expect, it } from 'vitest';
import { casePartFor } from './feedback';

describe('casePartFor', () => {
  it('maps each Cases requirement to the box it is about', () => {
    expect(casePartFor('case_is_concrete')).toBe('input');
    expect(casePartFor('outputs_are_correct')).toBe('output');
    expect(casePartFor('work_is_shown')).toBe('working');
    // Optional, so never a nudge's focus: it marks no box.
    expect(casePartFor('worked_out_differently')).toBeNull();
  });

  it('marks nothing for a requirement it does not know, or no feedback', () => {
    expect(casePartFor('banana')).toBeNull();
    expect(casePartFor(undefined)).toBeNull();
  });
});
