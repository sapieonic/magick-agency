import { describe, expect, it } from 'vitest';
import * as Root from '../src/index';
import {
  AGENCY_STALL_PRIORITY, CARRIER_ACCOUNT_PAUSE_REASONS, type AgencyStall, type AgencyStallCode, type CarrierAccountPauseReason,
} from '../src/agency';
import type { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

// `credits_low` is not a member of either stall union, nor a discriminant of
// either evidence union (fails `pnpm lint` if it comes back).
const _coreNoCredits: 'credits_low' extends AgencyStallCode ? false : true = true;
const _consoleNoCredits: 'credits_low' extends AgencyApi.AgencyStallCode ? false : true = true;
const _coreArmNoCredits: 'credits_low' extends AgencyStall['code'] ? false : true = true;
const _consoleArmNoCredits: 'credits_low' extends AgencyApi.AgencyStall['code'] ? false : true = true;
// The dialer runtime's and the console's stall vocabularies agree exactly after the removal.
const _sameCodes: Equals<AgencyStallCode, AgencyApi.AgencyStallCode> = true;
const _armsCoverCodes: Equals<AgencyStall['code'], AgencyStallCode> = true;
// The carrier-account pauses are the Insights headline's automatic non-guardrail pause
// reasons, exactly: a new automatic carrier pause added to one and not the other fails here.
type InsightsPauseReason = NonNullable<AgencyApi.AgencyInsightsHeadline['paused']>['reason'];
const _carrierPausesMatchInsights: Equals<
  CarrierAccountPauseReason, Exclude<InsightsPauseReason, 'supervisor' | 'abandonment_ceiling'>
> = true;
void [_coreNoCredits, _consoleNoCredits, _coreArmNoCredits, _consoleArmNoCredits, _sameCodes, _armsCoverCodes, _carrierPausesMatchInsights];

describe('stall vocabulary', () => {
  it('has no credits_low in the single priority list', () => {
    expect(AGENCY_STALL_PRIORITY as readonly string[]).not.toContain('credits_low');
  });

  it('keeps the priority order: the automatic pauses and the carrier-account stops first', () => {
    expect([...AGENCY_STALL_PRIORITY]).toEqual([
      'auto_paused_abandonment',
      'auto_paused_carrier',
      'no_dialable_caller_ids',
      'no_carrier_capacity',
      'dnc_unavailable',
      'no_agents_available',
      'concurrency_saturated',
      'outside_calling_hours',
      'list_exhausted_retries_pending',
      'elevated_failure_rate',
    ]);
  });

  it('lists every automatic carrier-account pause once', () => {
    expect([...CARRIER_ACCOUNT_PAUSE_REASONS]).toEqual(['carrier_auth', 'carrier_account_unavailable']);
  });

  it('exports no separate producer-subset list', () => {
    expect(Root).not.toHaveProperty('AGENCY_CORE_STALL_CODES');
  });

  it('exposes no credits_low anywhere in the package’s runtime exports', () => {
    const seen = new WeakSet<object>();
    const hits: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === 'credits_low') hits.push(path);
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(Root, 'root');
    expect(hits).toEqual([]);
  });
});
