import { describe, expect, it } from 'vitest';
import { agentsWithoutCampaign } from '../../../src/api/routes/proxy-agency-call-settings.routes.js';
import { manualDncScope, dncMarkScope } from '../../../src/agency/softphone/softphone-service.js';
import type { AccountMemberRoles } from '../../../src/db/repositories/agency.repository.js';

/*
 * "Every call must belong to a campaign" (docs/call-log.md §5): the two pure rules beside it.
 * The setting's enforcement is pinned through the real app, on real Postgres:
 * test/integration/api/call-settings.test.ts and softphone-routes.test.ts.
 */

const member = (roles: string[], onTaggable: boolean, id = roles.join('+')): AccountMemberRoles =>
  ({ user_id: id, name: id, roles, on_taggable_campaign: onTaggable });

describe('agentsWithoutCampaign: who the rule would stop from dialling', () => {
  it('an agent on no campaign a call can be logged to; never one who is on one', () => {
    expect(agentsWithoutCampaign([member(['agent'], false), member(['agent'], true, 'staffed')]).map((m) => m.user_id)).toEqual(['agent']);
  });

  it('never a supervisor (they may log a call to any campaign), whatever other seat they hold', () => {
    for (const roles of [['account_admin'], ['tenant_admin'], ['tenant_owner'], ['agent', 'account_admin']]) {
      expect(agentsWithoutCampaign([member(roles, false)]), roles.join()).toEqual([]);
    }
  });

  it('only a member who holds the agent role: a viewer and an operator may dial too, and are not the floor`s agents', () => {
    expect(agentsWithoutCampaign([member(['viewer'], false), member(['operator'], false)])).toEqual([]);
    expect(agentsWithoutCampaign([member(['agent', 'viewer'], false)]).map((m) => m.user_id)).toEqual(['agent+viewer']);
  });

  it('never someone with no role the server knows', () => {
    expect(agentsWithoutCampaign([member([], false, 'none'), member(['janitor'], false)])).toEqual([]);
  });
});

describe('manualDncScope (CL6): how far a soft-phone call\'s Do Not Call reaches', () => {
  const row = (campaign_id: string | null, contact_id: string | null) => ({ campaign_id, contact_id, account_id: 'acct-1' });

  it('the campaign\'s when the number is on that campaign\'s list', () => {
    expect(manualDncScope(row('camp-1', 'contact-1'))).toBe('campaign');
    expect(dncMarkScope(row('camp-1', 'contact-1'))).toEqual({ campaignId: 'camp-1' });
  });

  it('the account\'s when the campaign is only where the call is filed, and when there is none', () => {
    expect(manualDncScope(row('camp-1', null))).toBe('account');
    expect(dncMarkScope(row('camp-1', null))).toEqual({ accountScope: 'acct-1' });
    expect(manualDncScope(row(null, null))).toBe('account');
    expect(dncMarkScope(row(null, null))).toEqual({ accountScope: 'acct-1' });
  });
});
