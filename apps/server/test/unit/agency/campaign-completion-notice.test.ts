import { describe, it, expect, vi, beforeEach } from 'vitest';

// The in-process campaign-completion notice, reached from `PacingEngine.maybeFinalize`
// through the completion notifier. The outcome contract pinned here: the notifier
// awaited, `agency_campaign_notifications_total` incremented with `sent` or the
// returned reason, a throw counted as `threw` and never rethrown.

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { counter, sendAgencyCampaignCompletionEmail } = vi.hoisted(() => ({
  counter: { inc: vi.fn() },
  sendAgencyCampaignCompletionEmail: vi.fn(),
}));
vi.mock('@magick-agency/observability/metrics/platform', () => ({ agencyCampaignNotificationsTotal: counter }));
vi.mock('../../../src/notifications/agency-campaign-completion.js', () => ({ sendAgencyCampaignCompletionEmail }));

import { notifyAgencyCampaignFinished } from '../../../src/agency/campaign-completion-notice.js';
import type { AgencyCampaignRecord } from '../../../src/db/models/agency.model.js';

const ENDED = new Date('2026-10-08T10:00:00.000Z');
const campaign = {
  id: '6f7b35d5-2df4-4788-a4bb-faa7eea44df9',
  tenant_id: 'ae3661b1-691e-497d-8e03-43ff616053f2',
  account_id: 'b0d3c6c2-6cb1-4d1c-9a43-1d6f0d3e8f10',
  name: 'Q4 Winback',
  contacts_total: 120,
  ended_at: ENDED,
} as unknown as AgencyCampaignRecord;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifyAgencyCampaignFinished', () => {
  it('sends the campaign\'s own facts — its account UUID, name, end instant and roster size', async () => {
    sendAgencyCampaignCompletionEmail.mockResolvedValue({ sent: true, recipients: 2 });
    await notifyAgencyCampaignFinished(campaign, 'completed');
    expect(sendAgencyCampaignCompletionEmail).toHaveBeenCalledTimes(1);
    expect(sendAgencyCampaignCompletionEmail).toHaveBeenCalledWith({
      tenantId: campaign.tenant_id,
      accountId: campaign.account_id,
      campaignId: campaign.id,
      status: 'completed',
      campaignName: 'Q4 Winback',
      completedAt: ENDED.toISOString(),
      contactsTotal: 120,
    });
  });

  it('omits the counts it does not hold rather than defaulting them to 0', async () => {
    sendAgencyCampaignCompletionEmail.mockResolvedValue({ sent: false, reason: 'not_configured' });
    await notifyAgencyCampaignFinished(campaign, 'stopped');
    const arg = sendAgencyCampaignCompletionEmail.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['status']).toBe('stopped');
    expect('contactsCompleted' in arg).toBe(false);
    expect('attempts' in arg).toBe(false);
    expect('connects' in arg).toBe(false);
  });

  it('counts a delivered notice as `sent`', async () => {
    sendAgencyCampaignCompletionEmail.mockResolvedValue({ sent: true, recipients: 3 });
    await notifyAgencyCampaignFinished(campaign, 'completed');
    expect(counter.inc).toHaveBeenCalledWith({ tenant_id: campaign.tenant_id, result: 'sent' });
  });

  it('counts an undelivered notice by its reason, so a 2xx that told nobody is countable', async () => {
    for (const reason of ['not_configured', 'no_recipients', 'account_not_addressable', 'failed', 'already_notified', 'claim_unavailable']) {
      counter.inc.mockClear();
      sendAgencyCampaignCompletionEmail.mockResolvedValue({ sent: false, reason });
      await notifyAgencyCampaignFinished(campaign, 'completed');
      expect(counter.inc).toHaveBeenCalledWith({ tenant_id: campaign.tenant_id, result: reason });
    }
  });

  it('counts a throw as `threw` and never rethrows it into the leader', async () => {
    sendAgencyCampaignCompletionEmail.mockRejectedValue(new Error('outside the notifier'));
    await expect(notifyAgencyCampaignFinished(campaign, 'completed')).resolves.toBeUndefined();
    expect(counter.inc).toHaveBeenCalledWith({ tenant_id: campaign.tenant_id, result: 'threw' });
  });

  it('sends a null completed_at for a row with no end instant, never a fabricated one', async () => {
    sendAgencyCampaignCompletionEmail.mockResolvedValue({ sent: false, reason: 'not_configured' });
    await notifyAgencyCampaignFinished({ ...campaign, ended_at: null } as AgencyCampaignRecord, 'completed');
    expect((sendAgencyCampaignCompletionEmail.mock.calls[0]![0] as Record<string, unknown>)['completedAt']).toBeNull();
  });
});
