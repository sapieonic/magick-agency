import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `claimDialable` never puts two live calls on one number in one campaign.
 *
 * A campaign can hold one number on several contacts (one borrower, two loans), so
 * the claim skips a number that is already live (`in_flight` or `connected`) and
 * takes at most one contact per number per claim.
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
    expect(claimed.map((c) => c.id)).toEqual([a!.id, b!.id]);

    const { rows } = await getTestPool().query<{ state: string }>(
      'SELECT state FROM agency_contacts WHERE id = $1', [waiting!.id],
    );
    expect(rows[0]!.state).toBe('pending');
  });

  it('takes one contact per number from a run of repeats at the head of the queue', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [first, , , other] = await due(campaign.id, [BORROWER, BORROWER, BORROWER, '+919876500002']);

    const claimed = await agencyContactRepository.claimDialable(campaign.id, 2);
    expect(claimed.map((c) => c.id)).toEqual([first!.id, other!.id]);
  });

  it('matches the number by its digits, whatever formatting the row stored', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [live, spaced] = await due(campaign.id, [BORROWER, '+91 98765 00001']);
    await setState(live!.id, 'in_flight');

    expect(await agencyContactRepository.claimDialable(campaign.id, 5)).toEqual([]);
    await setState(live!.id, 'completed');
    expect((await agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([spaced!.id]);
  });

  it('a live call on the same number in ANOTHER campaign does not block this one', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const other = await insertAgencyCampaign({ status: 'paused' });
    const [elsewhere] = await due(other.id, [BORROWER]);
    await setState(elsewhere!.id, 'in_flight');
    const [mine] = await due(campaign.id, [BORROWER]);

    expect((await agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([mine!.id]);
  });
});
