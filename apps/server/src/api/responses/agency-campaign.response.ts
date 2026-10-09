import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import type { AgencyCampaignActor } from '@magick-agency/contracts/agency';

/**
 * The campaign row as the API serves it: the record, with the two
 * `last_transition_by_*` COLUMNS folded into one nested object.
 *
 * ── Derived from the record, deliberately NOT an allow-list ─────────────────
 *
 * This is the opposite choice from `formatWebRtcCallResponse`, which is a
 * deny-by-default allow-list, and the difference is not an inconsistency: that
 * function exists to keep a column off the wire (`campaign_id`, the raw provider
 * recording URL), and this one exists to CHANGE THE SHAPE of two columns that are
 * already public. Every campaign field has been served since 072 — the four
 * routes below all `send` the row — so an allow-list here would be a second,
 * hand-maintained copy of the campaign's whole column list whose only failure mode
 * is silently dropping a field somebody added. `Omit<Record, …> & { … }` is the
 * spelling that keeps a new column flowing and makes a RENAMED one a build error.
 *
 * ── Why fold at all, rather than serving the two columns flat ───────────────
 *
 * `last_transition_by: { user_id, name } | null` is one fact — who caused the
 * current status — and two nullable sibling columns are three states on the wire
 * for it, one of which is nonsense (a name with no id). The nesting makes
 * "unattributed" exactly one value the console tests once, instead of two
 * null-checks a consumer can get half-right. See {@link AgencyCampaignActor} for
 * why `name` alone stays nullable inside it.
 *
 * ── `completed_at` still ships beside `ended_at` ────────────────────────────
 *
 * Both, on purpose, and holding the same instant. Migration 108's header has the
 * long form: `completed_at` is on a payload master and the console already read,
 * and removing a field from a shipped response is a three-repo sequencing exercise
 * rather than a migration. Nothing here computes either one — they come off the
 * row, written by the single `CASE` in `transitionStatus`, so this function cannot
 * be the place they drift.
 *
 * ── One column IS stripped: `retry_idempotency_key` ────────────────────────
 *
 * The single exception to "derive, do not allow-list", and it is on the deny
 * side, so the reasoning above still holds: a new column keeps flowing, and this
 * one is named.
 *
 * It is an opaque REPLAY TOKEN, not a fact about the campaign. Serving it would
 * let any reader of `GET /:id` — every role with campaign read, in either
 * account of the tenant — learn a key that another caller minted, and a key is
 * the whole of the at-most-once check: presenting it back refuses that caller
 * their own retry and hands them the campaign it already made. It is also
 * outside the frozen wire contract, which would otherwise gain
 * `retry_idempotency_key: null` on every ordinary campaign response.
 *
 * `Omit`ted from the response type as well as destructured out, so deleting the
 * strip is a build error instead of a silent disclosure.
 *
 * ── The timestamps stay `Date`, and that is not an oversight ────────────────
 *
 * `started_at`/`ended_at`/`completed_at` are handed to Fastify as `Date` objects
 * and serialised by `JSON.stringify`, which emits `toISOString()` — an ISO-8601
 * instant, which is what the contract promises. Converting them here would be a
 * second serialisation rule for the same values, and `created_at`/`updated_at`/
 * `paused_at` on the same payload would then be formatted by a different one.
 */
export type AgencyCampaignResponse =
  Omit<
    AgencyCampaignRecord,
    'last_transition_by_user_id' | 'last_transition_by_name' | 'retry_idempotency_key'
  >
  & { last_transition_by: AgencyCampaignActor | null };

/**
 * Fold one campaign row into its wire shape.
 *
 * The actor is present only when there is an ID. A `name` with no `user_id` is
 * refused rather than served as `{ user_id: '', name }`: the id is the identity —
 * it is what a console links to a user with — and an actor object nobody can
 * resolve is worse than an honest `null`. The pair is written together by
 * `transitionStatus`, so this arm is unreachable through the API; it is here
 * because a hand-run `UPDATE` can produce it and `null` is the only answer that
 * cannot mislead.
 */
export function formatAgencyCampaignResponse(row: AgencyCampaignRecord): AgencyCampaignResponse {
  const {
    last_transition_by_user_id: userId,
    last_transition_by_name: name,
    // Dropped, not renamed. See the type's header — an opaque replay token is
    // not a campaign field, and `SELECT *` puts it on this object.
    retry_idempotency_key: _retryIdempotencyKey,
    ...rest
  } = row;
  return {
    ...rest,
    last_transition_by: userId ? { user_id: userId, name: name ?? null } : null,
  };
}
