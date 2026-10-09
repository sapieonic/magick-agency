import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import {
  ABANDONED_ATTEMPT_PREDICATE_SQL, ABANDONMENT_BRIDGE_GRACE_MS, isAbandonedAttempt,
} from '@magick-agency/domain/abandonment-predicate';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyAttemptRepository, agencyAbandonmentRepository } =
  await import('../../../src/db/repositories/agency.repository.js');

/**
 * NEW (magick-agency, lane B1; plan §9). Two invariants, each with a test that fails
 * if it breaks, run against real Postgres:
 *
 *  1. `answered_at` / `bridged_at` are NEVER back-filled. The abandonment predicate's
 *     only inputs are those columns, so inventing either one (stamping `bridged_at`
 *     when an attempt ends, or `answered_at` when it bridges) would move a call
 *     out of — or into — the compliance numerator. `setState` only writes what the
 *     caller passes.
 *  2. The predicate's two halves AGREE: `ABANDONED_ATTEMPT_PREDICATE_SQL` (what the
 *     24h window and the auto-pause read) and `isAbandonedAttempt` (what the settle
 *     site counts in-process) classify every arm identically. The ONE intended
 *     difference is the SQL's `state = 'ended'` terminal filter, which is asserted
 *     on a live row — data on which the two could disagree.
 *
 * The source's equivalent (chaos/abandonment-predicate-agreement) needs the Phase 6
 * dialer harness; this one drives the rows directly so it can ship with the
 * repository and is superseded, not replaced, by the chaos suite.
 */
describe('abandonment invariants (real Postgres)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  const T0 = new Date('2026-08-11T10:00:00.000Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);

  async function attemptWith(campaignId: string, row: Record<string, unknown>) {
    const contact = await insertAgencyContact(campaignId);
    return insertAgencyAttempt(campaignId, contact.id, row);
  }

  async function sqlSays(id: string): Promise<boolean> {
    const { rows } = await getTestPool().query<{ hit: boolean }>(
      `SELECT (${ABANDONED_ATTEMPT_PREDICATE_SQL}) AS hit FROM agency_call_attempts WHERE id = $1`, [id]);
    return rows[0]!.hit;
  }

  it('setState never back-fills answered_at or bridged_at', async () => {
    const campaign = await insertAgencyCampaign();
    const a = await attemptWith(campaign.id, { state: 'dialing' });
    // ends without a carrier answer: both stay NULL
    const ended = await agencyAttemptRepository.setState(a.id, 'ended', { outcome: 'no_answer', ended_at: at(5_000) });
    expect(ended!.answered_at).toBeNull();
    expect(ended!.bridged_at).toBeNull();
    // answered but never bridged, then ended: bridged_at is NOT invented
    const b = await attemptWith(campaign.id, { state: 'dialing' });
    await agencyAttemptRepository.setState(b.id, 'answered', { answered_at: at(1_000) });
    const bEnded = await agencyAttemptRepository.setState(b.id, 'ended', { outcome: 'abandoned', ended_at: at(9_000) });
    expect(bEnded!.answered_at).toEqual(at(1_000));
    expect(bEnded!.bridged_at).toBeNull();
    // bridged without an answer stamp: answered_at is NOT invented either
    const c = await attemptWith(campaign.id, { state: 'dialing' });
    const cBridged = await agencyAttemptRepository.setState(c.id, 'bridged', { bridged_at: at(2_000) });
    expect(cBridged!.answered_at).toBeNull();
    // and a later patch cannot clear a stamp that exists (COALESCE keeps it)
    const kept = await agencyAttemptRepository.setState(b.id, 'ended', { ended_at: at(9_500) });
    expect(kept!.answered_at).toEqual(at(1_000));
  });

  it('the SQL predicate and the in-process predicate agree on every shared arm', async () => {
    expect(ABANDONMENT_BRIDGE_GRACE_MS).toBe(1000);
    const campaign = await insertAgencyCampaign();
    const cases: Array<{ name: string; answered: number | null; bridged: number | null; outcome: string | null }> = [
      { name: 'never answered', answered: null, bridged: null, outcome: 'no_answer' },
      { name: 'answered, outcome abandoned', answered: 0, bridged: 400, outcome: 'abandoned' },
      { name: 'answered, never bridged', answered: 0, bridged: null, outcome: 'completed' },
      { name: 'bridged inside grace', answered: 0, bridged: 400, outcome: 'completed' },
      { name: 'bridged exactly AT grace', answered: 0, bridged: ABANDONMENT_BRIDGE_GRACE_MS, outcome: 'completed' },
      { name: 'bridged 1ms past grace', answered: 0, bridged: ABANDONMENT_BRIDGE_GRACE_MS + 1, outcome: 'completed' },
      { name: 'bridged, never answered', answered: null, bridged: 500, outcome: 'completed' },
    ];
    let abandoned = 0;
    for (const c of cases) {
      const row = await attemptWith(campaign.id, {
        state: 'ended', outcome: c.outcome, ended_at: at(20_000),
        answered_at: c.answered === null ? null : at(c.answered),
        bridged_at: c.bridged === null ? null : at(c.bridged),
      });
      const sql = await sqlSays(row.id);
      const inProcess = isAbandonedAttempt({
        answeredAt: c.answered === null ? null : at(c.answered),
        bridgedAt: c.bridged === null ? null : at(c.bridged),
        outcome: c.outcome,
      });
      expect(sql, c.name).toBe(inProcess);
      if (sql) abandoned++;
    }
    // the cases where they COULD disagree were all exercised, and some are abandoned
    expect(abandoned).toBe(3);
  });

  it('the terminal filter is the SQL half\'s alone: a LIVE answered-but-unbridged attempt counts zero', async () => {
    const campaign = await insertAgencyCampaign();
    const live = await attemptWith(campaign.id, { state: 'answered', answered_at: new Date(), bridged_at: null });
    expect(await sqlSays(live.id)).toBe(false);
    // the in-process half would say "abandoned" for the same facts — it is only ever
    // called at the settle site, i.e. once the attempt is terminal
    expect(isAbandonedAttempt({ answeredAt: new Date(), bridgedAt: null, outcome: null })).toBe(true);
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toMatch(/state\s*=\s*'ended'/);
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).not.toMatch(/\$\d/);
  });

  it('the 24h window the repository publishes counts exactly what the predicate counts', async () => {
    const campaign = await insertAgencyCampaign();
    const now = new Date();
    // answered + never bridged, terminal, inside the window: abandoned
    await attemptWith(campaign.id, { state: 'ended', outcome: 'completed', answered_at: new Date(now.getTime() - 60_000), bridged_at: null, ended_at: now });
    // answered + bridged fast: not abandoned
    await attemptWith(campaign.id, { state: 'ended', outcome: 'completed', answered_at: new Date(now.getTime() - 60_000), bridged_at: new Date(now.getTime() - 59_800), ended_at: now });
    // live answered-but-unbridged: excluded (terminal filter)
    await attemptWith(campaign.id, { state: 'answered', answered_at: new Date(now.getTime() - 30_000), bridged_at: null });
    const rows = await agencyAbandonmentRepository.window24h();
    const mine = rows.find((r) => r.campaign_id === campaign.id)!;
    expect(mine.answered).toBe(2);
    expect(mine.abandoned).toBe(1);
  });
});
