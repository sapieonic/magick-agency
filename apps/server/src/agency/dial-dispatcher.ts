import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../db/models/agency.model.js';
import { rejectClearance, type PreDialClearance } from './pre-dial-gates.js';

const log = createChildLogger({ component: 'agency-dial-dispatcher' });

/**
 * Everything the owning replica needs to place one dial. Deliberately a value,
 * not a set of ids to re-read: when this crosses a process boundary in v2 it
 * becomes a pub/sub payload, and a payload that requires the receiver to re-query
 * is a payload that can be acted on against a changed row.
 */
export interface DialCommand {
  attemptId: string;
  campaignId: string;
  contactId: string;
  /** The agent session reserved for this dial, and its owning replica. */
  sessionId: string;
  ownerReplica: string;
  tenantId: string;
  accountId: string;
  callerId: string;
  attemptNumber: number;
  campaign: AgencyCampaignRecord;
  contact: AgencyContactRecord;
}

/**
 * A dial command that has been through the pre-dial compliance gates.
 *
 * **The reason this type exists rather than a comment saying "check DNC first".**
 * The gates run in the pacing tick, which means a future dial path that does
 * not come through `dialUpTo` would place calls no gate ever saw — the exact
 * failure the DNC gate exists to prevent, arriving through a door nobody guarded.
 * `dispatch` therefore takes this type instead of a bare `DialCommand`, and
 * {@link PreDialClearance} is branded with a symbol only `pre-dial-gates.ts` can
 * produce, so the omission is a compile error.
 *
 * Deliberately a SUBTYPE rather than a field on `DialCommand`: `executeDial` and
 * every test that drives the dialer directly keep taking the plain command, so the
 * guard costs one call site instead of nine files. The choke point is dispatch,
 * which is where the design already routes every dial.
 */
export interface ClearedDialCommand extends DialCommand {
  clearance: PreDialClearance;
}

/**
 * Routes a dial to the replica that owns the agent's station socket.
 *
 * The seam exists because the bridge session, the agent's socket and the carrier
 * socket must end up in one process — the invariant the existing bridge already
 * assumes and which today's browser dialer only satisfies by coincidence (the
 * browser both initiates the call and then connects its socket, so a sticky HTTP
 * session mostly holds). The agency dialer breaks that coincidence: the socket is
 * opened first and the dial is initiated later by a pacing loop on an arbitrary
 * replica.
 *
 * The server runs as a single replica, so there is exactly one implementation in
 * v1 — {@link LocalDialDispatcher}, a direct in-process call. Going multi-replica means writing a
 * `PubSubDialDispatcher` against this interface and threading an advertised host
 * into the bridge's webhook URLs; it does not mean touching the dial path.
 */
export interface DialDispatcher {
  dispatch(cmd: ClearedDialCommand): Promise<void>;
}

/**
 * Single-replica implementation: the owner is always us, so dispatch is a call.
 *
 * It still *checks* ownership rather than assuming it. With one replica that check can
 * only fail if the agent's socket died between reservation and dial — which is
 * precisely the case that must not become a dial, because there would be no one
 * to bridge the answer to.
 */
export class LocalDialDispatcher implements DialDispatcher {
  constructor(
    private readonly replicaId: string,
    private readonly execute: (cmd: DialCommand) => Promise<void>,
  ) {}

  async dispatch(cmd: ClearedDialCommand): Promise<void> {
    // Checked before ownership, because a call placed without a DNC check is worse
    // than one placed on the wrong replica: the second is an abandoned call, the
    // first is a regulatory event.
    //
    // The brand already makes a forged clearance a compile error, so this covers
    // the two things a type cannot see — an `as` cast, and a token issued for a
    // DIFFERENT contact. The second is the realistic one: `dialUpTo` pairs
    // `reserved[index]` with `contacts[index]`, so an indexing mistake there hands
    // a valid clearance to a contact nobody checked, with every type satisfied.
    const rejection = rejectClearance(cmd.clearance, cmd.contactId, new Date());
    if (rejection) {
      log.error(
        { attemptId: cmd.attemptId, contactId: cmd.contactId, rejection },
        'Dial command without a valid pre-dial clearance — refusing',
      );
      throw new Error(`Dial without pre-dial clearance (${rejection}) for contact ${cmd.contactId}`);
    }

    if (cmd.ownerReplica !== this.replicaId) {
      // Unreachable while the server is single-replica, and deliberately loud rather
      // than silently dialing anyway — if this ever fires, the ownership model
      // has drifted and dialing would produce abandoned calls.
      log.error(
        { attemptId: cmd.attemptId, owner: cmd.ownerReplica, self: this.replicaId },
        'Dial command for an agent owned by another replica — refusing',
      );
      throw new Error(`Dial for non-owned agent session ${cmd.sessionId}`);
    }
    await this.execute(cmd);
  }
}
