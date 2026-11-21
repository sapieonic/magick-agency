import { describe, it, expect } from 'vitest';
import {
  archivedLine,
  canArchiveCampaign,
  isArchivableStatus,
  isArchivedCampaign,
  ARCHIVED_START_REASON,
} from '../../utils/agencyCampaignArchive';
import { agencyCampaignControls, isLifecycleActionEnabled } from '../../utils/agencyCampaignControls';

/** Archived campaigns (AR1–AR6): the console's half of the rule and the copy. */

describe('which campaigns can be archived', () => {
  it('is a draft or a stopped campaign, and nothing else', () => {
    expect(['draft', 'stopped'].filter(isArchivableStatus)).toEqual(['draft', 'stopped']);
    for (const status of ['running', 'paused', 'stopping', 'completed', 'archived', '']) {
      expect(isArchivableStatus(status), status).toBe(false);
    }
  });

  it('is not one archived already; an older server that sends no archived_at reads as not archived', () => {
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
