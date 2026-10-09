import { getPool } from '@magick-agency/db';
import type {
  NotificationDeliveryClaim,
  NotificationDeliveryStatus,
} from '../models/notification.model.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** `notification_deliveries.error` is free text from a transport. Bound it. */
const MAX_ERROR_LENGTH = 500;

export interface ClaimDeliveriesInput {
  eventKey: string;
  tenantId: string;
  accountId: string | null;
  /** Built by `buildDedupeKey`; opaque here. */
  dedupeKey: string;
  /** Lower-cased by the caller. */
  recipients: readonly string[];
}

class NotificationDeliveryRepository {
  /**
   * Claim the right to send this notification to these inboxes.
   *
   * ── The whole mechanism, in one statement ─────────────────────────────
   *
   * One multi-row INSERT with `ON CONFLICT DO NOTHING RETURNING`. A recipient
   * that comes back was claimed by THIS call and must be sent to; one that does
   * not was already claimed — by a previous tick, a Lambda retry, an operator's
   * manual re-run, or another instance running the same fan-out a millisecond
   * earlier — and must be skipped.
   *
   * The claim is the *only* thing standing between an at-least-once trigger and
   * duplicate mail. Nothing upstream is exactly-once: EventBridge is
   * at-least-once by contract, the trigger Lambda retries any non-2xx, and a
   * retry after a timeout lands on a DIFFERENT master instance while the first
   * is still working — which is precisely the case an in-process "already
   * running" flag cannot see.
   *
   * ── Why claim BEFORE sending, and what it costs ───────────────────────
   *
   * Claiming after a successful send would leave a window in which the mail has
   * gone and the row has not, so a concurrent run sends it again. Claiming first
   * closes that, at the price that a send which then FAILS has burned its
   * dedupe key: the row stays, marked `failed`, and nothing retries.
   *
   * That is the deliberate trade, and it turns on one fact — the commonest
   * "failure" is a TIMEOUT, and a timeout after Mailjet has already accepted the
   * message is indistinguishable from one before. Deleting the row to allow a
   * retry therefore does not recover a lost mail so much as duplicate a
   * delivered one. A missed digest costs one period and there is a self-service
   * Preview; duplicate mail cannot be un-sent.
   *
   * ── Atomic per call, and that matters ─────────────────────────────────
   *
   * One statement rather than a loop, so it cannot half-claim: a crash between
   * two independent claims would leave some inboxes claimed-but-unsent forever
   * with no way to tell them from ones that genuinely failed.
   */
  async claim(input: ClaimDeliveriesInput): Promise<NotificationDeliveryClaim[]> {
    const recipients = [...new Set(input.recipients.filter((r) => r.length > 0))];
    if (!isUuid(input.tenantId) || recipients.length === 0) return [];

    const pool = getPool();
    const result = await pool.query<NotificationDeliveryClaim>(
      // `account_id` is resolved through a lookup rather than bound directly, and
      // that is a fix rather than a flourish.
      //
      // `isUuid(...)` is a SHAPE check, so it correctly turns the
      // `bulk_dispatch_jobs` sentinel `'default'` into NULL but passes through a
      // well-formed uuid for an account that no longer exists. That column has an
      // FK to `accounts(id)` while `bulk_dispatch_jobs.account_id` has none, so a
      // historical job row outliving its account carries exactly that value —
      // and the insert then raised `23503`. Because the whole multi-row INSERT is
      // one statement, the abort took EVERY recipient of that campaign with it:
      // `gateCampaignNotification` catches, counts `claim_error` and returns
      // `[]`, so the notice is silently withheld from everybody, not merely
      // mis-scoped. Reproduced against a real Postgres.
      //
      // The scalar subquery yields NULL for an account that is not there, which
      // is the same value `ON DELETE SET NULL` would have left had the row been
      // written before the deletion. The delivery record is meant to outlive the
      // account — migration 072 says so — so losing the scope is right and losing
      // the mail is not.
      //
      // And it is scoped `a.tenant_id = $3`, not merely `a.id = $4`. An existence
      // test alone would have written tenant A's delivery row carrying tenant B's
      // `account_id`: `bulk_dispatch_jobs.account_id` has NO foreign key and no
      // tenant check of its own, so a stale or hand-repaired job row can name an
      // account belonging to somebody else, and the bare lookup would have
      // resolved it happily. The tenant predicate makes an unresolvable-here id
      // land on the same NULL a deleted one gets, which is the honest answer:
      // master could not scope this delivery, so it records no scope.
      //
      // This column is not read by any authorization path today (it is written
      // here, aged out by `retention-purge.ts`, and served by nothing), so the
      // bare version was a latent defect rather than a live cross-tenant leak.
      // It is fixed here because the day it becomes a filter is not the day to
      // discover a row was mis-scoped years earlier.
      `INSERT INTO notification_deliveries
         (event_key, dedupe_key, recipient, tenant_id, account_id, status)
       SELECT $1, $2, r, $3::uuid,
              (SELECT a.id FROM accounts a
                 WHERE a.id = $4::uuid AND a.tenant_id = $3::uuid),
              'pending'
         FROM unnest($5::text[]) AS r
       ON CONFLICT (event_key, tenant_id, dedupe_key, recipient) DO NOTHING
       RETURNING id, recipient`,
      [
        input.eventKey,
        input.dedupeKey,
        input.tenantId,
        isUuid(input.accountId) ? input.accountId : null,
        recipients,
      ],
    );
    return result.rows;
  }

  /**
   * Record what happened to a claimed row.
   *
   * Fire-and-forget from the caller's point of view: a delivery whose outcome
   * cannot be written is strictly better than a send that is rolled back,
   * because the mail has already left. It therefore never throws — a failure
   * here leaves the row `pending`, which reads as "we claimed this and do not
   * know how it went", a state support can act on.
   */
  async recordOutcome(
    id: string,
    status: NotificationDeliveryStatus,
    error?: string | null,
  ): Promise<void> {
    if (!isUuid(id)) return;
    const pool = getPool();
    await pool.query(
      `UPDATE notification_deliveries
          SET status  = $2,
              error   = $3,
              sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
        WHERE id = $1::uuid`,
      [id, status, error ? error.slice(0, MAX_ERROR_LENGTH) : null],
    );
  }

  /**
   * Record one outcome across a set of claimed rows, addressed by their natural
   * key rather than by id.
   *
   * The campaign mailers send ONE message to the whole address list and get back
   * ONE verdict, so there is no per-recipient answer to write and no reason for
   * those modules to carry claim ids across the send. Addressing the rows by
   * `(event_key, tenant_id, dedupe_key, recipient)` — the unique index the claim
   * itself used — keeps the id inside this repository.
   *
   * Scoped to `status = 'pending'` so it can only ever close rows THIS run
   * claimed. Without that predicate a late call could overwrite the outcome of a
   * row an earlier run had already marked `sent`, turning a successful delivery
   * into a recorded failure.
   */
  async recordOutcomeByKey(
    key: { eventKey: string; tenantId: string; dedupeKey: string; recipients: readonly string[] },
    status: NotificationDeliveryStatus,
    error?: string | null,
  ): Promise<void> {
    const recipients = [...new Set(key.recipients.filter(Boolean))];
    if (!isUuid(key.tenantId) || recipients.length === 0) return;

    const pool = getPool();
    await pool.query(
      `UPDATE notification_deliveries
          SET status  = $4,
              error   = $5,
              sent_at = CASE WHEN $4 = 'sent' THEN NOW() ELSE sent_at END
        WHERE event_key  = $1
          AND tenant_id  = $2::uuid
          AND dedupe_key = $3
          AND recipient  = ANY($6::text[])
          AND status     = 'pending'`,
      [
        key.eventKey,
        key.tenantId,
        key.dedupeKey,
        status,
        error ? error.slice(0, MAX_ERROR_LENGTH) : null,
        recipients,
      ],
    );
  }

  /**
   * The key-addressed form of {@link release}, for the campaign gate.
   *
   * Same rule and same narrowness: only ever for an attempt that provably
   * delivered nothing. The gate holds addresses rather than claim ids (the
   * mailers carry only addresses across the send), so it cannot use the id form.
   *
   * `status = 'pending'` is what makes it safe to call after a concurrent
   * finalization has already recorded a real outcome — that row is no longer
   * pending, so this cannot delete the record of a send that happened.
   */
  async releaseByKey(key: {
    eventKey: string;
    tenantId: string;
    dedupeKey: string;
    recipients: readonly string[];
  }): Promise<void> {
    const recipients = [...new Set(key.recipients.filter(Boolean))];
    if (!isUuid(key.tenantId) || recipients.length === 0) return;

    const pool = getPool();
    await pool.query(
      `DELETE FROM notification_deliveries
        WHERE event_key  = $1
          AND tenant_id  = $2::uuid
          AND dedupe_key = $3
          AND recipient  = ANY($4::text[])
          AND status     = 'pending'`,
      [key.eventKey, key.tenantId, key.dedupeKey, recipients],
    );
  }

  /**
   * Release a claim that was never attempted.
   *
   * The ONE case where deleting the row is right, and it is narrow: the
   * dispatcher claimed, then discovered before making any transport call that it
   * could not send at all (no `mailjet` block configured, a renderer that threw,
   * a run cancelled between claim and send). No mail exists, so the dedupe key
   * must not stay burned — otherwise a staging environment with no mail provider
   * silently consumes every tenant's digest key for that period, and enabling
   * Mailjet later would send nothing until the next one.
   *
   * Never called after a transport attempt of any kind. That distinction is the
   * difference between this being a safety valve and it being the retry loop the
   * claim exists to prevent.
   */
  async release(ids: readonly string[]): Promise<void> {
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return;
    const pool = getPool();
    await pool.query(
      `DELETE FROM notification_deliveries
        WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
      [valid],
    );
  }
}

export const notificationDeliveryRepository = new NotificationDeliveryRepository();
