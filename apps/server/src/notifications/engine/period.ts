/**
 * PORT NOTE (magick-agency): trimmed to the cadence vocabulary. Master's window
 * arithmetic — `PeriodWindow`, `resolvePeriodWindow`, `previousWindow`,
 * `toIsoDate`, `formatPeriodLabel`, `startOfUtcDay`, `startOfUtcWeek`, `DAY_MS`,
 * `MONTHS`, `formatUtcDate` (master `period.ts:42-173`) — is deleted: its only
 * callers were the credits usage digest (`digest/run-digests.ts`,
 * `digest/usage-digest.ts`) and `POST /notifications/digests/preview`, none of
 * which exist in Magick Agency (plan §3.5, no credits). What stays is reached by
 * the catalog's `defaultFrequency` type, `audience.ts`' stored-row fallback, the
 * notification model and the preference validator. The header below is
 * master's, kept verbatim; the window it describes is no longer in this file.
 */
/**
 * Digest period arithmetic — the half-open UTC window a digest reports on.
 *
 * Separated from everything that reads a clock, a config block or a database so
 * the window can be asserted with a plain function call. It is the part of the
 * digest most likely to be silently wrong: an off-by-one here does not fail, it
 * just mails somebody yesterday's numbers under today's heading, or counts a
 * campaign twice across two consecutive digests.
 *
 * ── Everything here is UTC, deliberately and visibly ────────────────────────
 *
 * The EventBridge schedules that drive this fire at fixed UTC times
 * (`serverless.yml`), the ledger stores `TIMESTAMPTZ`, and there is no per-user
 * timezone column anywhere in this service. So a "day" is a UTC day and a "week"
 * is a UTC Monday-to-Sunday, and {@link formatPeriodLabel} renders the boundary
 * dates so a reader can see which window they were given rather than having to
 * infer it from when the mail arrived.
 *
 * The consequence worth stating rather than discovering: for a tenant in IST
 * (UTC+5:30) the "daily" digest covers 05:30 yesterday to 05:30 today in their
 * own reckoning, not their calendar day. That is a known limitation, not an
 * oversight — see the note on {@link PeriodWindow}.
 *
 * ── Half-open `[from, to)`, always ─────────────────────────────────────────
 *
 * Every query built from a window uses `created_at >= from AND created_at < to`.
 * A closed upper bound double-counts any row landing exactly on the boundary —
 * which is not a theoretical microsecond, because `now()` is fixed per
 * transaction and the ledger writes in batches, so a whole flush shares a
 * timestamp. The same reasoning the audit merge's keyset pagination records.
 */

/** The cadences a digest can be subscribed at. Order is display order. */
export const DIGEST_FREQUENCIES = ['daily', 'weekly'] as const;

export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export function isDigestFrequency(value: unknown): value is DigestFrequency {
  return typeof value === 'string' && (DIGEST_FREQUENCIES as readonly string[]).includes(value);
}
