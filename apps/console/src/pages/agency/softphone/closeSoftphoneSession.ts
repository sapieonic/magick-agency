import { leaveAgencySession } from '../../../api/agency';
import { getSoftphoneBootstrap } from '../../../api/softphone';
import { errorBody, errorCode, errorStatus } from '../../../utils/agencyErrors';

/** What closing the agent's soft-phone session came to. */
export type SoftphoneCloseOutcome =
  /** Left, or already gone (`session_ended`, 404): what the close wanted. */
  | { kind: 'closed' }
  /** A call there is live or owes its outcome, so nothing was closed. */
  | { kind: 'call_pending' }
  /** No session was named and the bootstrap had none either. */
  | { kind: 'no_session' }
  /** `leave` refused for another reason; the soft phone is still open. */
  | { kind: 'failed'; message: string };

/**
 * Close the agent's soft-phone session so something else can open: the campaign
 * join's "Close the soft phone and join" (`useStationJoin`) and the soft phone's own
 * "Close it and open the soft phone here" (`SoftphonePage`) both run this, so the
 * two decide alike.
 *
 * ── Never closing over a call ────────────────────────────────────────────────
 * The server refuses `leave` while a soft-phone call is LIVE (409
 * `agent_on_live_call`), but not while an ended call waits for its outcome: that one
 * would lapse to "no outcome" with the session. So the soft phone's bootstrap is
 * read first, and a call there, live or owed, stops the close (`call_pending`). A
 * bootstrap that cannot be read (a network or server fault) does not block: the
 * server still guards the live call, and an owed outcome is the documented lapse.
 *
 * ── The session's own account ────────────────────────────────────────────────
 * One live session per agent per TENANT, so the session may be in a sibling account
 * of the one the console is in. The refusal that named it carries its `account_id`
 * (`sessionAccountId`); the bootstrap names the agent's live session tenant-wide with
 * its `account_id` too, but reads its call only in the account asked, and `leave` is
 * scoped to the session's account. Both are sent with the session's account, or the
 * call would go unseen and the leave would be a 404 taken for "already gone".
 * Without a `sessionAccountId` the console's own account is read first and the
 * bootstrap's `session.account_id` decides.
 */
export async function closeSoftphoneSession({
  tenantId,
  accountId,
  sessionId,
  sessionAccountId,
}: {
  tenantId: string;
  /** The account the console is in. */
  accountId: string;
  /** The session to close, from the refusal; null when it named none. */
  sessionId: string | null;
  /** That session's account, from the refusal; null when it named none. */
  sessionAccountId: string | null;
}): Promise<SoftphoneCloseOutcome> {
  let id = sessionId;
  let account = sessionAccountId ?? accountId;
  try {
    let phone = await getSoftphoneBootstrap(tenantId, account);
    const held = phone.session?.kind === 'softphone' && (!id || phone.session.session_id === id)
      ? phone.session
      : null;
    if (held) {
      id = held.session_id;
      if (held.account_id !== account) {
        account = held.account_id;
        phone = await getSoftphoneBootstrap(tenantId, account);
      }
    }
    if (phone.call) return { kind: 'call_pending' };
  } catch {
    // See above: unreadable is not a reason to keep the agent out.
  }
  if (!id) return { kind: 'no_session' };

  try {
    await leaveAgencySession(id, tenantId, account);
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === 'agent_on_live_call' || code === 'manual_call_live') return { kind: 'call_pending' };
    if (code !== 'session_ended' && errorStatus(err) !== 404) {
      const detail = errorBody(err)?.message ?? (err instanceof Error ? err.message : null);
      return {
        kind: 'failed',
        message: detail ? `Your soft phone is still open — ${detail}` : 'Your soft phone is still open. Try again.',
      };
    }
  }
  return { kind: 'closed' };
}
