/**
 * The uncharged return of a contact whose ringing dial its customer superseded by ringing in
 * (docs/inbound.md §5.4, IQ8), as ONE statement run on the caller's queryable. Two repository
 * files run it: {@link AgencyContactRepository.unclaimUncharged} on its own, and
 * `AgencyAttemptRepository.endSupersededByInbound` inside the transaction that ends the attempt.
 * It lives here, not on the contact repository, so the attempt repository reaches it without
 * importing a sibling repository file: callers and `vi.mock` go through the barrel
 * (`agency.repository.ts`, apps/server/CLAUDE.md), and a direct `./contact.repository.js` import
 * would sidestep that seam. A leaf: it imports nothing from this folder.
 */
import type { PoolClient } from 'pg';
import type { AgencyContactState } from '@magick-agency/contracts/agency';

/** The contact as returned to the pool. */
export interface UnclaimedContact {
  contactId: string;
  state: AgencyContactState;
  nextAttemptAt: Date | null;
}

/**
 * `in_flight` → `pending`, due now, UNCHARGED: neither `attempt_count` nor the our-fault ledger
 * moves, and `last_outcome` is left as it was. `restoreAgentReopen`: the cancelled dial had
 * consumed an agent-retry reopen (`agent_reopen_pending`), which goes back.
 *
 * @returns the contact as returned, or null when it is not `in_flight` (already settled by
 *   another path) or gone.
 */
export async function unclaimContactUncharged(
  client: Pick<PoolClient, 'query'>,
  contactId: string,
  restoreAgentReopen: boolean,
): Promise<UnclaimedContact | null> {
  const { rows } = await client.query<{ id: string; state: AgencyContactState; next_attempt_at: Date | null }>(
    `UPDATE agency_contacts
        SET state = 'pending', next_attempt_at = now(),
            agent_reopen_pending = agent_reopen_pending OR $2::boolean,
            updated_at = now()
      WHERE id = $1::uuid AND state = 'in_flight'
      RETURNING id, state, next_attempt_at`,
    [contactId, restoreAgentReopen],
  );
  const row = rows[0];
  return row ? { contactId: row.id, state: row.state, nextAttemptAt: row.next_attempt_at } : null;
}
