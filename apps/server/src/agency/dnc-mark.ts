import type { PoolClient } from 'pg';
import { createChildLogger } from '@magick-agency/observability';
import { normalizeE164 } from './dnc-registry.js';
import { dncRepository, dncScopeLabel, SCOPE_SENTINEL } from '../dnc/dnc.repository.js';

const log = createChildLogger({ component: 'agency-dnc-mark' });

/**
 * ─── AGENCY DIALER — AN AGENT MARKING A CONTACT DNC ─────────────────────────
 *
 * Decision B8: the mark is ONE write of the `dnc_entries` row the dial-time check
 * ({@link DncRegistry.check}) reads, made by {@link markDnc} inside the same
 * transaction as the agent's attempt bookkeeping on `POST /agency/attempts/:id/dnc`
 * (the roster suppression and the optional disposition). There is one table and one
 * writer, so there is nothing to forward, retry or reconcile, and the written row is
 * read back rather than echoed. The `agency_dnc_outbox` table stays in the schema
 * unused; nothing here writes it.
 *
 * Every decision below is about the customer.
 *
 * ── The mark is CAMPAIGN-SCOPED BY DEFAULT ───────────────────────────────────
 *
 * A customer who asked one campaign to stop must not be removed from campaigns
 * they have never heard from. So the default is campaign-scoped: the caller passes
 * `campaignId` and the row is written `account_id IS NULL, campaign_id = <id>`.
 * The dial-time check ({@link DncRegistry.check}) widens by scope, so a campaign
 * row stops that campaign dialing the number and nobody else.
 *
 * ── …and the tenant-wide ESCALATION is still reachable, deliberately ─────────
 *
 * `campaignId` is OPTIONAL, and omitting it writes the tenant-wide row
 * (`account_id IS NULL AND campaign_id IS NULL`): the number is blocked in every
 * campaign the tenant runs, now and in future. The console offers that under a
 * permission and labels it "any campaign, forever"; the promise and the write have
 * to be the same thing. Which of the two happens is decided ONCE, at the route,
 * from the request's `scope` (absent ⇒ `campaign`, the narrower).
 *
 * ── The account scope belongs to ONE caller: the soft phone's untagged call ───
 *
 * A station mark is a campaign or a tenant mark, and a caller that supplies an
 * `accountId` is REFUSED (`refused: 'invalid_dnc_scope'`, which the route maps to
 * its 400 of the same name): the station has no account affordance, and writing
 * one from there would look correct on the list while meaning something the agent
 * never said.
 *
 * The soft phone's mark on a call logged to NO campaign (Mark DNC, or a `suppress`
 * outcome; docs/softphone.md §4.1 step 7, §6) has no campaign to scope to, and a
 * tenant-wide row would be an escalation the station keeps behind
 * `agency.dnc.manage` — which an agent does not hold. So that path, and only that
 * path, passes {@link DncMarkRequest.accountScope}: the account the call belongs to,
 * written `account_id = <id>, campaign_id IS NULL`. It is the scope the untagged
 * pre-dial reads, and every campaign dial of that account reads it too
 * (`findSuppressed` widens by account). A separate, explicitly named field rather
 * than lifting the `accountId` refusal, so the station's guard stays exactly as it
 * was. `accountScope` together with a `campaignId` is refused: one scope per mark.
 *
 * The reserved nil UUID (`SCOPE_SENTINEL`) is refused as a campaign or account id
 * for the reason `dncScopeUuid` documents: it is the value `uq_dnc_scope`
 * COALESCEs a NULL scope to, so a row carrying it would collide with the
 * tenant-wide row and swallow a later escalation.
 *
 * ── The one thing that must not drift ────────────────────────────────────────
 *
 * The phone is normalized with {@link normalizeE164} — the SAME function
 * `DncRegistry.check` runs on both sides of its comparison, and the same one
 * `suppressByPhone` matches roster rows with — before it is stored. `+14155550100`
 * and `14155550100` are different strings to every index that stores them, so
 * writing a roster row's raw text would put a row on the list that nothing ever
 * matches: every log line reads as success and the customer keeps being called. A
 * number that is not usable E.164 is refused HERE and **no row is written**.
 *
 * ── Transaction and failure ──────────────────────────────────────────────────
 *
 * Without `deps.client` the write is its own single transaction and failure is
 * REPORTED, never thrown (`recorded: false`): a caller that has already taken the
 * contact off the roster must not answer a 5xx that tells the agent nothing
 * happened. With `deps.client` — how the station DNC route calls it — the insert
 * joins the CALLER's transaction (the mark beside its attempt bookkeeping,
 * decision B8) and a failure PROPAGATES so the
 * caller's transaction rolls the row back with everything else; swallowing it there
 * would commit a bookkeeping write whose DNC row is missing.
 */

export interface DncMarkRequest {
  tenantId: string;
  /**
   * The campaign the agent marked from — **present for a campaign-scoped mark,
   * absent for a tenant-wide escalation**. There is no third state: this field IS
   * the scope, and it is the only thing that decides it.
   *
   * Optional, and the omission is a STATEMENT rather than an absence of
   * information. `POST /agency/attempts/:id/dnc` always knows the campaign — it
   * resolved the attempt to get here — so a caller never omits this because it
   * could not find out. It omits it because the request asked for `scope:
   * 'tenant'`. The route defaults an ABSENT `scope` to `'campaign'`, so ignorance
   * still narrows rather than escalates. Do not make this required without moving
   * the escalation somewhere else first.
   */
  campaignId?: string;
  /**
   * NOT SUPPORTED on this path — see the module header. Present only so a caller
   * that tries to pass one is refused with `invalid_dnc_scope` rather than having
   * the field silently dropped (the failure class this module exists to avoid).
   * The soft phone's account-scoped mark is {@link accountScope}.
   */
  accountId?: string | null;
  /**
   * The soft phone's mark on an UNTAGGED call, and nothing else: the account the call
   * belongs to (the module header). Writes `account_id = <id>, campaign_id IS NULL`.
   * Refused with a `campaignId` beside it, or as the nil UUID.
   */
  accountScope?: string;
  /** As stored on the roster row; normalized here, never trusted as-is. */
  phoneE164: string;
  /** Free text, stored on the entry. */
  reason?: string;
  /**
   * The user id of the human who marked it. Optional: this deliberately does NOT
   * substitute the attempt's reserved agent — on an audit record a
   * confidently-wrong actor is worse than a missing one.
   */
  addedBy?: string;
}

export interface DncMarkResult {
  /**
   * Did the `dnc_entries` row land, at whichever scope was asked for? True for an
   * already-present number — a redelivery found the number suppressed, and
   * reporting a failure would have an agent's second press look like it did not
   * work.
   */
  recorded: boolean;
  /** Distinguished for logs only; both outcomes are `recorded: true`. */
  alreadyPresent: boolean;
  /**
   * The normalized number that was actually written, or null when the roster row
   * is not usable E.164 at all (nothing written). The route echoes this to the
   * agent, so it says what was suppressed rather than what was typed.
   */
  phoneE164: string | null;
  /**
   * The row that is actually ON the list, read back from it — its id, and its
   * scope: `campaign_id` is its campaign and `account_id` its account (both null
   * for a tenant-wide entry). `null` for the whole field when nothing was written.
   * It is the row itself, so it cannot be a mirror of the request. On the
   * `alreadyPresent` path it is the PRE-EXISTING row.
   */
  written: { id: string; campaign_id: string | null; account_id: string | null } | null;
  /**
   * Set when the request itself was refused before anything was written.
   *
   * Unreachable from the one caller today. The station DNC route
   * (`api/routes/agency.routes.ts`) never passes an `accountId` and passes the campaign id it
   * resolved from the attempt (never the sentinel), and answers a bad client `scope` with its
   * own `400 invalid_dnc_scope` before calling this; it does not read this field. It is the
   * guard for any future caller (`test/unit/agency/dnc-mark.test.ts`).
   */
  refused?: 'invalid_dnc_scope';
}

export interface DncMarkDeps {
  /**
   * Join the caller's transaction instead of opening one. The caller owns BEGIN /
   * COMMIT / ROLLBACK and release; failures propagate (see the module header).
   */
  client?: PoolClient;
}

/**
 * Record a DNC entry, at the scope the request states — campaign-scoped when
 * `req.campaignId` is present, account-scoped when `req.accountScope` is (the soft
 * phone's untagged call only), tenant-wide when neither is. One transaction. See
 * the module header for what happens on failure.
 */
export async function markDnc(
  req: DncMarkRequest,
  deps: DncMarkDeps = {},
): Promise<DncMarkResult> {
  if (
    (req.accountId !== undefined && req.accountId !== null) ||
    req.campaignId === SCOPE_SENTINEL ||
    (req.accountScope !== undefined && (req.campaignId !== undefined || req.accountScope === SCOPE_SENTINEL))
  ) {
    log.warn(
      { tenantId: req.tenantId, campaignId: req.campaignId, accountScoped: req.accountId != null || req.accountScope !== undefined },
      'DNC mark refused: a station mark is campaign-scoped or tenant-wide, and only the soft phone\'s untagged mark is account-scoped',
    );
    return {
      recorded: false, alreadyPresent: false, phoneE164: null, written: null,
      refused: 'invalid_dnc_scope',
    };
  }

  const phone = normalizeE164(req.phoneE164);

  if (!phone) {
    // Refusing here keeps the "what did we actually write" question answerable and
    // keeps a number nothing can ever match off the list.
    log.error(
      { tenantId: req.tenantId, campaignId: req.campaignId },
      'Contact phone is not usable E.164 — no DNC entry could be written',
    );
    return { recorded: false, alreadyPresent: false, phoneE164: null, written: null };
  }

  try {
    const { results } = await dncRepository.insertMany(
      {
        tenant_id: req.tenantId,
        // NULL unless this is the soft phone's untagged mark (`accountScope`).
        account_id: req.accountScope ?? null,
        // `?? null` stores the SCOPE, it does not paper over a missing value: an
        // absent `campaignId` is a tenant-wide escalation, and NULL is how the row
        // says so.
        campaign_id: req.campaignId ?? null,
        source: 'agent',
        reason: req.reason ?? null,
        added_by: req.addedBy ?? null,
        phones: [phone],
      },
      deps.client ? { client: deps.client } : {},
    );
    const row = results[0]!;
    log.info(
      {
        tenantId: req.tenantId, campaignId: row.entry.campaign_id, entryId: row.entry.id,
        alreadyPresent: !row.created, scope: dncScopeLabel(row.entry),
      },
      // Inside a caller's transaction the row is not committed yet — the caller's COMMIT
      // (or ROLLBACK) decides — so the line says so.
      deps.client ? 'DNC entry written (in the caller\'s transaction, not yet committed)' : 'DNC entry recorded',
    );
    return {
      recorded: true,
      alreadyPresent: !row.created,
      phoneE164: phone,
      written: { id: row.entry.id, campaign_id: row.entry.campaign_id, account_id: row.entry.account_id },
    };
  } catch (err) {
    if (deps.client) throw err;
    // Postgres is unavailable or the statement failed. Nothing durable can be done
    // from here; say so at error rather than pretending a retry exists.
    log.error(
      { err, tenantId: req.tenantId, campaignId: req.campaignId, phoneE164: phone },
      'Could not write the DNC entry — the compliance entry is NOT recorded and will not be retried',
    );
    return { recorded: false, alreadyPresent: false, phoneE164: phone, written: null };
  }
}
