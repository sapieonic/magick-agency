import { describe, expect, it } from 'vitest';
import {
  AGENCY_COLLECTIONS_STARTER_CATALOG,
  isAgencyTileIcon,
  type AgencyDisposition,
} from '@magick-agency/contracts/agency';
import { validateAgencyCampaignConfig as validateInternal } from '../../../src/agency/campaign-config.js';
import {
  validateAgencyCampaignConfig as validatePublic,
  withCampaignConfigDefaults,
} from '../../../src/agency/agency-campaign-config.js';
import { builtInSemanticMismatches, resolveDispositionDecision } from '../../../src/agency/disposition-policy.js';

/**
 * The "Collections" starter set New campaign offers (AS4, `AGENCY_COLLECTIONS_STARTER_CATALOG` in
 * `packages/contracts/src/agency/campaign-defaults.ts`): it must save as it is, through both of the
 * server's catalog validators, and each outcome must do what its words say when an agent picks it.
 */

const catalog = AGENCY_COLLECTIONS_STARTER_CATALOG as unknown as AgencyDisposition[];
const byLabel = (label: string): AgencyDisposition => catalog.find((d) => d.label === label)!;

describe('the Collections starter set', () => {
  it('passes the internal handler\'s catalog validator, as a create and as a PATCH over the stored pair', () => {
    expect(validateInternal({ disposition_catalog: catalog })).toEqual([]);
    expect(validateInternal({ disposition_catalog: catalog }, { disposition_catalog: [], outcome_dispositions: {} })).toEqual([]);
  });

  it('passes the public layer\'s validator (with its built-in code rules) and is forwarded unchanged', () => {
    expect(validatePublic({ disposition_catalog: catalog })).toEqual([]);
    expect(builtInSemanticMismatches(catalog)).toEqual([]);
    expect((withCampaignConfigDefaults({ disposition_catalog: catalog }) as { disposition_catalog: unknown }).disposition_catalog)
      .toBe(catalog);
  });

  it('six outcomes in the station\'s words, unique codes, every icon from the tile list', () => {
    expect(catalog.map((d) => d.label)).toEqual([
      'Will pay', 'Call later', 'No one spoke', 'Refused', 'Wrong number', "Don't call again",
    ]);
    expect(new Set(catalog.map((d) => d.code)).size).toBe(6);
    for (const entry of catalog) expect(isAgencyTileIcon(entry.icon), entry.code).toBe(true);
  });

  it('each outcome does what it says: pay date, call later, try again, finish, stop calling', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const decide = (label: string, callbackAt: Date | null = null) =>
      resolveDispositionDecision(byLabel(label), { now, attemptsUsed: 1, callbackAt });

    expect(byLabel('Will pay')).toMatchObject({ requires_promise: true, is_success: true });
    expect(byLabel('Will pay')).not.toHaveProperty('promise_follow_up_days');

    const later = new Date('2026-11-21T04:30:00Z');
    expect(byLabel('Call later').requires_datetime).toBe(true);
    expect(decide('Call later', later)).toMatchObject({ contactState: 'pending', nextAttemptAt: later, reason: 'callback_scheduled' });

    expect(decide('No one spoke')).toMatchObject({ contactState: 'pending', reason: 'disposition_retry_scheduled' });

    expect(byLabel('Refused').requires_note).toBe(true);
    expect(decide('Refused')).toMatchObject({ contactState: 'completed', reason: 'disposition_recorded' });

    expect(decide('Wrong number')).toMatchObject({ contactState: 'completed', reason: 'disposition_terminal' });

    expect(decide("Don't call again")).toMatchObject({ contactState: 'suppressed', suppressedReason: 'dnc' });
    // The only outcome that stops the number, so the station confirms it and shows no separate row.
    expect(catalog.filter((d) => d.suppress === true).map((d) => d.code)).toEqual(['do_not_call']);
  });
});
