import type { AgencyInboundStickyReason } from '@magick-agency/contracts/agency';
import {
  agencyInboundAnswerRepository,
  type InboundCallSignalRow,
  type InboundContactCandidateRow,
} from '../../db/repositories/agency.repository.js';

/**
 * ─── WHO IS CALLING (docs/inbound.md §4.1, decision IB2) ──────────────────────────────────
 *
 * The caller's number against the tenant's rosters and calls: which roster contact they are
 * (the "match", which decides the call's account and campaign context) and which agents they
 * belong with, ranked, each with the signal that names them. One reusable function: the P1
 * answer webhook uses the match and the first candidate (the Missed row's assignee); P2's sticky
 * routing walks the candidates against agents' live state (§4.3).
 *
 * The read is tenant-wide, actor-less and unaudited, over the customer-history indexes
 * (`AgencyInboundAnswerRepository`), never the customer-history route (CH2, CH6, CH10, CH11).
 *
 * ── The match ────────────────────────────────────────────────────────────────────
 * Candidates: the number's roster rows whose account may use the number rung (the caller-ID tag
 * rule: a number tagged to other accounts is not this contact's line), that are still RELEVANT:
 * on a `running` or `paused` campaign (live business, whatever its age), or called inside the
 * lookback. Ranked: a contact whose latest call went out from the number rung first (§4.1: "prefer
 * the contact whose latest outbound call used the number rung"), then the most recent (its latest
 * call, else when it joined the roster), then the id, so the ranking is total.
 *
 * ── The agents (signals 1–3; signal 4, the last dialled unanswered, is off: IB2) ──────────
 *  1. `owner`: the matched contact's owner (`assigned_user_id`);
 *  2. `last_from_number`: the agent of the latest call to the number inside the lookback that
 *     went out FROM the number rung (an attempt's `caller_id`, a soft-phone call's);
 *  3. `last_connected`: the agent of the latest connected call inside the lookback, in EITHER
 *     direction (IQ49): an outbound call put through, or an inbound call of theirs an agent
 *     answered (`answered_by_user_id`). An inbound call never names `last_from_number` (it went out
 *     from nobody's number: its `caller_id` is null). The copy ("Your customer: you last spoke to
 *     them") reads the same either way, so no wire value was added.
 * One entry per agent, at their best rank. A campaign may opt out (`inbound_sticky_enabled`
 * false): its owner and its calls name no one. Only agents active in the tenant are read (the
 * repository's filter); the dedicated caller ID is deliberately not a signal (DN3).
 */

/** The roster contact the caller is, with what the call's follow-up needs. */
export interface InboundCallerMatch {
  contactId: string;
  campaignId: string;
  accountId: string;
  contactState: InboundContactCandidateRow['contact_state'];
  campaignStatus: InboundContactCandidateRow['campaign_status'];
  suppressedReason: string | null;
  assignedUserId: string | null;
}

/** One agent the caller belongs with, and why. */
export interface InboundStickyCandidate {
  userId: string;
  reason: AgencyInboundStickyReason;
  /** The account of the contact or call that named them. */
  accountId: string;
  /** When the naming call was placed (the owner: null). */
  at: Date | null;
}

export interface InboundCallerIdentity {
  match: InboundCallerMatch | null;
  /** Ranked: the first is the sticky agent. */
  candidates: InboundStickyCandidate[];
}

const RANK: Record<AgencyInboundStickyReason, number> = {
  owner: 1,
  last_from_number: 2,
  last_connected: 3,
  last_dialled: 4,
};

/** A contact's latest activity: its latest attempt, else when it joined the roster. */
const lastActivity = (c: InboundContactCandidateRow): number =>
  (c.last_attempt_at ?? c.contact_created_at).getTime();

/**
 * The identification over the repository's rows (see the header). Pure: `now` and the lookback
 * fix "inside the lookback".
 */
export function rankInboundCaller(input: {
  contacts: readonly InboundContactCandidateRow[];
  calls: readonly InboundCallSignalRow[];
  numberRungE164: string;
  since: Date;
}): InboundCallerIdentity {
  const since = input.since.getTime();
  const relevant = input.contacts.filter((c) => c.account_may_use
    && (c.campaign_status === 'running' || c.campaign_status === 'paused'
      || (c.last_attempt_at !== null && c.last_attempt_at.getTime() >= since)));
  const fromRung = (c: InboundContactCandidateRow) => (c.last_attempt_caller_id === input.numberRungE164 ? 1 : 0);
  const ranked = [...relevant].sort((a, b) =>
    fromRung(b) - fromRung(a)
    || lastActivity(b) - lastActivity(a)
    || (a.contact_id < b.contact_id ? -1 : a.contact_id > b.contact_id ? 1 : 0));
  const best = ranked[0] ?? null;
  const match: InboundCallerMatch | null = best
    ? {
      contactId: best.contact_id,
      campaignId: best.campaign_id,
      accountId: best.account_id,
      contactState: best.contact_state,
      campaignStatus: best.campaign_status,
      suppressedReason: best.suppressed_reason,
      assignedUserId: best.assigned_user_id,
    }
    : null;

  const byUser = new Map<string, InboundStickyCandidate>();
  const offer = (c: InboundStickyCandidate): void => {
    const held = byUser.get(c.userId);
    if (!held || RANK[c.reason] < RANK[held.reason]) byUser.set(c.userId, c);
  };
  if (best?.assigned_user_id && best.inbound_sticky_enabled) {
    offer({ userId: best.assigned_user_id, reason: 'owner', accountId: best.account_id, at: null });
  }
  const calls = input.calls
    .filter((c) => c.sticky_enabled && c.at.getTime() >= since)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.call_id < b.call_id ? 1 : a.call_id > b.call_id ? -1 : 0));
  const fromNumber = calls.find((c) => c.caller_id === input.numberRungE164);
  if (fromNumber) offer({ userId: fromNumber.agent_user_id, reason: 'last_from_number', accountId: fromNumber.account_id, at: fromNumber.at });
  const connected = calls.find((c) => c.connected);
  if (connected) offer({ userId: connected.agent_user_id, reason: 'last_connected', accountId: connected.account_id, at: connected.at });

  const candidates = [...byUser.values()].sort((a, b) => RANK[a.reason] - RANK[b.reason]);
  return { match, candidates };
}

/**
 * Identify the caller `fromE164` ringing `numberRungE164` (`phoneNumberId`) in `tenantId`,
 * looking back `lookbackDays` from `at`. A withheld caller (null) is nobody, with no read.
 */
export async function identifyInboundCaller(input: {
  tenantId: string;
  fromE164: string | null;
  numberRungE164: string;
  phoneNumberId: string;
  lookbackDays: number;
  at: Date;
}): Promise<InboundCallerIdentity> {
  if (!input.fromE164) return { match: null, candidates: [] };
  const since = new Date(input.at.getTime() - input.lookbackDays * 86_400_000);
  const [contacts, calls] = await Promise.all([
    agencyInboundAnswerRepository.findContactCandidates({
      tenantId: input.tenantId, fromE164: input.fromE164, phoneNumberId: input.phoneNumberId,
    }),
    agencyInboundAnswerRepository.findCallSignals({ tenantId: input.tenantId, fromE164: input.fromE164, since }),
  ]);
  return rankInboundCaller({ contacts, calls, numberRungE164: input.numberRungE164, since });
}
