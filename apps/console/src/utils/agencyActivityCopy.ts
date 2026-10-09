import { formatDate } from './format';
import type { ActivityRetention, ActivityRow } from '../types/agency-activity';

/**
 * The copy decisions for the campaign Activity view, kept pure so the ones that
 * matter can be tested without rendering anything.
 *
 * The rule running through all of them: this surface's failure mode is looking
 * complete while being short, so every gap is stated in words rather than
 * implied by an absence.
 */

/**
 * What the trail cannot cover, sourced from the API rather than hardcoded.
 *
 * Core's audit table is monthly-partitioned and the retention purge DROPs whole
 * partitions, so a campaign older than the window returns a partial trail that
 * looks like a complete one. The number is configured server-side (in the
 * retention Lambda, not even in core's own config), so a copy in this client
 * would be a second number that goes stale and tells the operator the wrong
 * thing — the same reason the ingest wizard fetches its limits.
 *
 * Returns `null` only when there is genuinely nothing to say: nothing has aged
 * out yet. `unknown` gets a sentence too, because "we do not know how far back
 * this goes" is information, and silence would be read as "all of it".
 */
export function retentionNotice(retention: ActivityRetention | null): string | null {
  if (!retention) {
    return 'How far back this trail goes could not be checked, because part of it could not be '
      + 'loaded. Treat anything older than the oldest row below as unconfirmed.';
  }
  if (retention.source === 'unbounded') return null;
  if (retention.source === 'partition_bound' && retention.earliest_retained_at) {
    // Scoped to the DIALER's records on purpose. The horizon is derived from the
    // dialer's own storage; the console keeps its records on a separate schedule
    // that this figure says nothing about. Stating it unqualified would claim a
    // guarantee for dispositions, do-not-call marks and staffing changes that
    // has not been checked — the retention trap, one store further along.
    return `The dialer’s records go back to ${formatDate(retention.earliest_retained_at)}. `
      + 'Anything older has passed its retention window and is no longer stored. Console records '
      + 'follow their own retention schedule, which this date does not cover.';
  }
  return 'How far back this trail goes could not be determined, so treat anything older than the '
    + 'oldest row below as unconfirmed rather than absent.';
}

/**
 * Timestamps for an audit table: seconds and a named zone.
 *
 * The shared `formatDate` stops at minutes and names no timezone, which is fine
 * for "updated 5 minutes ago" and useless here — a whole audit flush shares one
 * displayed minute with no ordering cue, and a reviewer comparing the screen
 * against the CSV (which is ISO-8601 UTC) has nothing to reconcile them by.
 */
export function formatActivityTimestamp(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Core has no user table, so a non-`system:` actor on a dialer row is the
 * CLIENT that made the request (an originator string such as
 * `magick-agency-console`), never a person. Rendered plainly it reads as the
 * name of whoever acted, which on an attribution surface is the worst possible
 * cell — so it is labelled for what it is, and points at the console row that
 * does name the person.
 */
export const CLIENT_ACTOR_TOOLTIP =
  'The dialer does not record who pressed the button — it records which application asked. '
  + 'The matching “Console” row for this action names the person.';

/**
 * The banner for a page missing core's half.
 *
 * Deliberately names WHAT is missing rather than saying "some data is
 * unavailable": a supervisor who does not know that status changes and the
 * automatic pause are the missing part cannot judge whether what is on screen
 * answers their question.
 */
export function partialNotice(reason: string | null): string {
  const cause = reason === 'core_unreachable'
    ? 'The voice service could not be reached'
    : 'The voice service returned an error';
  return `${cause}, so this trail is missing the campaign's status changes and any automatic `
    + 'pause. What is shown below is complete for everything else. Refresh to try again.';
}

/**
 * The export stopped at the server's ceiling — say so, and say what to do.
 *
 * The unknown-ceiling branch is not a formality. The row limit is a response
 * header, and a header another service writes can arrive as something this
 * client cannot read as a number — so "truncated, size unknown" is a real
 * runtime state (see `parseRowLimit` in `api/agencyActivity.ts`), not a
 * theoretical one. It gets its own sentence rather than a number-shaped hole in
 * the first one, because a truncated export that cannot say HOW truncated is
 * still a truncated export and must still warn: the remedy — narrow the range,
 * export again — is the same either way, and it is the half the operator acts
 * on.
 */
export function truncationNotice(rowLimit: number | null): string {
  const remedy = 'Narrow the date range and export again to get the rest.';
  if (rowLimit === null) {
    return 'This export stopped at the server’s limit, so it does not contain every entry that '
      + `matched your filters. ${remedy}`;
  }
  return `Only the most recent ${rowLimit.toLocaleString()} entries were exported. ${remedy}`;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * A one-line summary of a row's detail, or `null` to fall back to the raw
 * key/value list.
 *
 * Only the handful of actions where the detail IS the answer get a sentence.
 * `auto_paused` is the reason this exists: "Paused" without the measured rate
 * and the ceiling it breached does not tell a compliance reviewer anything, and
 * that pair is the whole content of the row.
 *
 * Unrecognised actions deliberately return `null` rather than a generic
 * rendering, so the raw detail is shown instead of being summarised away.
 */
export function activityDetailSummary(row: ActivityRow): string | null {
  const detail = row.detail ?? {};

  if (row.action === 'agency_campaign.auto_paused') {
    const measured = num(detail['measured_pct']);
    const ceiling = num(detail['ceiling_pct']);
    if (measured !== null && ceiling !== null) {
      return `Abandonment reached ${measured}%, over the ${ceiling}% ceiling.`;
    }
    return str(detail['reason']) ? `Reason: ${str(detail['reason'])}` : null;
  }

  if (row.action === 'agency_disposition.created') {
    const code = str(detail['disposition_code']);
    if (!code) return null;
    // `on_behalf` is the audit case the flag exists for — a disposition filed by
    // someone other than the agent who took the call — so it is never buried in
    // an expander.
    return detail['on_behalf'] === true
      ? `Filed “${code}” on behalf of the agent who took the call.`
      : `Filed “${code}”.`;
  }

  if (row.action === 'dnc_entry.created' || row.action === 'dnc_entry.deleted') {
    const scope = str(detail['scope']);
    const verb = row.action === 'dnc_entry.created' ? 'Suppressed' : 'Un-suppressed';
    return scope ? `${verb}, scope: ${scope}.` : null;
  }

  const from = str(detail['from']);
  const to = str(detail['to']);
  if (from && to) return `${from} → ${to}`;
  const status = str(detail['status']);
  if (status) return `Status is now ${status}.`;

  return null;
}

/**
 * Where the row came from, in the operator's vocabulary.
 *
 * Both services record some of the same actions, and a Pause legitimately
 * produces two rows — the supervisor's press and the campaign's transition. The
 * labels say which is which instead of exposing service names, which mean
 * nothing to the person reading the trail.
 */
export const ACTIVITY_SOURCE_LABEL: Record<string, string> = {
  master: 'Console',
  core: 'Dialer',
};

/**
 * The Console/Dialer explanation, as a single persistent legend rather than a
 * per-row tooltip.
 *
 * It used to live in a `title` on each row's tag — invisible to keyboard and
 * screen-reader users, and the same sentence repeated once per row for
 * everyone else. It is one fact about the whole table (why a Pause can appear
 * twice), not a fact that varies row to row, so it is said once, in prose that
 * stays in the accessibility tree without needing focus.
 */
export const ACTIVITY_SOURCE_LEGEND =
  '“Recorded by” names which system logged the row: Console is someone in this workspace pressing '
  + 'a control, Dialer is the campaign itself changing state — so the same pause can legitimately '
  + 'appear once as each.';

/** The table's accessible name — the campaign it belongs to, when known. */
export function activityTableCaption(campaignName: string | null): string {
  return campaignName
    ? `Activity log for ${campaignName}`
    : 'Activity log';
}
