import {
  AWAY_RING_BREAK_REASON,
  AWAY_RING_BREAK_REASON_LABEL,
  DEVICE_AWAY_BREAK_REASON,
  DEVICE_AWAY_BREAK_REASON_LABEL,
  PHONE_CALL_BREAK_REASON,
  PHONE_CALL_BREAK_REASON_LABEL,
  RESERVED_BREAK_REASONS,
  isAgencyBreakLimitMinutes,
  isAgencyTileIcon,
  type AgencyBreakReason,
} from '@magick-agency/contracts/agency';

/**
 * Break / not-ready with reason codes.
 *
 * Two responsibilities, both small and both about not stranding an agent:
 * resolving which reason codes a campaign actually accepts, and remembering a
 * break an agent asked for while they were still on a call.
 *
 * **A queued break is in-process, deliberately.** It is not a Redis key and not a
 * DB column, because it does not need to survive this process: after a restart
 * every agent lands in `break` anyway, so a pending break that is lost to a
 * crash resolves to the state the agent asked for. Persisting it would add a write
 * to the call-teardown path to achieve nothing the restart rule does not.
 */

/**
 * Neutral built-in reasons, served when a campaign configures none.
 *
 * `'[]'` on the column means "the operator has no opinion" — NOT "breaks are
 * disabled". A break menu with no entries is a control the agent cannot use, and
 * a campaign that never configured breaks has an empty column.
 *
 * Deliberately generic: the mechanism ships operator-configured with neutral
 * defaults, so there are no jurisdiction-specific codes, no prescribed labels and
 * nothing that reads as a compliance claim. `is_paid` is omitted rather than
 * guessed — that is a payroll question no default can answer for an operator.
 *
 * **Limits (LF6, LF20).** Tea has 15 minutes and Lunch 30 (`limit_minutes`); the others none, so
 * the floor's 30-minute rule applies to them. Tea is its own code, added after Break, never a
 * relabelled `break`: a session on `break` today stays on what it chose. These reach exactly the
 * campaigns that list no reasons of their own (an empty column), because the built-ins are
 * served at read time, never written: a campaign's saved list is never rewritten, by a migration
 * or by this read, and keeps the limits its operator gave it (none, until they add some).
 */
export const DEFAULT_BREAK_REASONS: readonly AgencyBreakReason[] = [
  { code: 'break', label: 'Break' },
  { code: 'tea', label: 'Tea', limit_minutes: 15 },
  { code: 'lunch', label: 'Lunch', limit_minutes: 30 },
  { code: 'meeting', label: 'Meeting' },
  { code: 'training', label: 'Training' },
  { code: 'technical_issue', label: 'Technical issue' },
  { code: 'admin', label: 'Admin time' },
];

/**
 * The reasons this campaign accepts — configured, else the built-ins.
 *
 * This is the single authority: bootstrap advertises exactly this list, and
 * `POST /sessions/:id/break` validates against exactly this list. Two sources
 * would drift, and the failure mode is an agent whose console offers a code the
 * server rejects.
 */
export function resolveBreakReasons(
  configured: AgencyBreakReason[] | null | undefined,
): AgencyBreakReason[] {
  // Defensive on shape as well as emptiness: the column is CHECKed to be a JSON
  // array, but nothing constrains its ELEMENTS, so a malformed catalog must degrade
  // to the built-ins rather than 500 every break request on this campaign.
  //
  // The reserved reasons (`RESERVED_BREAK_REASONS`) are never among them, whatever the
  // column holds. The soft phone's is entered only through the soft-phone switch, which
  // checks the flag and audits the switch (SP7): listed here, `POST /sessions/:id/break`
  // would put the agent on the soft phone with neither, and dropped it is refused as
  // `unknown_break_reason`. The device-away break is accepted by that route on its own
  // rules (`api/routes/agency/device-away.ts`), never from the menu: listed here, an
  // agent could pick "app in background" from a browser.
  //
  // A stored `limit_minutes` the write would refuse (out of range, not a whole number: a row
  // written before the rule, or by hand) is dropped from that entry, never the entry itself: the
  // reason stays on the menu and its break falls back to the floor's 30-minute rule (LF20).
  if (!Array.isArray(configured)) return [...DEFAULT_BREAK_REASONS];
  const valid = configured.filter(
    (r): r is AgencyBreakReason =>
      !!r && typeof r === 'object'
      && typeof (r as AgencyBreakReason).code === 'string'
      && (r as AgencyBreakReason).code.length > 0
      && !isReservedBreakReason((r as AgencyBreakReason).code),
  ).map(withUsableLimit).map(withKnownIcon);
  return valid.length > 0 ? valid : [...DEFAULT_BREAK_REASONS];
}

/** `reason` without a `limit_minutes` the rule refuses (`isAgencyBreakLimitMinutes`); otherwise itself. */
function withUsableLimit(reason: AgencyBreakReason): AgencyBreakReason {
  if (!('limit_minutes' in reason) || isAgencyBreakLimitMinutes(reason.limit_minutes)) return reason;
  const { limit_minutes: _dropped, ...rest } = reason;
  return rest;
}

/**
 * Agent station (BE-13): `reason` without an `icon` the contract does not list (`isAgencyTileIcon`;
 * a stray or retired value is no icon, so the station guesses its own picture); otherwise itself.
 */
function withKnownIcon(reason: AgencyBreakReason): AgencyBreakReason {
  if (!('icon' in reason) || isAgencyTileIcon(reason.icon)) return reason;
  const { icon: _dropped, ...rest } = reason;
  return rest;
}

/**
 * LF6, LF20: the limit, in minutes, of a break on `code` under this campaign's catalog
 * (`configured`, resolved as the break menu resolves it, so the built-ins when it lists none).
 * Null when the reason has no limit of its own, for a reserved code (never one: the soft phone's,
 * the app's pauses) and for a code the catalog does not know; the floor's 30-minute rule
 * (`AGENCY_BREAK_DEFAULT_LIMIT_MINUTES`) applies to all of those except the soft phone.
 */
export function breakLimitMinutes(
  code: string | null | undefined,
  configured: AgencyBreakReason[] | null | undefined,
): number | null {
  if (!code || isReservedBreakReason(code)) return null;
  return resolveBreakReasons(configured).find((r) => r.code === code)?.limit_minutes ?? null;
}

/**
 * Agent station (BE-12, AS12): a break that ran past its reason's limit, judged when it ends. The
 * break began at `startedAt` (the session's `state_since` on entering it) and ended at `endedAt`;
 * its limit is `breakLimitMinutes(code, configured)` over the catalog as it stands when the break
 * ENDS (the caller passes the catalog its transition read; a limit changed during the break is the
 * one judged, as 0061's column comment says), so a reserved break, a reason with no limit of its
 * own and a code the catalog does not know never count. Over: the limit and the WHOLE seconds
 * past it (floored, so a break a fraction of a second over is not counted), both as
 * `agency_agent_session_events.break_limit_minutes` / `break_overrun_seconds` (0060) take them.
 * Null when it did not run over, or when there is no limit to run over.
 */
export function breakOverrun(input: {
  code: string | null | undefined;
  configured: AgencyBreakReason[] | null | undefined;
  startedAt: Date;
  endedAt: Date;
}): { limit_minutes: number; overrun_seconds: number } | null {
  const limit = breakLimitMinutes(input.code, input.configured);
  if (limit === null) return null;
  const overMs = input.endedAt.getTime() - input.startedAt.getTime() - limit * 60_000;
  const seconds = Math.floor(overMs / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? { limit_minutes: limit, overrun_seconds: seconds } : null;
}

/** Whether `code` is accepted, and the valid set to echo back when it is not. */
export function validateBreakReason(
  configured: AgencyBreakReason[] | null | undefined,
  code: unknown,
): { ok: true; reason: AgencyBreakReason } | { ok: false; allowed: string[] } {
  const reasons = resolveBreakReasons(configured);
  const match = typeof code === 'string' ? reasons.find((r) => r.code === code) : undefined;
  return match ? { ok: true, reason: match } : { ok: false, allowed: reasons.map((r) => r.code) };
}

/** Whether `code` is one of the dialer's reserved break codes (`RESERVED_BREAK_REASONS`). */
export function isReservedBreakReason(code: unknown): boolean {
  return typeof code === 'string' && (RESERVED_BREAK_REASONS as readonly string[]).includes(code);
}

/**
 * The device-away break as a reason entry (what the break queue holds for it): no
 * catalog carries it, so its label is the contract's.
 */
export const DEVICE_AWAY_BREAK: Readonly<AgencyBreakReason> = Object.freeze({
  code: DEVICE_AWAY_BREAK_REASON,
  label: DEVICE_AWAY_BREAK_REASON_LABEL,
});

/** IQ51: the cellular-call pause as a reason entry, as {@link DEVICE_AWAY_BREAK}. */
export const PHONE_CALL_BREAK: Readonly<AgencyBreakReason> = Object.freeze({
  code: PHONE_CALL_BREAK_REASON,
  label: PHONE_CALL_BREAK_REASON_LABEL,
});

/** IQ58 (Mode B): the away break whose phone rings for inbound callers, as {@link DEVICE_AWAY_BREAK}. */
export const AWAY_RING_BREAK: Readonly<AgencyBreakReason> = Object.freeze({
  code: AWAY_RING_BREAK_REASON,
  label: AWAY_RING_BREAK_REASON_LABEL,
});

/** Agent states from which a break must be QUEUED rather than applied now. */
const DEFERRING_STATES = new Set(['on_call', 'reserved', 'wrapup']);

/**
 * Whether a break requested from this state has to wait.
 *
 * `on_call` is the obvious one — a break requested mid-call
 * is applied at the end of wrap-up, never mid-conversation. `wrapup` defers for the
 * same reason one step later: the agent still owes a disposition, and letting the
 * break jump that would drop the record of the call they just had.
 *
 * **`reserved` defers too, and that case is easy to miss.** An agent reserved for a
 * dial that has already gone to the carrier is about to be bridged to a real person
 * who is about to answer. Applying a break there produces exactly the abandoned
 * call reserve-before-dial exists to prevent — the customer picks up and there is
 * nobody on the line.
 */
export function breakMustWait(state: string | null | undefined): boolean {
  return !!state && DEFERRING_STATES.has(state);
}

/** Pending breaks, keyed by session. */
export class BreakRegistry {
  private readonly pending = new Map<string, AgencyBreakReason>();

  queue(sessionId: string, reason: AgencyBreakReason): void {
    this.pending.set(sessionId, reason);
  }

  peek(sessionId: string): AgencyBreakReason | null {
    return this.pending.get(sessionId) ?? null;
  }

  /** Consume a queued break — returns it and clears it, so it applies once. */
  take(sessionId: string): AgencyBreakReason | null {
    const reason = this.pending.get(sessionId) ?? null;
    if (reason) this.pending.delete(sessionId);
    return reason;
  }

  /** The agent changed their mind before it applied. */
  cancel(sessionId: string): boolean {
    return this.pending.delete(sessionId);
  }

  size(): number {
    return this.pending.size;
  }
}
