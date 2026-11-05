import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `claimDialable` never puts two live calls on one number in one ACCOUNT.
 *
 * A campaign can hold one number on several contacts (one borrower, two loans), and an
 * account can run several campaigns whose rosters share a number (a retry child and its
 * parent; decisions MC6), so the claim skips a number that is already live (`in_flight` or
 * `connected`) on any campaign of the account (MC4) and takes at most one contact per
 * number per claim. `countDialable`, the pacing round's demand read, counts exactly what
 * the claim would take.
 */

const BORROWER = '+919876500001';

/** Contacts due in insertion order, a second apart, so the claim order is fixed. */
async function due(campaignId: string, phones: string[]) {
  const base = Date.now() - 600_000;
  const out = [];
  for (const [i, phone_e164] of phones.entries()) {
    out.push(await insertAgencyContact(campaignId, {
      phone_e164, source_row_number: i + 1, next_attempt_at: new Date(base + i * 1_000),
    }));
  }
  return out;
}

async function setState(id: string, state: string) {
  await getTestPool().query('UPDATE agency_contacts SET state = $2 WHERE id = $1', [id, state]);
}

describe('agencyContactRepository.claimDialable: one live call per number', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('two pending contacts on one number are never live at the same time', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [loan1, loan2] = await due(campaign.id, [BORROWER, BORROWER]);

    // One claim with room for both takes only the earlier one.
    const first = await agencyContactRepository.claimDialable(campaign.id, 5);
    expect(first.map((c) => c.id)).toEqual([loan1!.id]);

    // While that call is claimed, dialing, bridged or in wrap-up, the other waits.
    expect(await agencyContactRepository.claimDialable(campaign.id, 5)).toEqual([]);
    await setState(loan1!.id, 'connected');
    expect(await agencyContactRepository.claimDialable(campaign.id, 5)).toEqual([]);

    // Once it settles, the second loan is dialled.
    await setState(loan1!.id, 'completed');
    const second = await agencyContactRepository.claimDialable(campaign.id, 5);
    expect(second.map((c) => c.id)).toEqual([loan2!.id]);
  });

  it('skips a busy number and still claims the other contacts behind it', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [live, waiting, a, b] = await due(campaign.id, [BORROWER, BORROWER, '+919876500002', '+919876500003']);
    await setState(live!.id, 'in_flight');

    const claimed = await agencyContactRepository.claimDialable(campaign.id, 3);
    // Which contacts, not their order: `UPDATE … RETURNING` promises none, and the order follows
    // heap placement (seen to flip in a combined run once idx_agency_contacts_assignee served the busy probe).
    expect(claimed.map((c) => c.id).sort()).toEqual([a!.id, b!.id].sort());

    const { rows } = await getTestPool().query<{ state: string }>(
      'SELECT state FROM agency_contacts WHERE id = $1', [waiting!.id],
    );
    expect(rows[0]!.state).toBe('pending');
  });

  it('takes one contact per number from a run of repeats at the head of the queue', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [first, , , other] = await due(campaign.id, [BORROWER, BORROWER, BORROWER, '+919876500002']);

    const claimed = await agencyContactRepository.claimDialable(campaign.id, 2);
    expect(claimed.map((c) => c.id).sort()).toEqual([first!.id, other!.id].sort());
  });

  it('matches the number by its digits, whatever formatting the row stored', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [live, spaced] = await due(campaign.id, [BORROWER, '+91 98765 00001']);
    await setState(live!.id, 'in_flight');

    expect(await agencyContactRepository.claimDialable(campaign.id, 5)).toEqual([]);
    await setState(live!.id, 'completed');
    expect((await agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([spaced!.id]);
  });

  it.each(['in_flight', 'connected'] as const)(
    'a number %s on ANOTHER campaign of the same account is skipped (MC4), whatever its status',
    async (liveState) => {
      // Both running: several campaigns of one account may run (MC6). The sibling's status
      // does not matter to the probe; a paused campaign's call still in progress counts too.
      const campaign = await insertAgencyCampaign({ status: 'running' });
      const sibling = await insertAgencyCampaign({ status: 'running' });
      const paused = await insertAgencyCampaign({ status: 'paused' });
      const [onSibling] = await due(sibling.id, [BORROWER]);
      const [onPaused] = await due(paused.id, ['+919876500009']);
      await setState(onSibling!.id, liveState);
      await setState(onPaused!.id, liveState);
      const [mine, other, third] = await due(campaign.id, [BORROWER, '+919876500002', '+91 98765 00009']);

      // The two numbers live elsewhere on the account wait (the second by its digits);
      // the free one is claimed.
      expect((await agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([other!.id]);
      expect((await agencyContactRepository.claimDialable(campaign.id, 5))).toEqual([]);

      // Once the sibling's call settles, its number is free here too.
      await setState(onSibling!.id, 'completed');
      expect((await agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([mine!.id]);
      await setState(onPaused!.id, 'completed');
      expect((await agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([third!.id]);
    },
  );

  it('a live call on the same number in ANOTHER ACCOUNT does not block this one', async () => {
    const otherAccount = randomUUID();
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const foreign = await insertAgencyCampaign({ status: 'running', account_id: otherAccount });
    const elsewhere = await insertAgencyContact(foreign.id, {
      phone_e164: BORROWER, account_id: otherAccount, next_attempt_at: new Date(Date.now() - 600_000),
    });
    await setState(elsewhere.id, 'in_flight');
    const [mine] = await due(campaign.id, [BORROWER]);

    expect((await agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([mine!.id]);
  });

  it('the owner claim (claimForAgents) skips a number live on another campaign of the account too', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict' });
    const sibling = await insertAgencyCampaign({ status: 'running' });
    const [onSibling] = await due(sibling.id, [BORROWER]);
    await setState(onSibling!.id, 'connected');
    const mine = await insertAgencyContact(campaign.id, {
      phone_e164: BORROWER, assigned_user_id: agent, assigned_at: new Date(), next_attempt_at: new Date(Date.now() - 600_000),
    });

    expect(await agencyContactRepository.claimForAgents(campaign.id, [agent], 'strict')).toEqual([]);
    await setState(onSibling!.id, 'completed');
    const claimed = await agencyContactRepository.claimForAgents(campaign.id, [agent], 'strict');
    expect(claimed.map((c) => [c.agentUserId, c.contact.id])).toEqual([[agent, mine.id]]);
  });
});

describe('agencyContactRepository.countDialable: what claimDialable would claim now', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  /** Count, then claim with the same limit: the two must agree on a quiet table. */
  async function countThenClaim(campaignId: string, limit: number): Promise<{ counted: number; claimed: number }> {
    const counted = await agencyContactRepository.countDialable(campaignId, limit);
    const claimed = (await agencyContactRepository.claimDialable(campaignId, limit)).length;
    return { counted, claimed };
  }

  it('0 for a limit of 0 or less, and for an empty campaign', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    expect(await agencyContactRepository.countDialable(campaign.id, 0)).toBe(0);
    expect(await agencyContactRepository.countDialable(campaign.id, -3)).toBe(0);
    expect(await agencyContactRepository.countDialable(campaign.id, 5)).toBe(0);
    await due(campaign.id, ['+919876500002']);
    expect(await agencyContactRepository.countDialable(campaign.id, 0)).toBe(0);
  });

  it('one per number, bounded by the limit, and it writes nothing', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await due(campaign.id, [BORROWER, BORROWER, '+91 98765 00001', '+919876500002', '+919876500003', '+919876500004']);

    // Four numbers due (BORROWER three times, by its digits once).
    expect(await agencyContactRepository.countDialable(campaign.id, 10)).toBe(4);
    expect(await agencyContactRepository.countDialable(campaign.id, 2)).toBe(2);
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending'`, [campaign.id]);
    expect(rows[0]!.n).toBe(6);

    expect(await countThenClaim(campaign.id, 10)).toEqual({ counted: 4, claimed: 4 });
    // Every number is now live: nothing more to count or claim.
    expect(await countThenClaim(campaign.id, 10)).toEqual({ counted: 0, claimed: 0 });
  });

  it('reads the claim\'s window: a run of one number at the head counts once, as the claim takes it once', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    // limit 2 reads 2 × CLAIM_CANDIDATE_FACTOR (4) = 8 due rows, all on one number; two other
    // numbers are due behind them. A count over every due row would say 2; the claim takes 1.
    await due(campaign.id, [...Array<string>(8).fill(BORROWER), '+919876500002', '+919876500003']);
    expect(await countThenClaim(campaign.id, 2)).toEqual({ counted: 1, claimed: 1 });
    // That number is live now, so its rows drop out of the window and the next two come in.
    expect(await countThenClaim(campaign.id, 2)).toEqual({ counted: 2, claimed: 2 });
  });

  it('skips numbers live on the account (any campaign), not those live on another account; and not-due, DNC and other campaigns\' rows', async () => {
    const otherAccount = randomUUID();
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const sibling = await insertAgencyCampaign({ status: 'running' });
    const foreign = await insertAgencyCampaign({ status: 'running', account_id: otherAccount });
    const [onSibling] = await due(sibling.id, [BORROWER]);
    await setState(onSibling!.id, 'in_flight');
    const onForeign = await insertAgencyContact(foreign.id, { phone_e164: '+919876500002', account_id: otherAccount });
    await setState(onForeign.id, 'connected');
    await due(campaign.id, [BORROWER, '+919876500002', '+919876500003']);
    await insertAgencyContact(campaign.id, { phone_e164: '+919876500004', next_attempt_at: new Date(Date.now() + 3_600_000) });
    await insertAgencyContact(campaign.id, { phone_e164: '+919876500005', suppressed_reason: 'dnc' });

    // '+…02' (live only on another account) and '+…03'.
    expect(await countThenClaim(campaign.id, 10)).toEqual({ counted: 2, claimed: 2 });
    // The sibling's own roster counts on its own: its one row is live, so nothing.
    expect(await agencyContactRepository.countDialable(sibling.id, 10)).toBe(0);
  });
});
