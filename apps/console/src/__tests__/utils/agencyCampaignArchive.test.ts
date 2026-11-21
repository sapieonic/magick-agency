import { describe, it, expect } from 'vitest';
import {
  archivedLine,
  canArchiveCampaign,
  isArchivedCampaign,
  ARCHIVED_START_REASON,
  pickerCampaignName,
  subscriptionCampaignOptions as campaignOptions,
  withHeldArchived,
} from '../../utils/agencyCampaignArchive';
import { agencyCampaignControls, isLifecycleActionEnabled } from '../../utils/agencyCampaignControls';

/** Archived campaigns (AR1–AR7): the console's half of the rule and the copy. */

describe('which campaigns can be archived', () => {
  it('is a draft or a stopped campaign, not one archived already; an older server that sends no archived_at reads as not archived', () => {
    expect(canArchiveCampaign({ status: 'stopped', archived_at: null })).toBe(true);
    expect(canArchiveCampaign({ status: 'running', archived_at: null })).toBe(false);
    expect(canArchiveCampaign({ status: 'draft', archived_at: null })).toBe(true);
    expect(canArchiveCampaign({ status: 'draft' })).toBe(true);
    expect(canArchiveCampaign({ status: 'draft', archived_at: '2026-11-20T06:00:00Z' })).toBe(false);
    expect(isArchivedCampaign({})).toBe(false);
  });
});

describe('archivedLine', () => {
  it('says when and by whom, by name only, never by id', () => {
    expect(archivedLine({ archived_at: '2026-11-20T06:00:00Z', archived_by: { user_id: 'u-1', name: ' Ravi ' } }))
      .toBe('Archived on 20 Nov 2026 by Ravi');
    expect(archivedLine({ archived_at: '2026-11-20T06:00:00Z', archived_by: { user_id: 'u-1', name: null } }))
      .toBe('Archived on 20 Nov 2026');
    expect(archivedLine({ archived_at: '2026-11-20T06:00:00Z', archived_by: null })).toBe('Archived on 20 Nov 2026');
    expect(archivedLine({ archived_at: 'not a date' })).toBe('Archived');
    expect(archivedLine({ archived_at: null })).toBeNull();
  });
});

describe('the lifecycle controls of an archived campaign', () => {
  it('refuse Start on an archived draft beside why, and offer nothing on an archived stopped one', () => {
    expect(agencyCampaignControls('draft', { archived: true })).toEqual([{ action: 'start', disabledReason: ARCHIVED_START_REASON }]);
    expect(agencyCampaignControls('stopped', { archived: true })).toEqual([]);
    expect(isLifecycleActionEnabled('draft', 'start', { archived: true })).toBe(false);
  });

  it('leave a campaign that is not archived as they were', () => {
    expect(agencyCampaignControls('draft')).toEqual(agencyCampaignControls('draft', { archived: false }));
    expect(isLifecycleActionEnabled('draft', 'start')).toBe(true);
  });
});

describe('pickers holding an archived campaign', () => {
  const live = [{ id: 'a', name: 'Live' }];
  const archived = [
    { id: 'x', name: 'Old', archived_at: '2026-11-20T06:00:00Z' },
    { id: 'y', name: 'Older', archived_at: '2026-11-19T06:00:00Z' },
  ];

  it('marks an archived campaign by name', () => {
    expect(pickerCampaignName({ name: 'Old', archived_at: '2026-11-20T06:00:00Z' })).toBe('Old (archived)');
    expect(pickerCampaignName({ name: 'Live', archived_at: null })).toBe('Live');
    expect(pickerCampaignName({ name: 'Live' })).toBe('Live');
  });

  it('adds back only the archived campaigns the picker already holds, after the others, once', () => {
    expect(withHeldArchived(live, archived, ['a', 'x']).map((c) => c.id)).toEqual(['a', 'x']);
    expect(withHeldArchived(live, archived, []).map((c) => c.id)).toEqual(['a']);
    // A held id in both lists (restored between the two reads) is not listed twice.
    expect(withHeldArchived([...live, { id: 'x', name: 'Old' }], archived, ['x']).map((c) => c.id)).toEqual(['a', 'x']);
  });
});

describe('the report subscription picker (subscriptionCampaignOptions)', () => {
  const campaigns = [{ id: 'a', name: 'Live' }];

  it('lists the campaigns as they are for a new subscription or one whose campaign is listed', () => {
    expect(campaignOptions(campaigns, null)).toEqual([{ id: 'a', name: 'Live' }]);
    expect(campaignOptions(campaigns, { kind: 'campaign', subject: { id: 'a', name: 'Live' } })).toEqual([{ id: 'a', name: 'Live' }]);
  });

  it('keeps the campaign of a subscription being edited when it is archived, marked', () => {
    expect(campaignOptions(campaigns, { kind: 'campaign', subject: { id: 'x', name: 'Old' } }))
      .toEqual([{ id: 'a', name: 'Live' }, { id: 'x', name: 'Old (archived)' }]);
    expect(campaignOptions(campaigns, { kind: 'campaign', subject: { id: 'x', name: null } }).at(-1))
      .toEqual({ id: 'x', name: 'This campaign (archived)' });
  });

  it('does not mark the held campaign archived before the list is read', () => {
    expect(campaignOptions(null, { kind: 'campaign', subject: { id: 'a', name: 'Live' } })).toEqual([{ id: 'a', name: 'Live' }]);
  });

  it('adds nothing for an agent or account subscription', () => {
    expect(campaignOptions(campaigns, { kind: 'agent', subject: { id: 'u-1', name: 'Asha' } })).toEqual([{ id: 'a', name: 'Live' }]);
  });
});
