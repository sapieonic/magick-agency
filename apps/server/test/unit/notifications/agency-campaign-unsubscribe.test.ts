import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The unsubscribe gate on the agency campaign notice.
 *
 * This file exists because the gate's HAPPY PATH had no test execution at all.
 * The suite in `agency-campaign-completion.test.ts` does not mock the preference
 * repository, so `getPool()` throws, `suppressUnsubscribed` takes its fail-open
 * catch, and every assertion passes against the unfiltered list. Mutating the
 * successful return to `[]` — suppress every supervisor — left all 32 of those
 * tests green. The `agency.campaign.completed` toggle offered on the settings
 * page could have been completely broken with nothing to show it.
 *
 * So these mock the two dynamically-imported modules and exercise the branch
 * that actually runs in production.
 */

const mocks = vi.hoisted(() => ({
  findAddressableMembersInAccount: vi.fn(),
  findNotifiableMembers: vi.fn(),
  findForUsersAndEvent: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { brand: { name: 'Magick Agency', accent: '#7c5cfc' }, consoleBaseUrl: 'https://app.test' }, // PORT NOTE (magick-agency): master `cusuiBaseUrl`
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findAddressableMembersInAccount: mocks.findAddressableMembersInAccount },
}));
vi.mock('../../../src/db/repositories/notification-preference.repository.js', () => ({
  notificationPreferenceRepository: {
    findNotifiableMembers: mocks.findNotifiableMembers,
    findForUsersAndEvent: mocks.findForUsersAndEvent,
  },
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: { findByIdInTenant: vi.fn() },
}));
vi.mock('../../../src/notifications/mailjet.client.js', () => ({ sendEmail: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));

import { resolveCampaignNotificationRecipients } from '../../../src/notifications/agency-campaign-completion.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function member(id: string, email: string, role = 'account_admin') {
  return { user_id: id, id, email, role, account_id: null };
}

function preference(userId: string, enabled: boolean) {
  return {
    user_id: userId,
    tenant_id: TENANT,
    event_key: 'agency.campaign.completed',
    channel: 'email',
    enabled,
    frequency: null,
  };
}

describe('the agency campaign unsubscribe gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      member('u1', 'sup1@x.com'),
      member('u2', 'sup2@x.com'),
    ]);
    mocks.findNotifiableMembers.mockResolvedValue([
      member('u1', 'sup1@x.com'),
      member('u2', 'sup2@x.com'),
    ]);
    mocks.findForUsersAndEvent.mockResolvedValue([]);
  });

  it('keeps every supervisor when nobody has opted out', async () => {
    const kept = await resolveCampaignNotificationRecipients(TENANT);
    expect(kept.sort()).toEqual(['sup1@x.com', 'sup2@x.com']);
  });

  it('drops the supervisor who turned the notice off', async () => {
    // The assertion the whole feature rests on, and the one nothing made.
    mocks.findForUsersAndEvent.mockResolvedValue([preference('u2', false)]);
    const kept = await resolveCampaignNotificationRecipients(TENANT);
    expect(kept).toEqual(['sup1@x.com']);
  });

  it('restores a supervisor who turned it back on', async () => {
    mocks.findForUsersAndEvent.mockResolvedValue([preference('u2', true)]);
    const kept = await resolveCampaignNotificationRecipients(TENANT);
    expect(kept.sort()).toEqual(['sup1@x.com', 'sup2@x.com']);
  });

  it('returns nothing when everyone has opted out', async () => {
    mocks.findForUsersAndEvent.mockResolvedValue([preference('u1', false), preference('u2', false)]);
    expect(await resolveCampaignNotificationRecipients(TENANT)).toEqual([]);
  });

  it('sends to a shared inbox if ANY user behind it still wants the notice', async () => {
    // `users.email` carries only a non-unique index, so two people can share an
    // address. An inbox cannot be half-subscribed.
    mocks.findAddressableMembersInAccount.mockResolvedValue([member('u1', 'ops@x.com')]);
    mocks.findNotifiableMembers.mockResolvedValue([
      member('u1', 'ops@x.com'),
      member('u3', 'ops@x.com'),
    ]);
    mocks.findForUsersAndEvent.mockResolvedValue([preference('u1', false)]);

    expect(await resolveCampaignNotificationRecipients(TENANT)).toEqual(['ops@x.com']);
  });

  it('matches case-insensitively but returns the original spelling', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([member('u1', 'Sup1@X.com')]);
    mocks.findNotifiableMembers.mockResolvedValue([member('u1', 'sup1@x.com')]);
    mocks.findForUsersAndEvent.mockResolvedValue([]);

    expect(await resolveCampaignNotificationRecipients(TENANT)).toEqual(['Sup1@X.com']);
  });

  it('FAILS OPEN when the preference lookup throws', async () => {
    // These recipients were entitled by role before preferences existed, and the
    // notice carries operational news — a database blip must not silently
    // withhold it. The opposite call from the digest, deliberately.
    mocks.findNotifiableMembers.mockRejectedValue(new Error('pool exhausted'));
    const kept = await resolveCampaignNotificationRecipients(TENANT);
    expect(kept.sort()).toEqual(['sup1@x.com', 'sup2@x.com']);
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('does not query preferences at all when no supervisor was found', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([]);
    expect(await resolveCampaignNotificationRecipients(TENANT)).toEqual([]);
    expect(mocks.findNotifiableMembers).not.toHaveBeenCalled();
  });
});
