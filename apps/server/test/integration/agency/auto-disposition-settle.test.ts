import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession, dialCommandFor } = await import('./agency-factories.js');
const { agencyAttemptRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { settleContact, holdOutcomeUnknownContact } = await import('../../../src/agency/dialer/contact-settlement.js');
type AgencyAttemptOutcome = import('@magick-agency/contracts/agency').AgencyAttemptOutcome;

/**
 * ─── Automatic outcomes for unanswered calls, stamped on settle (OD1–OD8), real Postgres ──
 *
 * The dialer's `settleContact` (the charged `else` branch) stamps the campaign's mapped code
 * on the ended attempt as `auto_disposition_code`, through
 * `agencyAttemptRepository.stampAutoDisposition`'s guarded UPDATE.
 *
 * What this pins:
 *  - a mapped outcome stamps its code, and `disposition_code` stays NULL (OD4: a person's
 *    write-up and the campaign's label are different columns);
 *  - a LABEL ONLY (OD1): the contact's routing (state, next_attempt_at, attempt_count,
 *    last_outcome, last_disposition, our_fault_attempts, suppressed_reason) is identical to
 *    an identical campaign with `{}`, on the requeue path and on the exhaustion path; the
 *    clock is fixed (`Date` only) so `next_attempt_at` compares exactly;
 *  - every mappable outcome on its own retry path: `busy`, `no_answer` (requeue and
 *    exhaustion), `invalid` (suppressed whatever the policy), `abandoned`;
 *  - a failed stamp is logged and the contact is still routed exactly as with `{}`;
 *  - nothing is stamped for: an unmapped outcome, a `connected` call owed a write-up, a wrap-up
 *    redial, an our-fault `canceled` before the bridge, the outcome-unknown hold, a mapped
 *    code that has since left the catalog (or now suppresses), written around the API;
 *  - a replayed settle with a since-edited map does not restamp (OD5);
 *  - `stampAutoDisposition` refuses a live attempt and a different outcome.
 */

const NOW = new Date('2026-11-09T10:00:00.000Z');

const CATALOG = [
  { code: 'retry_later', label: 'Retry later' },
  { code: 'callback', label: 'Callback' },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
];
const MAP = { busy: 'retry_later', no_answer: 'callback' };
const POLICY = {
  busy: { delay_minutes: 15, max_attempts: 3 },
  no_answer: { delay_minutes: 30, max_attempts: 3 },
  failed: { delay_minutes: 10, max_attempts: 3 },
};

type ContactRouting = {
  state: string; next_attempt_at: Date; attempt_count: number; last_outcome: string | null;
  last_disposition: string | null; our_fault_attempts: number; suppressed_reason: string | null;
};
async function routing(contactId: string): Promise<ContactRouting> {
  const { rows } = await getTestPool().query<ContactRouting>(
    `SELECT state, next_attempt_at, attempt_count, last_outcome, last_disposition, our_fault_attempts, suppressed_reason
       FROM agency_contacts WHERE id = $1`, [contactId]);
  return rows[0]!;
}

type AttemptLabels = { auto_disposition_code: string | null; disposition_code: string | null; outcome: string | null; state: string };
async function labels(attemptId: string): Promise<AttemptLabels> {
  const { rows } = await getTestPool().query<AttemptLabels>(
    'SELECT auto_disposition_code, disposition_code, outcome, state FROM agency_call_attempts WHERE id = $1', [attemptId]);
  return rows[0]!;
}

interface Dial {
  campaignId: string; contactId: string; attemptId: string; sessionId: string; attemptNumber: number;
}

/**
 * A running campaign with `map` and `catalog`, one contact claimed (`in_flight`) with
 * `priorAttempts` charged, and its attempt `attemptNumber` ENDED with `outcome`.
 */
async function endedDial(o: {
  map: Record<string, string>; outcome: AgencyAttemptOutcome; catalog?: unknown[];
  priorAttempts?: number; bridged?: boolean; phone?: string;
}): Promise<Dial> {
  const campaign = await insertAgencyCampaign({
    status: 'running', started_at: NOW,
    disposition_catalog: JSON.stringify(o.catalog ?? CATALOG),
    outcome_dispositions: JSON.stringify(o.map),
    retry_policy: JSON.stringify(POLICY),
  });
  const prior = o.priorAttempts ?? 0;
  const contact = await insertAgencyContact(campaign.id as string, {
    // A fixed `next_attempt_at`, not the column's DB-side `now()`: an exhausted contact keeps
    // it, so two rows compare equal only if they started equal.
    state: 'in_flight', attempt_count: prior, next_attempt_at: NOW, ...(o.phone ? { phone_e164: o.phone } : {}),
  });
  const session = await insertAgentSession(campaign.id as string, { agent_user_id: randomUUID(), state: 'reserved' });
  const n = prior + 1;
  const attempt = await insertAgencyAttempt(campaign.id as string, contact.id as string, {
    attempt_number: n, state: 'ended', outcome: o.outcome, reserved_agent_id: session.id,
    ended_at: NOW, ...(o.bridged ? { bridged_at: NOW } : {}),
  });
  return {
    campaignId: campaign.id as string, contactId: contact.id as string, attemptId: attempt.id as string,
    sessionId: session.id as string, attemptNumber: n,
  };
}

/** The dial command the dialer settles with, built from the rows as they stand now. */
function commandFor(d: Dial, extra: Record<string, unknown> = {}) {
  return dialCommandFor(d, extra);
}

async function settle(d: Dial, outcome: AgencyAttemptOutcome, o: {
  needsDisposition?: boolean; bridgedAt?: Date | null; extra?: Record<string, unknown>;
} = {}): Promise<void> {
  await settleContact(await commandFor(d, o.extra), outcome, o.needsDisposition ?? false, o.bridgedAt ?? null);
}

describe('settleContact — the automatic outcome of an unanswered call', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await truncateAll();
  });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(closeTestPool);

  it('a busy end stamps the mapped code on the attempt and leaves disposition_code NULL', async () => {
    const d = await endedDial({ map: MAP, outcome: 'busy' });
    await settle(d, 'busy');
    expect(await labels(d.attemptId)).toEqual({
      auto_disposition_code: 'retry_later', disposition_code: null, outcome: 'busy', state: 'ended',
    });
  });

  it('a no_answer end stamps its own mapped code', async () => {
    const d = await endedDial({ map: MAP, outcome: 'no_answer' });
    await settle(d, 'no_answer');
    expect((await labels(d.attemptId)).auto_disposition_code).toBe('callback');
  });

  for (const outcome of ['busy', 'no_answer'] as const) {
    it(`a label only: a mapped ${outcome} routes the contact exactly as the same campaign with {} does (requeue)`, async () => {
      const mapped = await endedDial({ map: MAP, outcome, phone: '+919000000201' });
      const plain = await endedDial({ map: {}, outcome, phone: '+919000000202' });
      await settle(mapped, outcome);
      await settle(plain, outcome);

      const a = await routing(mapped.contactId);
      const b = await routing(plain.contactId);
      expect(a).toEqual(b);
      // And it is the retry policy's answer, not the mapped entry's: pending, delayed by the rule.
      const delay = POLICY[outcome].delay_minutes;
      expect(a).toMatchObject({ state: 'pending', attempt_count: 1, last_outcome: outcome, last_disposition: null });
      expect(a.next_attempt_at.getTime()).toBe(NOW.getTime() + delay * 60_000);
      expect((await labels(mapped.attemptId)).auto_disposition_code).not.toBeNull();
      expect((await labels(plain.attemptId)).auto_disposition_code).toBeNull();
    });
  }

  it('a label only: the last allowed busy exhausts the contact exactly as with {}', async () => {
    const mapped = await endedDial({ map: MAP, outcome: 'busy', priorAttempts: 2, phone: '+919000000211' });
    const plain = await endedDial({ map: {}, outcome: 'busy', priorAttempts: 2, phone: '+919000000212' });
    await settle(mapped, 'busy');
    await settle(plain, 'busy');
    const a = await routing(mapped.contactId);
    expect(a).toEqual(await routing(plain.contactId));
    expect(a).toMatchObject({ state: 'exhausted', attempt_count: 3, last_outcome: 'busy' });
    expect((await labels(mapped.attemptId)).auto_disposition_code).toBe('retry_later');
  });

  // The other two mappable outcomes, each on its own path through the retry engine: `invalid`
  // is suppressed whatever the policy says, `abandoned` (answered, no agent) is charged to the
  // customer's allowance with its own rule. The label rides on both; routing is unchanged.
  for (const [outcome, expectedState] of [['invalid', 'suppressed'], ['abandoned', 'pending']] as const) {
    it(`a mapped ${outcome} is stamped, and routes the contact exactly as with {} (${expectedState})`, async () => {
      const map = { [outcome]: 'retry_later' };
      const mapped = await endedDial({ map, outcome, phone: '+919000000231' });
      const plain = await endedDial({ map: {}, outcome, phone: '+919000000232' });
      await settle(mapped, outcome);
      await settle(plain, outcome);
      expect(await labels(mapped.attemptId)).toMatchObject({ auto_disposition_code: 'retry_later', disposition_code: null });
      expect((await labels(plain.attemptId)).auto_disposition_code).toBeNull();
      const a = await routing(mapped.contactId);
      expect(a).toEqual(await routing(plain.contactId));
      expect(a.state).toBe(expectedState);
    });
  }

  it('a failed stamp never holds up the contact: it is routed exactly as with {} (OD5)', async () => {
    const spy = vi.spyOn(agencyAttemptRepository, 'stampAutoDisposition').mockRejectedValueOnce(new Error('db down'));
    try {
      const mapped = await endedDial({ map: MAP, outcome: 'busy', phone: '+919000000241' });
      const plain = await endedDial({ map: {}, outcome: 'busy', phone: '+919000000242' });
      await expect(settle(mapped, 'busy')).resolves.toBeUndefined();
      await settle(plain, 'busy');
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await labels(mapped.attemptId)).auto_disposition_code).toBeNull();
      const a = await routing(mapped.contactId);
      expect(a).toEqual(await routing(plain.contactId));
      expect(a).toMatchObject({ state: 'pending', attempt_count: 1, last_outcome: 'busy' });
    } finally {
      spy.mockRestore();
    }
  });

  it('an unmapped outcome (failed) stamps nothing', async () => {
    const d = await endedDial({ map: MAP, outcome: 'failed' });
    await settle(d, 'failed');
    expect((await labels(d.attemptId)).auto_disposition_code).toBeNull();
    expect((await routing(d.contactId)).state).toBe('pending');
  });

  it('a connected call owed a write-up stamps nothing, even when connected is (illegally) in the stored map', async () => {
    const d = await endedDial({ map: { ...MAP, connected: 'callback' }, outcome: 'connected', bridged: true });
    await settle(d, 'connected', { needsDisposition: true, bridgedAt: NOW });
    expect(await labels(d.attemptId)).toMatchObject({ auto_disposition_code: null, disposition_code: null });
    expect((await routing(d.contactId)).state).toBe('connected');
  });

  it('a wrap-up redial that ends busy stamps nothing: the conversation\'s write-up is still owed', async () => {
    const d = await endedDial({ map: MAP, outcome: 'busy' });
    await settle(d, 'busy', { needsDisposition: true, extra: { redial: { ofAttemptId: randomUUID(), number: 1 } } });
    expect((await labels(d.attemptId)).auto_disposition_code).toBeNull();
    expect((await routing(d.contactId)).state).toBe('connected');
  });

  it('an our-fault canceled before the bridge stamps nothing, even when canceled is (illegally) in the stored map', async () => {
    const d = await endedDial({ map: { ...MAP, canceled: 'retry_later' }, outcome: 'canceled' });
    await settle(d, 'canceled');
    expect((await labels(d.attemptId)).auto_disposition_code).toBeNull();
    // The our-fault ledger, not the customer's allowance.
    expect(await routing(d.contactId)).toMatchObject({ attempt_count: 0, our_fault_attempts: 1 });
  });

  // The dialer sends an outcome-unknown dial to `holdOutcomeUnknownContact` INSTEAD of
  // `settleContact` (`agency-dialer.ts`, `settleContactAfterDial`); this pins only that the
  // hold itself files no label, not the dialer's choice between the two.
  it('the outcome-unknown hold (holdOutcomeUnknownContact) files no automatic outcome', async () => {
    const d = await endedDial({ map: { ...MAP, failed: 'retry_later' }, outcome: 'failed' });
    await holdOutcomeUnknownContact(await commandFor(d), 'failed');
    expect((await labels(d.attemptId)).auto_disposition_code).toBeNull();
  });

  it('a mapped code that has since left the catalog (written around the API) stamps nothing, and routes the same', async () => {
    const d = await endedDial({ map: MAP, outcome: 'busy', phone: '+919000000221' });
    await getTestPool().query(
      'UPDATE agency_campaigns SET disposition_catalog = $2::jsonb WHERE id = $1',
      [d.campaignId, JSON.stringify([{ code: 'callback', label: 'Callback' }])],
    );
    const plain = await endedDial({ map: {}, outcome: 'busy', phone: '+919000000222' });
    await settle(d, 'busy');
    await settle(plain, 'busy');
    expect((await labels(d.attemptId)).auto_disposition_code).toBeNull();
    expect(await routing(d.contactId)).toEqual(await routing(plain.contactId));
  });

  it('a mapped code that now suppresses (written around the API) stamps nothing', async () => {
    const d = await endedDial({
      map: { busy: 'retry_later' }, outcome: 'busy',
      catalog: [{ code: 'retry_later', label: 'Retry later', suppress: true }],
    });
    await settle(d, 'busy');
    expect((await labels(d.attemptId)).auto_disposition_code).toBeNull();
    expect((await routing(d.contactId)).state).toBe('pending');
  });

  it('a replayed settle with a since-edited map keeps the first stamp (OD5)', async () => {
    const d = await endedDial({ map: MAP, outcome: 'busy' });
    await settle(d, 'busy');
    expect((await labels(d.attemptId)).auto_disposition_code).toBe('retry_later');

    await getTestPool().query(
      `UPDATE agency_campaigns SET outcome_dispositions = '{"busy":"callback"}'::jsonb WHERE id = $1`, [d.campaignId]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [d.contactId]);
    await settle(d, 'busy');
    expect((await labels(d.attemptId)).auto_disposition_code).toBe('retry_later');
  });
});

describe('agencyAttemptRepository.stampAutoDisposition — the guarded UPDATE', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('stamps an ended attempt with that outcome once, and never touches disposition_code', async () => {
    const d = await endedDial({ map: {}, outcome: 'busy' });
    expect(await agencyAttemptRepository.stampAutoDisposition(d.attemptId, 'busy', 'retry_later')).toBe(true);
    expect(await agencyAttemptRepository.stampAutoDisposition(d.attemptId, 'busy', 'callback')).toBe(false);
    expect(await labels(d.attemptId)).toMatchObject({ auto_disposition_code: 'retry_later', disposition_code: null });
  });

  it('returns false for a different outcome than the attempt ended with', async () => {
    const d = await endedDial({ map: {}, outcome: 'no_answer' });
    expect(await agencyAttemptRepository.stampAutoDisposition(d.attemptId, 'busy', 'retry_later')).toBe(false);
    expect((await labels(d.attemptId)).auto_disposition_code).toBeNull();
  });

  it('returns false for a live attempt (not ended)', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', started_at: new Date() });
    const contact = await insertAgencyContact(campaign.id as string, { state: 'in_flight' });
    const live = await insertAgencyAttempt(campaign.id as string, contact.id as string, { state: 'ringing', outcome: null });
    expect(await agencyAttemptRepository.stampAutoDisposition(live.id as string, 'busy', 'retry_later')).toBe(false);
    expect((await labels(live.id as string)).auto_disposition_code).toBeNull();
  });

  it('returns false for an unknown attempt id', async () => {
    expect(await agencyAttemptRepository.stampAutoDisposition(randomUUID(), 'busy', 'retry_later')).toBe(false);
  });
});
