import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession } = await import('./agency-factories.js');
const { startMyContactCall } = await import('../../../src/agency/my-contact-call.js');
const { DedicatedCallerIdCache } = await import('../../../src/agency/pacing/dedicated-caller-ids.js');

/**
 * ─── The agent's own dial when its attempt insert is refused, on real Postgres ──
 *
 * `startMyContactCall` (CA7) claims the contact (spending a retry round here) and then inserts
 * its attempt; a live attempt already on the contact makes `uq_agency_attempt_live` refuse the
 * insert. The answer is `409 contact_in_flight`, and the claim is undone exactly: the contact
 * goes back to `exhausted` with its round given back, not left `in_flight` for the
 * stranded-contact sweep to requeue as `pending` with the round lost.
 *
 * Mutation-checked: giving the claim back with `releaseAgentDialClaim` (its live-attempt guard
 * sees the other attempt) on the refused path reds it.
 */

const SETTINGS_COLUMNS = { allow_agent_retry: true, agent_retry_rounds: 1, agent_retry_cooldown_minutes: 30 };

describe('startMyContactCall — a refused attempt insert (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('answers contact_in_flight and gives the claim back: the prior state and the round', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ status: 'running', assignment_mode: 'strict', ...SETTINGS_COLUMNS });
    const contact = await insertAgencyContact(campaign.id, {
      state: 'exhausted', attempt_count: 3, last_outcome: 'no_answer',
      assigned_user_id: agent, assigned_at: new Date(),
    });
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await insertAgencyAttempt(campaign.id, contact.id, {
      attempt_number: 1, state: 'ended', outcome: 'no_answer', created_at: anHourAgo, ended_at: anHourAgo,
    });
    // An attempt left live on the contact by another path: the duplicate-dial backstop.
    await insertAgencyAttempt(campaign.id, contact.id, { attempt_number: 2, state: 'dialing', created_at: anHourAgo });
    const session = await insertAgentSession(campaign.id, { agent_user_id: agent });

    const transitions: string[] = [];
    const dispatch = vi.fn();
    const result = await startMyContactCall(
      {
        agents: {
          get: async () => ({ state: 'available' }),
          reserve: async () => 'reserved',
          transition: async (_id: string, from: string, to: string) => { transitions.push(`${from}->${to}`); return true; },
        } as never,
        breaks: { peek: () => null },
        stations: { ownerOf: async () => 'replica-1' },
        dnc: { check: async () => 'clear' } as never,
        dispatcher: { dispatch } as never,
        dialer: { releaseAgent: vi.fn() },
        callerIds: new DedicatedCallerIdCache(),
      },
      {
        tenantId: campaign.tenant_id, accountId: campaign.account_id, session,
        actorUserId: agent, campaignId: campaign.id, contactId: contact.id,
      },
    );

    expect(result).toMatchObject({ ok: false, status: 409, code: 'contact_in_flight' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(transitions).toEqual(['reserved->available']);
    const { rows } = await getTestPool().query(
      `SELECT state, agent_retry_rounds_used FROM agency_contacts WHERE id = $1`, [contact.id]);
    expect(rows[0]).toEqual({ state: 'exhausted', agent_retry_rounds_used: 0 });
  });
});
