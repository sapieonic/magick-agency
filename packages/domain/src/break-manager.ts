import type { AgencyBreakReason } from '@magick-agency/contracts/agency';

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
 */
export const DEFAULT_BREAK_REASONS: readonly AgencyBreakReason[] = [
  { code: 'break', label: 'Break' },
  { code: 'lunch', label: 'Lunch' },
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
  if (!Array.isArray(configured)) return [...DEFAULT_BREAK_REASONS];
  const valid = configured.filter(
    (r): r is AgencyBreakReason =>
      !!r && typeof r === 'object'
      && typeof (r as AgencyBreakReason).code === 'string'
      && (r as AgencyBreakReason).code.length > 0,
  );
  return valid.length > 0 ? valid : [...DEFAULT_BREAK_REASONS];
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
