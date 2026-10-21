import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  practiceSession: { count: vi.fn() },
  sessionHistoryEntry: { createMany: vi.fn() }
}));
vi.mock('$lib/zenstack', () => ({ db }));

import { POST } from './+server';

const MINE = '123e4567-e89b-42d3-a456-426614174000';
const THEIRS = '223e4567-e89b-42d3-a456-426614174000';

/** Post a batch as `userId` (or as nobody), with the database owning `owned` of the sessions it names. */
async function post(sessions: string[], userId: string | null, owned: number) {
  db.practiceSession.count.mockResolvedValue(owned);
  const batch = sessions.map((session_id) => ({
    session_id,
    timestamp: '2026-10-20T07:46:18.261Z',
    type: 'CLIVE_PROBLEM_READ',
    data: { phase: 'problem_definition' }
  }));
  const request = new Request('https://localhost/api/updateHistory', {
    method: 'POST',
    body: JSON.stringify(batch),
    headers: { 'content-type': 'application/json' }
  });
  const locals = { auth: async () => (userId ? { user: { id: userId } } : null) };
  return POST({ locals, request } as unknown as Parameters<typeof POST>[0]);
}

describe('POST /api/updateHistory', () => {
  beforeEach(() => {
    db.practiceSession.count.mockReset();
    db.sessionHistoryEntry.createMany.mockReset();
  });

  it('writes a batch into the caller’s own session', async () => {
    const response = await post([MINE, MINE], 'user-1', 1);

    expect(response.status).toBe(200);
    expect(db.practiceSession.count).toHaveBeenCalledWith({ where: { id: { in: [MINE] }, student_id: 'user-1' } });
    expect(db.sessionHistoryEntry.createMany).toHaveBeenCalledTimes(1);
    expect(db.sessionHistoryEntry.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('refuses a batch that names someone else’s session', async () => {
    const response = await post([THEIRS], 'user-1', 0);

    expect(response.status).toBe(403);
    expect(db.sessionHistoryEntry.createMany).not.toHaveBeenCalled();
  });

  it('refuses a batch mixing an own session with someone else’s', async () => {
    const response = await post([MINE, THEIRS], 'user-1', 1);

    expect(response.status).toBe(403);
    expect(db.sessionHistoryEntry.createMany).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not signed in', async () => {
    const response = await post([MINE], null, 1);

    expect(response.status).toBe(403);
    expect(db.sessionHistoryEntry.createMany).not.toHaveBeenCalled();
  });
});
