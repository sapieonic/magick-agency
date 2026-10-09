import { createChildLogger } from '@magick-agency/observability';
import { dncRepository } from '../dnc/dnc.repository.js';

const log = createChildLogger({ component: 'agency-dnc-registry' });

/**
 * ─── AGENCY DIALER — DO NOT CALL, AND WHY IT FAILS CLOSED (§2.3) ─────────────
 *
 * PORT NOTE (magick-agency, decision B8 — the DNC collapse). Core kept the
 * dial-time answer in a versioned Redis set that master published into, and this
 * header used to spend two screens on why that set was only authoritative when it
 * carried a version and why an empty read was not "clear". None of that machinery
 * exists here any more: there is ONE table, `dnc_entries`, and the dial-time check
 * is an indexed read of it (`idx_dnc_entries_tenant_phone`) through the same
 * `DncRepository.findSuppressed` predicate the roster ingest uses. A mark commits
 * to the table the check reads, so there is no publish step, no version, no
 * "unsynced tenant" state and no resync. What survives, unchanged, is the rule:
 *
 * DNC is checked twice, at two different times, for two different reasons. At
 * **ingest** suppressed numbers never enter the roster — that is the bulk check and
 * it costs nothing at dial time. At **dial** (here) the table answers a single
 * indexed lookup immediately before the call is placed, because a contact an agent
 * marks DNC at 10:00 must not be dialed by a retry at 10:05.
 *
 * **Unavailability halts dialing.** This is the one place in the system where that
 * is the correct answer: a wrongly-dialed DNC number is a regulatory event, a
 * paused campaign is an inconvenience. Note the polarity is the OPPOSITE of the
 * reaper's, where failing closed means treating an agent as live and reaping
 * nothing. The rule both obey is *fail toward not acting on the customer*.
 *
 * What "unavailable" now means: **the database read threw** (pool down, timeout,
 * a statement error, a pool that was never initialised). There is no
 * `unavailable` for "the set is empty" any more, and there must never be a
 * `clear` for a read that did not complete: every arm that is not a successful
 * answer is `unavailable`, and `pre-dial-gates` turns that into a `halt` that
 * aborts the whole claimed batch.
 *
 * ── The scopes ───────────────────────────────────────────────────────────────
 *
 * Core's flat set could express only tenant-wide entries (`account_id IS NULL AND
 * campaign_id IS NULL`); account- and campaign-scoped rows were enforced at ingest
 * alone. The table can express all three, so when the caller names the dial's
 * account and campaign the check widens exactly as master's `findSuppressed` does:
 * a tenant-wide row, an account-wide row for that account, or a campaign row for
 * that campaign suppresses (the predicate widens, never narrows, so naming a scope
 * can only turn a `clear` into a `suppressed`). The scope is a REQUIRED argument
 * (pass `null` for a tier you are not checking), so it cannot be forgotten.
 */

/**
 * What the pre-dial check learned. Four values, not three, because two different
 * failures need two different responses.
 *
 * - `clear` — checked, not on the list. Dial.
 * - `suppressed` — on the list. Suppress the contact, never dial.
 * - `unverifiable` — THIS phone number cannot be checked at all (it is not E.164,
 *   so no comparison against the set is meaningful). A per-contact data problem,
 *   and it must not halt the campaign: one malformed row would otherwise stop
 *   dialing for everybody. The contact is suppressed `invalid`.
 * - `unavailable` — the REGISTRY cannot answer: the `dnc_entries` read failed
 *   (core: no Redis, an unsynced tenant, or an error — see the port note above).
 *   Campaign-wide, so dialing halts.
 */
export type DncCheck = 'clear' | 'suppressed' | 'unverifiable' | 'unavailable';

/**
 * The scope the dial is for. **Both fields are REQUIRED** (`null` = "do not check
 * that tier"), so a caller that forgets the scope fails to compile instead of
 * silently checking tenant-wide rows only and skipping account- and
 * campaign-scoped entries (an agent's own campaign mark among them). Phase 6's
 * `pre-dial-gates` passes the campaign's `account_id` and `id`.
 */
export interface DncCheckScope {
  accountId: string | null;
  campaignId: string | null;
}

/**
 * Normalize to the exact form the roster stores.
 *
 * A mismatch here is a silent fail-open — `+14155550100` and `14155550100` are
 * different set members, and a check against the wrong form returns "clear" for a
 * number that is on the list. So both sides of the comparison go through this one
 * function, and anything it cannot normalize is refused rather than compared.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/[\s\-()]/g, '');
  const digits = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  // E.164: 1–15 digits, no leading zero on the country code.
  if (!/^[1-9]\d{1,14}$/.test(digits)) return null;
  return `+${digits}`;
}

export class DncRegistry {
  /**
   * @param repo Injected for tests; defaults to the shared `dnc_entries` repository.
   *   Replaces core's `(redis, keyPrefix, onUnsynced)` constructor — there is no
   *   Redis set, no key prefix and no baseline to request.
   */
  constructor(private readonly repo: Pick<typeof dncRepository, 'findSuppressed'> = dncRepository) {}

  /**
   * The pre-dial check. Immediately before the dial, per §2.3.
   *
   * Never throws and never answers `clear` for a read that did not complete: a
   * rejected query (including a pool that does not exist) is `unavailable`.
   */
  async check(tenantId: string, phoneE164: string, scope: DncCheckScope): Promise<DncCheck> {
    const phone = normalizeE164(phoneE164);
    if (!phone) return 'unverifiable';
    try {
      const suppressed = await this.repo.findSuppressed(
        { tenantId, accountId: scope.accountId, campaignId: scope.campaignId },
        [phone],
      );
      return suppressed.has(phone) ? 'suppressed' : 'clear';
    } catch (err) {
      log.error({ err, tenantId }, 'DNC check failed — refusing to dial');
      return 'unavailable';
    }
  }
}
