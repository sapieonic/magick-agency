import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgencyQueueState } from '@magick-agency/contracts/agency';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@magick-agency/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@magick-agency/observability')>();
  return {
    ...actual,
    createChildLogger: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { summaryQueue } from '../../../src/api/routes/proxy-agency-assignment/my-contacts.js';

/*
 * The My contacts summary's `queue` (`my-contacts.ts`): the station's reading when it was read;
 * on a `pool` campaign a failed campaign probe answers from the tally's earliest open contact with
 * a warning, never a 500; on `strict` / `preferred` a failed read is rethrown, as it always was.
 */

const ALL_DAY = {
  calling_window_start: '00:00:00', calling_window_end: '24:00:00', calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
};
const pool = { id: 'camp-1', tenant_id: 't1', assignment_mode: 'pool', ...ALL_DAY } as const;
const strict = { ...pool, assignment_mode: 'strict' } as const;
const now = new Date('2026-11-20T10:00:00Z');
const later = new Date('2026-11-20T10:10:00Z');
const failed: PromiseSettledResult<AgencyQueueState | undefined> = { status: 'rejected', reason: new Error('statement timeout') };

beforeEach(() => mocks.warn.mockReset());

describe('summaryQueue', () => {
  it('the reading when it was read, on any campaign', () => {
    const read: AgencyQueueState = { due: false, reason: 'callbacks_later', next_due_at: later.toISOString() };
    expect(summaryQueue(pool, 'agent-1', { status: 'fulfilled', value: read }, null, now)).toBe(read);
    expect(summaryQueue(strict, 'agent-1', { status: 'fulfilled', value: read }, null, now)).toBe(read);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('pool: a failed probe answers from the earliest open contact, with a warning, never a throw', () => {
    expect(summaryQueue(pool, 'agent-1', failed, later, now)).toEqual({
      due: false, reason: 'waiting_for_retry', next_due_at: later.toISOString(),
    });
    expect(summaryQueue(pool, 'agent-1', failed, null, now)).toEqual({ due: false, reason: 'queue_empty', next_due_at: null });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', campaignId: 'camp-1', userId: 'agent-1', err: 'statement timeout' }),
      expect.stringContaining('pool queue read failed'),
    );
  });

  it('strict / preferred: a failed read is rethrown unchanged (the tally has no stand-in for the agent\'s own queue)', () => {
    expect(() => summaryQueue(strict, 'agent-1', failed, later, now)).toThrow('statement timeout');
    expect(() => summaryQueue({ ...strict, assignment_mode: 'preferred' }, 'agent-1', failed, later, now)).toThrow('statement timeout');
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
