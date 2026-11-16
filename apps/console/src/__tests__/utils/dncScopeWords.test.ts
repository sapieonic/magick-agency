import { describe, expect, it } from 'vitest';
import {
  actsForWholeOrganisation,
  dncScopeWhere,
  dncScopeWords,
  mayManageEveryCampaignDnc,
} from '../../utils/dncScopeWords';

/**
 * The words a DNC entry's scope is named by, everywhere (DS7), and who may reach "every
 * campaign" (DS3). The mobile app pins the same strings (`dnc_scope_words_test.dart`).
 */

describe('dncScopeWords', () => {
  it('names each scope in the same words, never with its wire code', () => {
    expect(dncScopeWords('tenant')).toBe('Every campaign');
    expect(dncScopeWords('account', { accountName: 'North' })).toBe('North account');
    expect(dncScopeWords('account')).toBe('This account');
    expect(dncScopeWords('campaign', { campaignName: 'Q4 Renewals' })).toBe('Campaign: Q4 Renewals');
    expect(dncScopeWords('campaign')).toBe('A campaign that no longer exists');
    expect(dncScopeWords('campaign', { unnamedCampaign: 'One of this account’s campaigns' })).toBe('One of this account’s campaigns');
    for (const scope of ['tenant', 'account', 'campaign'] as const) {
      expect(dncScopeWords(scope, { accountName: 'N', campaignName: 'C' })).not.toMatch(/^(tenant|account|campaign)$/);
    }
  });

  it('says where an entry blocks, for "already blocked …"', () => {
    expect(dncScopeWhere('tenant')).toBe('in every campaign');
    expect(dncScopeWhere('account', { accountName: 'North' })).toBe('in every campaign of the North account');
    expect(dncScopeWhere('campaign', { campaignName: 'Q4 Renewals' })).toBe('in Q4 Renewals');
  });
});

describe('who may add or remove an every-campaign entry (DS3)', () => {
  const m = (role: string, account_id: string | null, tenant_id = 't1', status = 'active') =>
    ({ tenant_id, account_id, role, status }) as Parameters<typeof mayManageEveryCampaignDnc>[0][number];

  it('a member of the whole organisation with the manage floor', () => {
    expect(mayManageEveryCampaignDnc([m('account_admin', null)], 't1', 'a1')).toBe(true);
    expect(mayManageEveryCampaignDnc([m('tenant_owner', null)], 't1', 'a1')).toBe(true);
    expect(mayManageEveryCampaignDnc([m('operator', null)], 't1', 'a1')).toBe(false);
  });

  it('never an admin of one account, whatever the role', () => {
    expect(mayManageEveryCampaignDnc([m('tenant_admin', 'a1')], 't1', 'a1')).toBe(false);
    expect(actsForWholeOrganisation([m('tenant_admin', 'a1')], 't1', 'a1')).toBe(false);
  });

  it('acts as the account membership when the person holds both, as the server resolves it', () => {
    const both = [m('tenant_owner', null), m('account_admin', 'a1')];
    expect(mayManageEveryCampaignDnc(both, 't1', 'a1')).toBe(false);
    expect(mayManageEveryCampaignDnc(both, 't1', 'a2')).toBe(true);
    expect(actsForWholeOrganisation(both, 't1', 'a2')).toBe(true);
  });

  it('ignores other tenants and inactive memberships', () => {
    expect(mayManageEveryCampaignDnc([m('tenant_owner', null, 't2')], 't1', 'a1')).toBe(false);
    expect(mayManageEveryCampaignDnc([m('tenant_owner', null, 't1', 'suspended')], 't1', 'a1')).toBe(false);
    expect(mayManageEveryCampaignDnc([m('tenant_owner', null)], null, 'a1')).toBe(false);
  });
});
