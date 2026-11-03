import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyCampaignRepository, agencyAttemptRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession } = await import(
  './agency-factories.js'
);

/**
 * Campaign stats with wrap-up redials present (real Postgres). A redial continues ONE
 * conversation, so it is counted as a redial (`attempts_redialed`, the floor row's
 * `redials`) and nowhere it would count that conversation twice:
 *
 *  - the connect buckets, conversions, the series' `connected` and the floor's
 *    `calls_handled` count each conversation once, at the attempt that carries its
 *    outcome (the last of the chain, bridged or not);
 *  - the system code `redialed` is in no breakdown and no conversion;
 *  - `attempts_connected` and `attempts_retried` leave redials out; the connect rate's
 *    denominator does too.
 */
const CATALOG = JSON.stringify([
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'voicemail', label: 'Voicemail' },
  { code: 'nope', label: 'Not interested' },
]);

beforeEach(truncateAll);
afterAll(closeTestPool);

const at = (iso: string) => new Date(iso);

describe('campaign stats with wrap-up redials (integration)', () => {
  async function seed() {
    const campaign = await insertAgencyCampaign({ status: 'running', disposition_catalog: CATALOG, default_timezone: 'UTC' });
    const id = campaign.id as string;
    const session = await insertAgentSession(id, { state: 'available' });
    const sid = session.id as string;
    const attempt = async (contactId: string, o: Record<string, unknown>) =>
      insertAgencyAttempt(id, contactId, { state: 'ended', reserved_agent_id: sid, ...o });

    // A plain conversation: one leg, `nope`.
    const plain = (await insertAgencyContact(id, { state: 'completed' })).id as string;
    await attempt(plain, {
      attempt_number: 1, outcome: 'connected', disposition_code: 'nope',
      dialed_at: at('2026-10-01T10:00:00Z'), answered_at: at('2026-10-01T10:00:05Z'),
      bridged_at: at('2026-10-01T10:00:05Z'), ended_at: at('2026-10-01T10:01:00Z'),
    });

    // A conversation redialled twice: connected (`redialed`) → rang out (`redialed`) →
    // connected and written up `sale`. One conversation, one conversion, two redials.
    const chain = (await insertAgencyContact(id, { state: 'completed' })).id as string;
    const a0 = await attempt(chain, {
      attempt_number: 1, outcome: 'connected', disposition_code: 'redialed',
      dialed_at: at('2026-10-01T11:00:00Z'), answered_at: at('2026-10-01T11:00:05Z'),
      bridged_at: at('2026-10-01T11:00:05Z'), ended_at: at('2026-10-01T11:01:00Z'),
    });
    const a1 = await attempt(chain, {
      attempt_number: 2, outcome: 'no_answer', disposition_code: 'redialed',
      redial_of_attempt_id: a0.id, redial_number: 1,
      dialed_at: at('2026-10-01T11:02:00Z'), ended_at: at('2026-10-01T11:02:30Z'),
    });
    await attempt(chain, {
      attempt_number: 3, outcome: 'connected', disposition_code: 'sale',
      redial_of_attempt_id: a1.id, redial_number: 2,
      dialed_at: at('2026-10-01T11:03:00Z'), answered_at: at('2026-10-01T11:03:05Z'),
      bridged_at: at('2026-10-01T11:03:05Z'), ended_at: at('2026-10-01T11:05:00Z'),
    });

    // A paced RETRY of a contact first dialled earlier: still a retry.
    const retried = (await insertAgencyContact(id, { state: 'pending' })).id as string;
    await attempt(retried, { attempt_number: 1, outcome: 'no_answer', dialed_at: at('2026-10-01T09:00:00Z'), ended_at: at('2026-10-01T09:00:30Z') });
    await attempt(retried, { attempt_number: 2, outcome: 'busy', dialed_at: at('2026-10-01T12:00:00Z'), ended_at: at('2026-10-01T12:00:10Z') });
    return { id, sid, chainOriginal: a0.id as string };
  }

  it('counts a redialled conversation once, its redials as redials, and never the code `redialed`', async () => {
    const { id } = await seed();
    const stats = await agencyCampaignRepository.stats(id);

    expect(stats.attempts_total).toBe(6);
    expect(stats.attempts_redialed).toBe(2);
    // The retry of `retried`, not the two redials (their attempt_number is 2 and 3).
    expect(stats.attempts_retried).toBe(1);
    // `outcome = connected`: the plain call and the chain's original, not the bridged redial.
    expect(stats.attempts_connected).toBe(2);
    // Two conversations, both written up by a human: `nope` and the chain's `sale`.
    expect(stats.human_connects).toBe(2);
    expect(stats.unclassified_connects).toBe(0);
    expect(stats.machine_connects).toBe(0);
    expect(stats.attempts_success).toBe(1);
    expect(stats.success_rate_pct).toBe(50);
    // Over the 4 dials that were not redials.
    expect(stats.connect_rate_pct).toBe(50);
  });

  it('the floor row counts conversations once and the session\'s redials', async () => {
    const { id, sid } = await seed();
    const stats = await agencyCampaignRepository.stats(id);
    const row = stats.agents.find((a) => a.session_id === sid)!;
    expect(row.calls_handled).toBe(2);
    expect(row.redials).toBe(2);
  });

  it('the series counts conversations once (connected, successes) and every dial (attempts)', async () => {
    const { id } = await seed();
    const series = await agencyCampaignRepository.statsSeries(
      { tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId }, id,
      { from: at('2026-10-01T00:00:00Z'), to: at('2026-10-02T00:00:00Z'), bucket: 'day' },
    );
    expect(series!.buckets).toHaveLength(1);
    expect(series!.buckets[0]).toMatchObject({ attempts: 6, connected: 2, successes: 1 });
    // Talk time is every bridged LEG, the redial's included: 55 + 55 + 115 s.
    expect(series!.buckets[0]!.talk_seconds).toBe(225);
  });

  it('the attempt rows carry the chain link', async () => {
    const { id, chainOriginal } = await seed();
    const { rows } = await agencyAttemptRepository.listForCampaign({ campaignId: id, filters: {}, limit: 50 });
    const original = rows.find((r) => r.id === chainOriginal)!;
    expect(original).toMatchObject({ redial_of_attempt_id: null, redial_number: 0 });
    const redials = rows.filter((r) => (r.redial_number ?? 0) > 0).sort((a, b) => a.redial_number! - b.redial_number!);
    expect(redials.map((r) => r.redial_number)).toEqual([1, 2]);
    expect(redials[0]!.redial_of_attempt_id).toBe(chainOriginal);
    expect(redials[1]!.redial_of_attempt_id).toBe(redials[0]!.id);
  });
});
