import { describe, expect, it } from 'vitest';
import * as Root from '../src/index';
import { AgencyApi, PlatformApi } from '../src/index';
import {
  AGENCY_ABANDON_REASONS,
  AGENCY_CAMPAIGN_MIN_RATE_DENOMINATOR,
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_DEFAULT_DISPOSITION_RETRY,
  AGENCY_DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES,
  AGENCY_OUR_FAULT_REDIAL_BOUND,
  AGENCY_OUR_FAULT_RETRY_DEFAULT,
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  AGENCY_STATION_CLOSE,
  AGENCY_CAMPAIGN_STATS_FIELDS,
  AGENCY_STATS_ROUTE_FIELDS,
} from '../src/agency';
import { SESSION_REFUSAL_CODES } from '../src/api/platform/auth';
import {
  TELEPHONY_CREDENTIAL_ERROR_CODES,
  type TelephonyCredentialErrorCode,
} from '../src/api/platform/super-admin-telephony-credentials';
import type { Equals } from './type-equals';

// The list is exactly the union (the runtime list's own guard covers the other side).
const _credentialCodesExact: Equals<(typeof TELEPHONY_CREDENTIAL_ERROR_CODES)[number], TelephonyCredentialErrorCode> = true;
void _credentialCodesExact;

describe('package surface', () => {
  it('exposes the two API layers as namespaces', () => {
    expect(typeof AgencyApi).toBe('object');
    expect(typeof PlatformApi).toBe('object');
    expect(AgencyApi.RETRY_NO_OUTCOME).toBe(Root.RETRY_NO_OUTCOME);
  });

  it('does not export the removed billing shapes at the root', () => {
    // Type-only in the dialer runtime, so absence is asserted by `pnpm lint` (they are not
    // declared); the runtime surface must not have grown a stand-in either.
    for (const name of ['AgencyAttemptBatchSettlementPayload', 'AGENCY_CORE_STALL_CODES']) {
      expect(Root).not.toHaveProperty(name);
    }
  });

  it('keeps the runtime rosters intact', () => {
    expect(AGENCY_ABANDON_REASONS).toHaveLength(5);
    for (const field of AGENCY_STATS_ROUTE_FIELDS) {
      expect(AGENCY_CAMPAIGN_STATS_FIELDS[field]).toBe(true);
    }
  });

  it('declares the stats bucket units once, at the root', () => {
    expect([...Root.STATS_BUCKET_UNITS]).toEqual(['day', 'week', 'month']);
  });

  it('declares the four station close codes once (SNAPSHOT, written out by hand)', () => {
    expect(AGENCY_STATION_CLOSE).toEqual({
      TOKEN_REJECTED: 4401,
      SESSION_GONE: 4404,
      HEARTBEAT_TIMEOUT: 4408,
      SUPERSEDED: 4409,
    });
    // The console layer re-exports the same object rather than a copy that could drop a code.
    expect(AgencyApi.AGENCY_STATION_CLOSE).toBe(AGENCY_STATION_CLOSE);
  });

  it('declares the session refusals agency answers with', () => {
    expect([...SESSION_REFUSAL_CODES]).toEqual(['email_unverified', 'no_membership']);
  });

  it('declares the telephony credential refusals, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...TELEPHONY_CREDENTIAL_ERROR_CODES]).toEqual([
      'credential_store_unavailable',
      'secret_unavailable',
      'unknown_provider',
      'invalid_input',
      'tenant_not_found',
      'not_found',
      'duplicate_account',
      'duplicate_label',
      'carrier_rejected',
      'carrier_unreachable',
      'version_conflict',
      'invalid_transition',
      'in_use',
    ]);
    expect(new Set(TELEPHONY_CREDENTIAL_ERROR_CODES).size).toBe(TELEPHONY_CREDENTIAL_ERROR_CODES.length);
  });

  it('declares the campaign config defaults once (SNAPSHOT, written out by hand)', () => {
    // The server seeds and clamps with these and the console previews them; a
    // change here changes both, so it is a deliberate contract change.
    expect(AGENCY_DEFAULT_DISPOSITION_CATALOG).toEqual([
      { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
      { code: 'callback', label: 'Callback', requires_datetime: true },
      { code: 'do_not_call', label: 'Do not call', suppress: true },
    ]);
    expect(AGENCY_DEFAULT_DISPOSITION_CATALOG[0].retry).toBe(AGENCY_DEFAULT_DISPOSITION_RETRY);
    expect(AGENCY_OUR_FAULT_REDIAL_BOUND).toBe(3);
    expect(AGENCY_DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES).toBe(5);
    expect(AGENCY_OUR_FAULT_RETRY_DEFAULT).toEqual({ delay_minutes: 5, max_attempts: 3 });
    // Frozen all the way down: no consumer can rewrite a default for the process.
    expect(Object.isFrozen(AGENCY_DEFAULT_DISPOSITION_CATALOG)).toBe(true);
    for (const entry of AGENCY_DEFAULT_DISPOSITION_CATALOG) expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(AGENCY_DEFAULT_DISPOSITION_RETRY)).toBe(true);
    expect(Object.isFrozen(AGENCY_OUR_FAULT_RETRY_DEFAULT)).toBe(true);
    // The console wire layer re-exports the same objects rather than copies.
    expect(AgencyApi.AGENCY_DEFAULT_DISPOSITION_CATALOG).toBe(AGENCY_DEFAULT_DISPOSITION_CATALOG);
    expect(AgencyApi.AGENCY_OUR_FAULT_RETRY_DEFAULT).toBe(AGENCY_OUR_FAULT_RETRY_DEFAULT);
  });

  it('declares both rate floors, side by side and different on purpose', () => {
    // 20 is the server's roster floor (served as `rates_reportable`); 25 is the
    // console's campaign floor. Whether they should agree is an open product call.
    expect(AGENCY_ROSTER_MIN_RATE_DENOMINATOR).toBe(20);
    expect(AGENCY_CAMPAIGN_MIN_RATE_DENOMINATOR).toBe(25);
    expect(AgencyApi.AGENCY_CAMPAIGN_MIN_RATE_DENOMINATOR).toBe(AGENCY_CAMPAIGN_MIN_RATE_DENOMINATOR);
  });
});
