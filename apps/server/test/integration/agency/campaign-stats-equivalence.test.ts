import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyAttempt,
  insertAgencyCampaign,
  insertAgencyContact,
  insertAgentSession,
} = await import('./agency-factories.js');
const { ABANDONED_ATTEMPT_PREDICATE_SQL, ABANDONMENT_WINDOW_HOURS } = await import(
  '@magick-agency/domain/abandonment-predicate'
);
const { successDispositionSql } = await import('@magick-agency/domain/success-disposition');
const { AUTO_DISPOSITION_CODE } = await import('../../../src/agency/disposition.js');

/**
 * ─── `stats()` and `healthInputs()` against a REFERENCE spelling of each counter ─
 *
 * `stats()` reads every contact and attempt counter in two single-pass
 * `COUNT(*) FILTER (WHERE …)` aggregates, and `healthInputs()` reads the pending
 * timezones and the next retry in one grouped scan. Both were once one subquery
 * per number: about twenty scans of the campaign's rows per dashboard request.
 *
 * {@link REFERENCE_STATS_SQL} is that per-number spelling, kept here as the
 * oracle: each counter as its own `SELECT COUNT(*) … WHERE`, which is the
 * obviously-correct reading of what the field means. The fixture puts at least one
 * row in every contact state, every attempt state and every predicate's edge
 * (inside/outside the 24h window, a late bridge, an orphan, a voicemail, the
 * auto-disposition, measured and unmeasured wrap-ups, an un-dialled retry row), plus
 * a DECOY campaign carrying the same shapes that must count nowhere. Every counter
 * must equal its reference, and a few are also pinned to hand-counted values so the
 * comparison cannot pass by both sides being empty.
 */

const VOICEMAIL = 'voicemail';

/** One subquery per counter: the pre-aggregation statement, verbatim in meaning. */
const REFERENCE_STATS_SQL = `SELECT
  (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1)::text AS contacts_total,
  (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending')::text AS contacts_pending,
  (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'in_flight')::text AS contacts_in_flight,
  (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'completed')::text AS contacts_completed,
  (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'suppressed')::text AS contacts_suppressed,
  (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'exhausted')::text AS contacts_exhausted,
  (SELECT COUNT(*) FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at > now())::text AS retries_pending,
  (SELECT COUNT(*) FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended')::text AS attempts_live,
  (SELECT COUNT(*) FROM agency_call_attempts WHERE campaign_id = $1)::text AS attempts_total,
  (SELECT COUNT(*) FROM agency_call_attempts WHERE campaign_id = $1 AND outcome = 'connected')::text AS attempts_connected,
  (SELECT COUNT(*) FROM agency_call_attempts
     WHERE campaign_id = $1 AND attempt_number > 1 AND dialed_at IS NOT NULL)::text AS attempts_retried,
  (SELECT COUNT(*) FROM agency_agent_sessions WHERE campaign_id = $1 AND left_at IS NULL)::text AS agents_live,
  (SELECT COUNT(*) FROM agency_call_attempts
     WHERE campaign_id = $1 AND state = 'ended' AND answered_at IS NOT NULL
       AND answered_at > now() - ($2 || ' hours')::interval)::text AS answered_24h,
  (SELECT COUNT(*) FROM agency_call_attempts
     WHERE campaign_id = $1 AND answered_at > now() - ($2 || ' hours')::interval
       AND (${ABANDONED_ATTEMPT_PREDICATE_SQL}))::text AS abandoned_24h,
  (SELECT COUNT(*) FROM agency_call_attempts
     WHERE campaign_id = $1 AND bridged_at IS NOT NULL AND disposition_code IS NOT NULL
       AND disposition_code <> $3 AND disposition_code <> $4)::text AS human_connects,
  (SELECT COUNT(*) FROM agency_call_attempts
     WHERE campaign_id = $1 AND bridged_at IS NOT NULL
       AND (disposition_code IS NULL OR disposition_code = $4))::text AS unclassified_connects,
  (SELECT COUNT(*) FROM agency_call_attempts
     WHERE campaign_id = $1 AND bridged_at IS NOT NULL AND disposition_code = $3)::text AS machine_connects,
  (SELECT COUNT(*) FROM agency_call_attempts a
     JOIN agency_campaigns c ON c.id = a.campaign_id
     WHERE a.campaign_id = $1 AND a.bridged_at IS NOT NULL
       AND ${successDispositionSql({ attempt: 'a', catalog: 'c.disposition_catalog' })})::text AS attempts_success,
  (SELECT EXISTS (
     SELECT 1 FROM agency_campaigns c, LATERAL jsonb_array_elements(c.disposition_catalog) e
      WHERE c.id = $1 AND e->>'code' = $3))::text AS machine_connects_available,
  (SELECT AVG(EXTRACT(EPOCH FROM (ended_at - bridged_at))) FROM agency_call_attempts
     WHERE campaign_id = $1 AND state = 'ended' AND bridged_at IS NOT NULL
       AND outcome IS DISTINCT FROM 'orphaned' AND disposition_code IS DISTINCT FROM $3)::text AS aht_seconds,
  (SELECT AVG(EXTRACT(EPOCH FROM (ended_at - bridged_at))) FROM agency_call_attempts
     WHERE campaign_id = $1 AND state = 'ended' AND bridged_at IS NOT NULL
       AND outcome IS DISTINCT FROM 'orphaned')::text AS aht_seconds_including_machine,
  (SELECT AVG(EXTRACT(EPOCH FROM (wrapup_ended_at - wrapup_started_at))) FROM agency_call_attempts
     WHERE campaign_id = $1 AND wrapup_started_at IS NOT NULL AND wrapup_ended_at IS NOT NULL
       AND wrapup_resolution IN ('disposition_submitted','auto_return','agent_returned'))::text AS avg_wrapup_seconds,
  (SELECT abandonment_ceiling_pct FROM agency_campaigns WHERE id = $1)::text AS abandonment_ceiling_pct`;

async function referenceRow(campaignId: string): Promise<Record<string, string | null>> {
  const { rows } = await getTestPool().query<Record<string, string | null>>(
    REFERENCE_STATS_SQL,
    [campaignId, ABANDONMENT_WINDOW_HOURS, VOICEMAIL, AUTO_DISPOSITION_CODE],
  );
  return rows[0]!;
}

const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
const plusSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);

/**
 * Every contact state, every attempt state, and the edge of every predicate. The
 * same shapes are written to `decoy` too, so a counter that lost its campaign
 * predicate would double.
 */
async function seedCampaign(catalog: unknown[], status = 'running'): Promise<string> {
  const campaign = await insertAgencyCampaign({
    status,
    disposition_catalog: JSON.stringify(catalog),
    abandonment_ceiling_pct: 4.5,
  });
  const id = campaign.id as string;
  const contact = async (overrides: Record<string, unknown>) =>
    (await insertAgencyContact(id, overrides)).id as string;

  const pendingDue = await contact({ state: 'pending', next_attempt_at: minutesAgo(1), timezone: 'Asia/Kolkata' });
  const pendingRetry = await contact({ state: 'pending', next_attempt_at: minutesAgo(-90), timezone: 'Asia/Kolkata' });
  const pendingRetryLater = await contact({ state: 'pending', next_attempt_at: minutesAgo(-30), timezone: null });
  const inFlight = await contact({ state: 'in_flight' });
  const connected = await contact({ state: 'connected' });
  const completed = await contact({ state: 'completed' });
  const suppressed = await contact({ state: 'suppressed', suppressed_reason: 'dnc' });
  const exhausted = await contact({ state: 'exhausted' });
  const spare = await Promise.all(Array.from({ length: 6 }, () => contact({ state: 'completed' })));

  const attempt = (contactId: string, overrides: Record<string, unknown>) =>
    insertAgencyAttempt(id, contactId, overrides);

  // Live, one per non-terminal state (uq_agency_attempt_live: one per contact).
  await attempt(pendingDue, { state: 'queued', attempt_number: 2 }); // an UN-PLACED retry row
  await attempt(inFlight, { state: 'dialing', dialed_at: minutesAgo(1) });
  await attempt(connected, { state: 'ringing', dialed_at: minutesAgo(1) });
  await attempt(pendingRetry, { state: 'answered', dialed_at: minutesAgo(2), answered_at: minutesAgo(1) });
  const bridgedAt = minutesAgo(1);
  await attempt(pendingRetryLater, {
    state: 'bridged', dialed_at: minutesAgo(2), answered_at: bridgedAt, bridged_at: bridgedAt,
  });

  // Ended. Each on its own contact/attempt_number pair.
  const human = minutesAgo(120);
  await attempt(completed, {
    attempt_number: 1, state: 'ended', outcome: 'connected', disposition_code: 'sale',
    dialed_at: minutesAgo(121), answered_at: human, bridged_at: plusSeconds(human, 0.4), ended_at: plusSeconds(human, 90),
    wrapup_started_at: plusSeconds(human, 90), wrapup_ended_at: plusSeconds(human, 120),
    wrapup_resolution: 'disposition_submitted',
  });
  await attempt(completed, {
    attempt_number: 2, state: 'ended', outcome: 'connected', disposition_code: VOICEMAIL,
    dialed_at: minutesAgo(101), answered_at: minutesAgo(100), bridged_at: minutesAgo(100), ended_at: minutesAgo(99),
    wrapup_started_at: minutesAgo(99), wrapup_ended_at: minutesAgo(98), wrapup_resolution: 'forced',
  });
  await attempt(suppressed, {
    attempt_number: 1, state: 'ended', outcome: 'connected', disposition_code: null,
    dialed_at: minutesAgo(81), answered_at: minutesAgo(80), bridged_at: minutesAgo(80), ended_at: minutesAgo(78),
    wrapup_started_at: minutesAgo(78), wrapup_ended_at: plusSeconds(minutesAgo(78), 45), wrapup_resolution: 'auto_return',
  });
  await attempt(suppressed, {
    attempt_number: 2, state: 'ended', outcome: 'connected', disposition_code: AUTO_DISPOSITION_CODE,
    dialed_at: minutesAgo(71), answered_at: minutesAgo(70), bridged_at: minutesAgo(70), ended_at: minutesAgo(69),
  });
  // An orphan: bridged, ended by the reaper at sweep time.
  await attempt(exhausted, {
    attempt_number: 1, state: 'ended', outcome: 'orphaned', disposition_code: 'sale',
    dialed_at: minutesAgo(61), answered_at: minutesAgo(60), bridged_at: minutesAgo(60), ended_at: minutesAgo(5),
  });
  // Abandoned: answered, never bridged.
  await attempt(exhausted, {
    attempt_number: 2, state: 'ended', outcome: 'abandoned',
    dialed_at: minutesAgo(51), answered_at: minutesAgo(50), ended_at: minutesAgo(49),
  });
  // A LATE bridge (past the grace): abandoned by the predicate, and a human connect.
  await attempt(exhausted, {
    attempt_number: 3, state: 'ended', outcome: 'connected', disposition_code: 'not_interested',
    dialed_at: minutesAgo(41), answered_at: minutesAgo(40), bridged_at: plusSeconds(minutesAgo(40), 5), ended_at: minutesAgo(38),
  });
  // Answered OUTSIDE the 24h window.
  await attempt(spare[0]!, {
    state: 'ended', outcome: 'connected', disposition_code: 'sale',
    dialed_at: minutesAgo(26 * 60 + 1), answered_at: minutesAgo(26 * 60), bridged_at: minutesAgo(26 * 60), ended_at: minutesAgo(26 * 60 - 3),
  });
  await attempt(spare[1]!, { state: 'ended', outcome: 'no_answer', dialed_at: minutesAgo(30), ended_at: minutesAgo(29) });
  await attempt(spare[2]!, { state: 'ended', outcome: 'failed', dialed_at: minutesAgo(3), ended_at: minutesAgo(3) });
  await attempt(spare[3]!, { state: 'ended', outcome: 'busy', attempt_number: 3, dialed_at: minutesAgo(20), ended_at: minutesAgo(20) });

  // The floor: two live sessions (one on a break), one that left.
  await insertAgentSession(id, { state: 'available' });
  await insertAgentSession(id, { state: 'break', break_reason: 'lunch' });
  await insertAgentSession(id, { state: 'offline', left_at: minutesAgo(10) });
  return id;
}

describe('campaign stats — single-pass aggregates vs one subquery per counter (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  const CATALOG = [
    { code: 'sale', label: 'Sale', is_success: true },
    { code: VOICEMAIL, label: 'Voicemail', is_success: false },
    { code: 'not_interested', label: 'Not interested', is_success: false },
  ];

  it('every counter equals its reference over a fixture that touches every state', async () => {
    const id = await seedCampaign(CATALOG);
    await seedCampaign(CATALOG, 'paused'); // the decoy (one running campaign per account)

    const ref = await referenceRow(id);
    const stats = await agencyCampaignRepository.stats(id);

    const num = (k: string) => Number(ref[k] ?? 0);
    const avg = (k: string) => (ref[k] === null || ref[k] === undefined ? null : Number(ref[k]));
    expect({
      contacts_total: stats.contacts_total,
      contacts_pending: stats.contacts_pending,
      contacts_in_flight: stats.contacts_in_flight,
      contacts_completed: stats.contacts_completed,
      contacts_suppressed: stats.contacts_suppressed,
      contacts_exhausted: stats.contacts_exhausted,
      retries_pending: stats.retries_pending,
      attempts_live: stats.attempts_live,
      attempts_total: stats.attempts_total,
      attempts_connected: stats.attempts_connected,
      attempts_retried: stats.attempts_retried,
      agents_live: stats.agents_live,
      answered_24h: stats.answered_24h,
      abandoned_24h: stats.abandoned_24h,
      human_connects: stats.human_connects,
      unclassified_connects: stats.unclassified_connects,
      machine_connects: stats.machine_connects,
      attempts_success: stats.attempts_success,
      machine_connects_available: stats.machine_connects_available,
      aht_seconds: stats.aht_seconds,
      aht_seconds_including_machine: stats.aht_seconds_including_machine,
      avg_wrapup_seconds: stats.avg_wrapup_seconds,
      abandonment_ceiling_pct: stats.abandonment_ceiling_pct,
    }).toEqual({
      contacts_total: num('contacts_total'),
      contacts_pending: num('contacts_pending'),
      contacts_in_flight: num('contacts_in_flight'),
      contacts_completed: num('contacts_completed'),
      contacts_suppressed: num('contacts_suppressed'),
      contacts_exhausted: num('contacts_exhausted'),
      retries_pending: num('retries_pending'),
      attempts_live: num('attempts_live'),
      attempts_total: num('attempts_total'),
      attempts_connected: num('attempts_connected'),
      attempts_retried: num('attempts_retried'),
      agents_live: num('agents_live'),
      answered_24h: num('answered_24h'),
      abandoned_24h: num('abandoned_24h'),
      human_connects: num('human_connects'),
      unclassified_connects: num('unclassified_connects'),
      machine_connects: num('machine_connects'),
      attempts_success: num('attempts_success'),
      machine_connects_available: ref['machine_connects_available'] === 'true',
      aht_seconds: avg('aht_seconds'),
      aht_seconds_including_machine: avg('aht_seconds_including_machine'),
      avg_wrapup_seconds: avg('avg_wrapup_seconds'),
      abandonment_ceiling_pct: Number(ref['abandonment_ceiling_pct']),
    });

    // Hand-counted, so the comparison above cannot pass on two empty sides.
    expect(stats.contacts_total).toBe(14);
    expect(stats.contacts_pending).toBe(3);
    expect(stats.retries_pending).toBe(2);
    expect(stats.attempts_live).toBe(5);
    expect(stats.attempts_total).toBe(16);
    expect(stats.attempts_retried).toBe(5); // the queued attempt_number 2 was never placed
    expect(stats.agents_live).toBe(2);
    expect(stats.answered_24h).toBe(7);
    expect(stats.abandoned_24h).toBe(2);
    expect(stats.human_connects).toBe(4);
    expect(stats.machine_connects).toBe(1);
    expect(stats.unclassified_connects).toBe(3);
    expect(stats.attempts_success).toBe(3);
    expect(stats.machine_connects_available).toBe(true);
    expect(stats.avg_wrapup_seconds).toBe(37.5);
    expect(stats.abandonment_ceiling_pct).toBe(4.5);
  });

  it('agrees on an EMPTY campaign — zeros and null averages, not NaN', async () => {
    const campaign = await insertAgencyCampaign({ status: 'draft' });
    const id = campaign.id as string;
    const ref = await referenceRow(id);
    const stats = await agencyCampaignRepository.stats(id);
    expect(ref['aht_seconds']).toBeNull();
    expect(stats.aht_seconds).toBeNull();
    expect(stats.aht_seconds_including_machine).toBeNull();
    expect(stats.avg_wrapup_seconds).toBeNull();
    expect(stats.contacts_total).toBe(0);
    expect(stats.attempts_total).toBe(0);
    expect(stats.attempts_success).toBe(0);
    expect(stats.machine_connects_available).toBe(false);
  });

  it('healthInputs: pending by timezone and the next retry, as separate reads would give them', async () => {
    const id = await seedCampaign(CATALOG);
    await seedCampaign(CATALOG, 'paused');

    const { rows: tz } = await getTestPool().query<{ timezone: string | null; n: string }>(
      `SELECT timezone, COUNT(*)::text AS n FROM agency_contacts
        WHERE campaign_id = $1 AND state = 'pending' GROUP BY timezone`,
      [id],
    );
    const { rows: [retry] } = await getTestPool().query<{ next_attempt_at: Date | null }>(
      `SELECT MIN(next_attempt_at) AS next_attempt_at FROM agency_contacts
        WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at > now()`,
      [id],
    );

    const health = await agencyCampaignRepository.healthInputs(id);
    const byZone = (rows: Array<{ timezone: string | null; count: number }>) =>
      [...rows].sort((a, b) => String(a.timezone).localeCompare(String(b.timezone)));
    expect(byZone(health.pendingByTimezone)).toEqual(
      byZone(tz.map((r) => ({ timezone: r.timezone, count: Number(r.n) }))),
    );
    expect(health.pendingByTimezone).toHaveLength(2);
    expect(health.nextRetryAt?.toISOString()).toBe(retry!.next_attempt_at!.toISOString());
  });

  it('healthInputs: no future retry ⇒ null, even when pending contacts exist', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgencyContact(campaign.id as string, { state: 'pending', next_attempt_at: minutesAgo(5) });
    const health = await agencyCampaignRepository.healthInputs(campaign.id as string);
    expect(health.nextRetryAt).toBeNull();
    expect(health.pendingByTimezone).toEqual([{ timezone: null, count: 1 }]);
  });
});
