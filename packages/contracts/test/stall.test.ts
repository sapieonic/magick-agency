import { describe, expect, it } from 'vitest';
import * as Root from '../src/index';
import { AGENCY_STALL_PRIORITY, type AgencyStall, type AgencyStallCode } from '../src/agency';
import type { AgencyApi } from '../src/index';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// `credits_low` is not a member of either stall union, nor a discriminant of
// either evidence union (fails `pnpm lint` if it comes back).
const _coreNoCredits: 'credits_low' extends AgencyStallCode ? false : true = true;
const _consoleNoCredits: 'credits_low' extends AgencyApi.AgencyStallCode ? false : true = true;
const _coreArmNoCredits: 'credits_low' extends AgencyStall['code'] ? false : true = true;
const _consoleArmNoCredits: 'credits_low' extends AgencyApi.AgencyStall['code'] ? false : true = true;
// Core's and the console's stall vocabularies agree exactly after the removal.
const _sameCodes: Equals<AgencyStallCode, AgencyApi.AgencyStallCode> = true;
const _armsCoverCodes: Equals<AgencyStall['code'], AgencyStallCode> = true;
void [_coreNoCredits, _consoleNoCredits, _coreArmNoCredits, _consoleArmNoCredits, _sameCodes, _armsCoverCodes];

describe('stall vocabulary', () => {
  it('has no credits_low in the single priority list', () => {
    expect(AGENCY_STALL_PRIORITY as readonly string[]).not.toContain('credits_low');
  });

  it('keeps core’s order for the remaining seven', () => {
    expect([...AGENCY_STALL_PRIORITY]).toEqual([
      'auto_paused_abandonment',
      'dnc_unavailable',
      'no_agents_available',
      'concurrency_saturated',
      'outside_calling_hours',
      'list_exhausted_retries_pending',
      'elevated_failure_rate',
    ]);
  });

  it('no longer exports the core-vs-master producer split', () => {
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
