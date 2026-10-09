import { E164_REGEX } from '../utils/phone-normalizer.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  dncRepository,
  type DncEntryRecord,
  type DncListFilter,
  type DncLookupScope,
  type DncSource,
} from './dnc.repository.js';

const log = createChildLogger({ component: 'dnc-service' });

/**
 * Do-Not-Call list operations (design §2.3, `AD-P3-M-01`).
 *
 * ── Polarity, stated once, because everything else follows from it ───────────
 * DNC is the one control in this system where **unavailability must halt work**.
 * A wrongly-dialed suppressed number is a regulatory event; a paused campaign is
 * an inconvenience. So `filterSuppressed` throws {@link DncUnavailableError}
 * rather than returning an empty set, and its callers are required to abort the
 * work they were doing. Nothing in this module or its repository catches a
 * database error and continues.
 *
 * ── Why input must already be E.164, and why that is the safe strictness ─────
 * The obvious kindness — normalising `9876543210` for the operator via
 * `normalizePhoneToE164` — is a fail-open bug here. That helper applies
 * `DEFAULT_PHONE_COUNTRY_CODE` (platform-wide, `91` by default), while a roster
 * is normalised with the ingest job's **per-campaign** `default_country_code`.
 * A US campaign's `5551234567` becomes `+15551234567` in the roster and
 * `+915551234567` in the DNC list, and the suppression lookup is an exact string
 * match — so the entry silently never matches anything, forever, and the
 * operator sees a number sitting on their DNC list that keeps getting dialed.
 *
 * A rejected entry is visible and fixable in one edit. A mis-normalised one is
 * invisible and permanent. So: separators are stripped, a leading `+` and a
 * country code are REQUIRED, and anything else comes back as `invalid_phone`.
 */

/** Cap on one add request. Bulk regulator lists go through the same route. */
export const DNC_ADD_MAX_NUMBERS = 1_000;

/** Per-number outcome of an add. `already_present` is a success. */
export type DncAddOutcome = 'added' | 'already_present' | 'invalid_phone';

export interface DncAddResult {
  /** The input string, verbatim, so the caller can point at the row they sent. */
  input: string;
  outcome: DncAddOutcome;
  /** Absent for `invalid_phone`. */
  phone_e164?: string;
  /** Absent for `invalid_phone`. */
  entry_id?: string;
  /**
   * The campaign scope of the row that is actually on the list — `null` for a
   * tenant-wide entry. Absent for `invalid_phone`.
   *
   * ── Read from the ROW, never echoed from the request, and that is the point ──
   * `POST /internal/agency/dnc` returns this to core as a receipt, and core is
   * being changed to compare it against what it sent and treat a mismatch as
   * "not landed". A receipt copied from the request cannot detect the thing it
   * exists to detect: if `add`/`insertMany` ever stopped honouring `campaignId`,
   * a mirrored field would confirm the scope the caller asked for while the row
   * sat at a different one — which is precisely the silent-strip defect the
   * campaign-scope work was opened to fix, wearing a confirmation.
   *
   * It is also the value that differs on the idempotent path: `already_present`
   * hands back a PRE-EXISTING row, whose scope is whatever it was written at and
   * need not match this request at all.
   */
  campaign_id?: string | null;
}

export interface DncAddRequest {
  tenantId: string;
  /** NULL/undefined ⇒ tenant-wide, the scope core's Redis set can express. */
  accountId?: string | null;
  campaignId?: string | null;
  phoneNumbers: readonly string[];
  source: DncSource;
  reason?: string | null;
  addedBy?: string | null;
}

export interface DncAddSummary {
  added: number;
  already_present: number;
  invalid: number;
  results: DncAddResult[];
}

/**
 * The list could not be consulted.
 *
 * A distinct type rather than a bare `Error` so a caller can render honest copy
 * ("we could not check your list, nothing was imported") instead of a generic
 * failure — and so the fail-closed path is greppable.
 */
export class DncUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DncUnavailableError';
  }
}

/**
 * Coerce one operator-supplied string to E.164, or reject it.
 *
 * Exported because it is the module's only silent-failure surface and therefore
 * needs its own tests: every rule below is a number that either enters the list
 * or does not, and the wrong answer is invisible at the call site.
 */
export function toDncE164(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (!cleaned.startsWith('+')) return null;
  return E164_REGEX.test(cleaned) ? cleaned : null;
}

export class DncService {
  /**
   * Add numbers to the list. Never partially fails silently: a number that could
   * not be parsed comes back as `invalid_phone` in `results`, and a database
   * failure propagates (the caller must not report a partial import as a
   * success).
   *
   * Duplicates *within one request* are collapsed before hitting the database —
   * a pasted regulator list routinely repeats numbers, and 400 identical
   * `ON CONFLICT DO NOTHING` inserts followed by 400 fallback SELECTs is a
   * pointless round-trip storm. The collapsed copies report the same outcome as
   * the first, which is what the operator means by "these 400 rows".
   */
  async add(request: DncAddRequest): Promise<DncAddSummary> {
    /**
     * Two passes, because the write is one transaction taking one version.
     *
     * Pass one resolves and de-duplicates so the repository receives a clean,
     * distinct list; pass two maps the repository's per-number outcomes back onto
     * the rows the operator actually sent. Interleaving them (parse, insert,
     * parse, insert) is what the per-row-transaction shape forced, and it is
     * exactly what made a 1,000-number import take 1,000 versions.
     */
    const parsed: Array<{ input: string; phone: string | null }> = request.phoneNumbers.map(
      (input) => ({ input, phone: toDncE164(input) }),
    );

    const distinct: string[] = [];
    const seen = new Set<string>();
    for (const { phone } of parsed) {
      if (phone && !seen.has(phone)) {
        seen.add(phone);
        distinct.push(phone);
      }
    }

    const written =
      distinct.length > 0
        ? await dncRepository.insertMany({
            tenant_id: request.tenantId,
            account_id: request.accountId ?? null,
            campaign_id: request.campaignId ?? null,
            source: request.source,
            reason: request.reason ?? null,
            added_by: request.addedBy ?? null,
            phones: distinct,
          })
        : { results: [] };

    const byPhone = new Map(written.results.map((r) => [r.phone_e164, r]));

    /** Phones already reported as `added` — later copies are `already_present`. */
    const reported = new Set<string>();
    const results: DncAddResult[] = parsed.map(({ input, phone }) => {
      if (!phone) return { input, outcome: 'invalid_phone' as DncAddOutcome };

      const row = byPhone.get(phone)!;
      // `already_present` for every copy after the first, NEVER a repeat of
      // `added`. Echoing `added` three times for three spellings of one number
      // makes the counters claim three suppressions where one happened — and
      // reconciling against the rows the operator sent is the summary's only job.
      // It is also simply true by then: the first copy put it on the list.
      const outcome: DncAddOutcome =
        row.created && !reported.has(phone) ? 'added' : 'already_present';
      reported.add(phone);
      // `row.entry` is the row that is on the list — the one just inserted, or the
      // pre-existing one the conflict resolved to. Its scope is therefore the
      // written scope, not the requested one, which is what makes `campaign_id`
      // below a receipt rather than an echo.
      return {
        input,
        outcome,
        phone_e164: phone,
        entry_id: row.entry.id,
        campaign_id: row.entry.campaign_id,
      };
    });

    const summary: DncAddSummary = {
      added: results.filter((r) => r.outcome === 'added').length,
      already_present: results.filter((r) => r.outcome === 'already_present').length,
      invalid: results.filter((r) => r.outcome === 'invalid_phone').length,
      results,
    };

    // PORT NOTE (magick-agency, decision B8): master published a delta to core's
    // Redis set here, after the commit. There is no set to publish to — the
    // dial-time check reads `dnc_entries` itself — so the committed row IS the
    // propagation.

    log.info(
      {
        tenantId: request.tenantId,
        accountId: request.accountId ?? null,
        campaignId: request.campaignId ?? null,
        source: request.source,
        added: summary.added,
        alreadyPresent: summary.already_present,
        invalid: summary.invalid,
      },
      'DNC entries added',
    );

    return summary;
  }

  /**
   * Which of `phones` must not be dialed for this scope.
   *
   * **Fail-closed.** Throws {@link DncUnavailableError} when the list cannot be
   * read. The caller's only correct response is to stop — refuse the import,
   * halt the campaign — never to proceed with an unchecked batch.
   *
   * `phones` must already be E.164 (they come from the roster parser, which has
   * normalised them). Nothing is normalised here: normalising on the read side
   * with a different default country code than the write side is how a lookup
   * silently stops matching.
   */
  async filterSuppressed(
    scope: DncLookupScope,
    phones: readonly string[],
  ): Promise<Set<string>> {
    try {
      return await dncRepository.findSuppressed(scope, phones);
    } catch (err) {
      // Logged here rather than only at the caller: the caller reports "the DNC
      // list was unavailable" to an operator, and the underlying cause has to be
      // recoverable from logs or the halt looks arbitrary.
      log.error(
        { err, tenantId: scope.tenantId, phoneCount: phones.length },
        'DNC lookup failed — refusing to treat unchecked numbers as dialable',
      );
      throw new DncUnavailableError(
        'The Do Not Call list could not be checked. No numbers were treated as dialable.',
        err,
      );
    }
  }

  async list(filter: DncListFilter): Promise<{ entries: DncEntryRecord[]; total: number }> {
    return dncRepository.list(filter);
  }

  async getById(id: string, tenantId: string): Promise<DncEntryRecord | null> {
    return dncRepository.findById(id, tenantId);
  }

  /**
   * Remove one entry. Returns the removed row, or null when there was nothing to
   * remove for this tenant (or, with `accountScope` set, nothing owned by that
   * account — a tenant-wide or sibling-account entry reports the same "nothing
   * to remove" as a genuinely missing id, which is the point: the route
   * answers both with an identical 404).
   *
   * **Removal is the compliance-dangerous direction** — it makes a number
   * dialable again — which is why its route floors at `account_admin`
   * (`agency.dnc.manage`) while an agent's mark-DNC floors at `agent`. Adding
   * over-blocks at worst; removing under-blocks.
   *
   * `accountScope` is omitted entirely (not passed as `undefined`) for a
   * tenant-wide caller, so the repository call keeps its original two-argument
   * shape rather than growing a third `undefined` that would change nothing
   * about the query but would change every existing assertion on this call.
   */
  async remove(id: string, tenantId: string, accountScope?: string): Promise<DncEntryRecord | null> {
    const removed = accountScope !== undefined
      ? await dncRepository.deleteById(id, tenantId, accountScope)
      : await dncRepository.deleteById(id, tenantId);
    if (!removed) return null;

    log.info(
      {
        tenantId,
        entryId: id,
        phoneE164: removed.entry.phone_e164,
        accountId: removed.entry.account_id,
        campaignId: removed.entry.campaign_id,
      },
      'DNC entry removed',
    );

    return removed.entry;
  }
}

export const dncService = new DncService();
