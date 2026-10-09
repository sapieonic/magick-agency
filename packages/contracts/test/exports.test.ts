import { describe, expect, it } from 'vitest';
import * as Root from '../src/index';
import { AgencyApi, PlatformApi } from '../src/index';
import {
  AGENCY_ABANDON_REASONS,
  AGENCY_CAMPAIGN_STATS_FIELDS,
  AGENCY_STATS_ROUTE_FIELDS,
} from '../src/agency';
import { SESSION_REFUSAL_CODES } from '../src/api/platform/auth';

describe('package surface', () => {
  it('exposes the two API layers as namespaces', () => {
    expect(typeof AgencyApi).toBe('object');
    expect(typeof PlatformApi).toBe('object');
    expect(AgencyApi.RETRY_NO_OUTCOME).toBe(Root.RETRY_NO_OUTCOME);
  });

  it('does not export the removed billing shapes at the root', () => {
    // Type-only in core, so absence is asserted by `pnpm lint` (they are not
    // declared); the runtime surface must not have grown a stand-in either.
    for (const name of ['AgencyAttemptBatchSettlementPayload', 'AGENCY_CORE_STALL_CODES']) {
      expect(Root).not.toHaveProperty(name);
    }
  });

  it('keeps core’s runtime rosters intact', () => {
    expect(AGENCY_ABANDON_REASONS).toHaveLength(5);
    for (const field of AGENCY_STATS_ROUTE_FIELDS) {
      expect(AGENCY_CAMPAIGN_STATS_FIELDS[field]).toBe(true);
    }
  });

  it('declares the session refusals agency answers with', () => {
    expect([...SESSION_REFUSAL_CODES]).toEqual(['email_unverified', 'no_membership']);
  });
});
