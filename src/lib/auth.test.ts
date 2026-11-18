import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The env the policy reads, mutable per test. */
const env = vi.hoisted(() => ({ WHITELISTED_EMAILS: undefined as string | undefined }));
/** `TeacherList` lookups, resolved per test. */
const findUnique = vi.hoisted(() => vi.fn());

vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('./zenstack', () => ({ db: { teacherList: { findUnique } } }));

import { admitsEmail, whitelistedEmails } from './auth';

describe('whitelistedEmails', () => {
  it('names the addresses the variable lists', () => {
    expect([...whitelistedEmails('a@example.com,b@example.com')]).toEqual(['a@example.com', 'b@example.com']);
  });

  it('normalizes what an operator is likely to paste', () => {
    // Spaces around entries, a trailing comma and an empty entry are all what a
    // hand-edited `.env` looks like; none of them may lock an address out.
    expect([...whitelistedEmails(' A@Example.com , , b@example.com, ')]).toEqual(['a@example.com', 'b@example.com']);
  });

  it('admits nobody when the variable is unset or empty', () => {
    expect(whitelistedEmails(undefined).size).toBe(0);
    expect(whitelistedEmails('').size).toBe(0);
    expect(whitelistedEmails(' , ').size).toBe(0);
  });

  it('does not read an entry as a wildcard for its domain', () => {
    expect(whitelistedEmails('@example.com').has('someone@example.com')).toBe(false);
  });
});

describe('admitsEmail', () => {
  beforeEach(() => {
    env.WHITELISTED_EMAILS = undefined;
    findUnique.mockReset();
    findUnique.mockResolvedValue(null);
  });

  it('admits an address the operator whitelisted, without asking the teacher list', async () => {
    env.WHITELISTED_EMAILS = 'student@example.com';

    await expect(admitsEmail('student@example.com')).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('admits a teacher who is not on the whitelist', async () => {
    findUnique.mockResolvedValue({ email: 'teacher@example.com' });

    await expect(admitsEmail('teacher@example.com')).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'teacher@example.com' } });
  });

  it('refuses an address that is neither whitelisted nor a teacher', async () => {
    env.WHITELISTED_EMAILS = 'someone@example.com';

    await expect(admitsEmail('stranger@example.com')).resolves.toBe(false);
  });

  it('admits nobody but teachers when the variable is unset', async () => {
    // The old policy let the whole `@dlsu.edu.ph` domain in; an unset whitelist
    // now admits only what the teacher list names.
    await expect(admitsEmail('student@dlsu.edu.ph')).resolves.toBe(false);
  });

  it('compares the address as the provider gives it', async () => {
    env.WHITELISTED_EMAILS = 'Student@Example.com';

    await expect(admitsEmail('student@example.com')).resolves.toBe(true);
  });
});
