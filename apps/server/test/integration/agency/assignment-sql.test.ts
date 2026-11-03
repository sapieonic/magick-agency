import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';
import {
  agentRetryAvailableAtSql,
  agentRetryBlockSql,
  callbackCodes,
  contactBucketSql,
} from '../../../src/db/repositories/agency/assignment-sql.js';
import { params } from '../../../src/db/repositories/agency/query-builders.js';

/**
 * The one definition of a contact's bucket and of its agent-retry eligibility
 * (`assignment-sql.ts`), on real Postgres: every agent and supervisor read is built from
 * these fragments, so their answers are pinned here once.
 */
describe('assignment-sql (real Postgres)', () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closeTestPool(); });

  const CALLBACK_CODES = ['callback', 'promise_to_pay'];

  async function bucketOf(contactId: string): Promise<string> {
    const p = params();
    const id = p.add(contactId);
    const codes = p.add(CALLBACK_CODES);
    const { rows } = await getTestPool().query<{ bucket: string }>(
      `SELECT ${contactBucketSql('c', codes)} AS bucket FROM agency_contacts c WHERE c.id = ${id}`, p.values);
    return rows[0]!.bucket;
  }

  async function retryOf(
    contactId: string,
    settings: { allowed?: boolean; rounds?: number; cooldown?: number } = {},
  ): Promise<{ blocked: string | null; available_at: Date | null }> {
    const p = params();
    const id = p.add(contactId);
    const allowed = p.add(settings.allowed ?? true);
    const rounds = p.add(settings.rounds ?? 1);
    const cooldown = p.add(settings.cooldown ?? 30);
    const codes = p.add(CALLBACK_CODES);
    const { rows } = await getTestPool().query<{ blocked: string | null; available_at: Date | null }>(
      `SELECT ${agentRetryBlockSql('c', { allowed, rounds, cooldownMinutes: cooldown, callbackCodes: codes })} AS blocked,
              ${agentRetryAvailableAtSql('c', cooldown)} AS available_at
         FROM agency_contacts c WHERE c.id = ${id}`, p.values);
    return rows[0]!;
  }

  async function contact(o: Record<string, unknown>) {
    const campaign = await insertAgencyCampaign();
    return insertAgencyContact(campaign.id as string, o) as Promise<{ id: string; campaign_id: string }>;
  }

  it('callbackCodes reads requires_datetime entries and survives a malformed catalog', () => {
    expect(callbackCodes([
      { code: 'callback', label: 'Callback', requires_datetime: true },
      { code: 'sale', label: 'Sale', is_success: true },
      { code: 'ptp', label: 'Promise To Pay', requires_datetime: true },
    ])).toEqual(['callback', 'ptp']);
    expect(callbackCodes(null)).toEqual([]);
    expect(callbackCodes([null as never, { code: 7 } as never])).toEqual([]);
  });

  it.each([
    [{ state: 'pending' }, 'pending'],
    [{ state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'interested' }, 'pending'],
    [{ state: 'pending', attempt_count: 1, last_outcome: 'no_answer' }, 'not_reached'],
    [{ state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'callback' }, 'callback'],
    [{ state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'promise_to_pay' }, 'callback'],
    // The callback was dialled and not answered: the disposition column still says callback
    // (it keeps its last value), the latest outcome does not. Not reached, like any other.
    [{ state: 'pending', attempt_count: 2, last_outcome: 'no_answer', last_disposition: 'callback' }, 'not_reached'],
    [{ state: 'in_flight' }, 'in_progress'],
    [{ state: 'connected', attempt_count: 1 }, 'in_progress'],
    [{ state: 'completed', attempt_count: 1 }, 'reached'],
    [{ state: 'exhausted', attempt_count: 3, last_outcome: 'no_answer' }, 'exhausted'],
    [{ state: 'suppressed', suppressed_reason: 'dnc' }, 'suppressed'],
    // A pre-fix leftover the claim refuses: pending, but DNC.
    [{ state: 'pending', suppressed_reason: 'dnc' }, 'suppressed'],
  ])('bucket of %o is %s', async (row, bucket) => {
    const c = await contact(row);
    expect(await bucketOf(c.id)).toBe(bucket);
  });

  it('an exhausted contact, or one not reached, is retryable once its cooldown has passed', async () => {
    const exhausted = await contact({ state: 'exhausted', attempt_count: 3, last_outcome: 'no_answer' });
    expect((await retryOf(exhausted.id)).blocked).toBeNull();
    const notReached = await contact({
      state: 'pending', attempt_count: 1, last_outcome: 'busy', next_attempt_at: new Date(Date.now() + 3_600_000),
    });
    expect((await retryOf(notReached.id)).blocked).toBeNull();
  });

  it('an unanswered callback scheduled for later is retryable like any not-reached contact', async () => {
    const c = await contact({
      state: 'pending', attempt_count: 2, last_outcome: 'no_answer', last_disposition: 'callback',
      next_attempt_at: new Date(Date.now() + 3_600_000),
    });
    expect((await retryOf(c.id)).blocked).toBeNull();
  });

  it('an open not-reached contact already due now is not retryable: it is in the queue as it is', async () => {
    const due = await contact({ state: 'pending', attempt_count: 1, last_outcome: 'busy', next_attempt_at: new Date(Date.now() - 1000) });
    expect((await retryOf(due.id)).blocked).toBe('not_retryable');
    expect(await bucketOf(due.id)).toBe('not_reached');
  });

  it('the campaign switch, suppression and not-reached come first', async () => {
    const exhausted = await contact({ state: 'exhausted', attempt_count: 3 });
    expect((await retryOf(exhausted.id, { allowed: false })).blocked).toBe('retry_disabled');
    const dnc = await contact({ state: 'suppressed', suppressed_reason: 'dnc', attempt_count: 1 });
    expect((await retryOf(dnc.id)).blocked).toBe('suppressed');
    const dncPending = await contact({ state: 'pending', suppressed_reason: 'dnc', attempt_count: 1, last_outcome: 'no_answer' });
    expect((await retryOf(dncPending.id)).blocked).toBe('suppressed');
    for (const row of [
      { state: 'pending' },
      { state: 'completed', attempt_count: 1 },
      { state: 'in_flight', attempt_count: 1 },
      { state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'interested' },
      // A callback booked on the last call waits for its time; it is not the agent's to retry.
      { state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'callback',
        next_attempt_at: new Date(Date.now() + 3_600_000) },
    ]) {
      const c = await contact(row);
      expect((await retryOf(c.id)).blocked, JSON.stringify(row)).toBe('not_retryable');
    }
  });

  it('rounds are bounded per contact', async () => {
    const c = await contact({ state: 'exhausted', attempt_count: 3, agent_retry_rounds_used: 1 });
    expect((await retryOf(c.id, { rounds: 1 })).blocked).toBe('rounds_used');
    expect((await retryOf(c.id, { rounds: 2 })).blocked).toBeNull();
  });

  it('the cooldown runs from the last attempt; a retry-delay override skips it', async () => {
    const c = await contact({ state: 'exhausted', attempt_count: 1, last_outcome: 'no_answer' });
    const at = new Date(Date.now() - 10 * 60_000);
    await insertAgencyAttempt(c.campaign_id, c.id, { state: 'ended', outcome: 'no_answer', created_at: at, ended_at: at });
    const blocked = await retryOf(c.id, { cooldown: 30 });
    expect(blocked.blocked).toBe('cooldown');
    expect(Math.abs(blocked.available_at!.getTime() - (at.getTime() + 30 * 60_000))).toBeLessThan(1000);
    expect((await retryOf(c.id, { cooldown: 5 })).blocked).toBeNull();
    await getTestPool().query('UPDATE agency_contacts SET override_retry_delay = true WHERE id = $1', [c.id]);
    expect((await retryOf(c.id, { cooldown: 30 })).blocked).toBeNull();
  });
});
