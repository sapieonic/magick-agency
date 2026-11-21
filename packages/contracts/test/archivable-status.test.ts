import { describe, it, expect } from 'vitest';
import { isAgencyCampaignArchivableStatus } from '../src/api/agency/agency-campaign';

/** Which campaigns may be archived (AR2), the rule the server's routes and the console's buttons share. */
describe('isAgencyCampaignArchivableStatus', () => {
  it('is a draft or a stopped campaign, and nothing else', () => {
    expect(['draft', 'running', 'paused', 'stopping', 'completed', 'stopped', 'archived', ''].filter(isAgencyCampaignArchivableStatus))
      .toEqual(['draft', 'stopped']);
  });
});
