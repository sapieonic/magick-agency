import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@magick-agency/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@magick-agency/observability')>();
  return {
    ...actual,
    createChildLogger: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { summaryCallerId } from '../../../src/api/routes/proxy-agency-assignment/my-contacts.js';

/*
 * The My contacts summary's `caller_id` (DN2, `my-contacts.ts`): the agent's dedicated number
 * while the campaign still has it, else null; and a failed dedication read answers null with a
 * warning instead of failing the whole summary (its other reads still answer).
 */

const campaign = { id: 'camp-1', tenant_id: 't1', caller_ids: ['+919000000001', ' +919000000002 '] };
const ok = (value: string | null): PromiseSettledResult<string | null> => ({ status: 'fulfilled', value });

beforeEach(() => mocks.warn.mockReset());

describe('summaryCallerId', () => {
  it('the stored number while it is one of the campaign\'s usable caller IDs; null when none or dropped', () => {
    expect(summaryCallerId(campaign, 'agent-1', ok('+919000000002'))).toBe('+919000000002');
    expect(summaryCallerId(campaign, 'agent-1', ok(null))).toBeNull();
    expect(summaryCallerId(campaign, 'agent-1', ok('+919000000009'))).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('a failed read is caller_id: null with a warning, never a throw', () => {
    const read: PromiseSettledResult<string | null> = { status: 'rejected', reason: new Error('connection reset') };
    expect(() => summaryCallerId(campaign, 'agent-1', read)).not.toThrow();
    expect(summaryCallerId(campaign, 'agent-1', read)).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', campaignId: 'camp-1', userId: 'agent-1', err: 'connection reset' }),
      expect.stringContaining('caller_id: null'),
    );
  });
});
