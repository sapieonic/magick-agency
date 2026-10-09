/**
 * The words the attempt-spine views use (MAG-159).
 *
 * A LEAF module — pure functions over data, no React. Copy lives here rather
 * than inline because the same sentences appear on the attempts view, the
 * roster view and the drill-down, and three copies is how one goes stale.
 */

import type { AgencyAttempt, AgencyRosterContact } from '../types/agency-spine';
import { suppressedReasonLabel } from '../types/agency-spine';
import type { AgencyCampaign, AgencyDispositionEntry } from '../types/agency-campaign';

/**
 * A disposition's operator-chosen NAME, resolved from the campaign's catalog.
 *
 * Every spine view rendered `attempt.disposition_code` raw, so a supervisor read
 * `ptp` — while the campaign's own Settings tab holds `label: 'PTP'` beside that
 * code in {@link AgencyDispositionEntry}. The catalog is already on the campaign
 * every one of these pages fetches, so this was the wrong field being rendered
 * rather than a name nobody had.
 *
 * It matters more than tidiness. `ptp` is unguessable, and the surrounding copy
 * on these screens is unusually careful — "Spoke to a person", "Counted as a
 * win" — so a raw code reads as a different class of thing entirely, something
 * internal that leaked. Measured on production: 23 of 36 contacts on one
 * campaign showed `ptp` as their last disposition.
 *
 * **Falls back to the code, never to a dash.** Four ways to miss:
 * an older master that does not send the catalog, a campaign that has not loaded
 * yet, a code retired from the catalog since the call was filed, or a code core
 * wrote that the catalog never held. In all four the code is what we know, and
 * a historical call filed under a retired code is exactly the row an audit is
 * about — the same reasoning `activityActionLabel` uses for an unrecognised
 * action, and `AgencyCampaignStatusBadge` for an unrecognised status.
 */
export function dispositionLabel(
  code: string | null | undefined,
  catalog: readonly AgencyDispositionEntry[] | undefined,
): string | null {
  if (!code) return null;
  return catalog?.find((entry) => entry.code === code)?.label ?? code;
}

/**
 * That this campaign is not recording, or `null`.
 *
 * The attempts view carries a column of links to each call and a tip saying a
 * recording is kept for any call that connected. Both are true and neither is
 * the whole truth: recording is **off by default per campaign**
 * (`record_calls`), and while it is off no call it places keeps audio. A
 * supervisor reviewing a call therefore learned this one row at a time, from a
 * drill-down that says "Recording was not enabled for this call" — 36 rows to
 * discover a campaign-level fact.
 *
 * ── A SETTING, not a fact about the rows ────────────────────────────────────
 *
 * The first version said "there is no audio behind any of these rows", which
 * reads the current flag as a history. It is not one. `record_calls` is
 * PATCHable at any point in a campaign's life, and
 * `agencyCampaignRecording.ts` is built around exactly that case — master
 * deliberately permits the on→off write even to a tenant that has lost
 * `agency.recording`, so a campaign that recorded four hundred calls and was
 * then switched off is a supported state, not a hypothetical. On that campaign
 * the sentence withdrew audio that exists and is linked from the column beside
 * it.
 *
 * Nothing on the wire dates the change, so the note describes the setting and
 * leaves the rows to the per-row copy that can actually see them
 * ({@link recordingCellCopy}, and the drill-down's own line).
 *
 * **Only a literal `false` claims it.** `undefined` is an older master that does
 * not send the flag, and the module's standing rule is that an absent field is
 * not a measurement — announcing "no calls are recorded" off a field that never
 * arrived would be a confident claim about a campaign we know nothing about.
 */
export function recordingDisabledNote(campaign: AgencyCampaign | null): string | null {
  if (campaign?.record_calls !== false) return null;
  return 'Recording is off for this campaign, so the calls it places now keep no audio. '
    + 'Calls from before it was switched off may still have a recording. Recording is set '
    + 'per campaign, on the Settings tab.';
}

/**
 * Local time, to the minute.
 *
 * `Intl` in the viewer's own zone, not the campaign's: a supervisor reading a
 * compliance question is reading it where they are. The campaign's calling
 * window is a separate concept and has its own display elsewhere.
 */
export function formatSpineTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

/** `m:ss`, or an em dash. `0` is a real value and renders as `0:00`. */
export function formatTalkTime(seconds: number | null): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Why an attempt has no agent, in words.
 *
 * `null` on `agent_user_id` is the single most misreadable field on this view:
 * it looks like data we failed to load, and it is not — it is the defining
 * property of the rows this page exists to surface. An attempt that never
 * reached an agent is exactly what `/app/calls/softphone/history` structurally
 * cannot show.
 */
export function agentCellCopy(attempt: AgencyAttempt): { text: string; muted: boolean } {
  // The NAME when master could resolve it. Falling back to the id is not
  // cosmetic — master user ids are UUIDs, so an unresolved cell is 36 characters
  // a supervisor can neither read nor recognise. It is still shown, because the
  // id is a real answer and hiding it would say "no agent", which is false.
  if (attempt.agent_name) return { text: attempt.agent_name, muted: false };
  if (attempt.agent_user_id) return { text: attempt.agent_user_id, muted: true };
  if (attempt.outcome === 'abandoned') return { text: 'No agent was free', muted: true };
  if (attempt.bridged_at === null) return { text: 'Never reached an agent', muted: true };
  // Reserved once, but the session row is gone (sessions are per shift and the
  // attempt outlives them). Saying "unknown" is honest; saying "no agent" is not.
  return { text: 'Agent unknown', muted: true };
}

/**
 * What the recording cell says.
 *
 * Three states, and the middle one is the one a naive render collapses:
 *  - an id we can link to;
 *  - **no id at all**, which is not an error — an abandoned or failed attempt
 *    never produced a media leg, so there is nothing to have kept;
 *  - an id whose call has since been purged, which the link discovers on
 *    arrival. Core keeps `webrtc_call_id` deliberately un-FK'd so the attempt
 *    row outlives the call, so this is a designed outcome rather than a
 *    dangling reference — the destination page must say "no longer available"
 *    rather than 404.
 */
/**
 * Why this row has no call to open, or `null` when it does.
 *
 * ── The `canOpenDialer` parameter is gone, and its absence is the fix ───────
 *
 * It existed for one reason: the destination used to be
 * `/app/calls/dialer/history/:id`, gated on `calls.dialer` — a capability a pure
 * agency supervisor can legitimately lack, so the cell had to warn that the link
 * would land on a refusal screen with the list they were reading now off-screen.
 * The honest copy for it was "Recorded — needs dialer access".
 *
 * The destination is now agency-native
 * (`/agency/campaigns/:id/attempts/:attemptId`, gated on `agency` and floored at
 * `agency.supervise`), which is exactly what these views already require. There
 * is no viewer who can read this table and not open the row, so the branch is
 * dead and a parameter that can only ever be `true` is worse than none —
 * it invites someone to thread a capability check that no longer means anything.
 *
 * What remains is the case that was never about capabilities: the attempt has no
 * call to open at all.
 */
export function recordingCellCopy(attempt: AgencyAttempt): string | null {
  if (!attempt.webrtc_call_id) {
    return attempt.bridged_at === null ? 'No call was connected' : 'No recording';
  }
  return null;
}

/** The one-line summary under a contact's number on the drill-down. */
export function contactSummaryLine(contact: AgencyRosterContact): string {
  const parts: string[] = [];
  parts.push(contact.attempt_count === 1 ? '1 attempt' : `${contact.attempt_count} attempts`);
  if (contact.our_fault_attempts > 0) {
    // Named separately because it is NOT part of the customer's retry budget —
    // a redial caused by our own fault must not read as us having called them
    // more times than the campaign permits.
    parts.push(
      contact.our_fault_attempts === 1
        ? '1 redial after a system fault'
        : `${contact.our_fault_attempts} redials after system faults`,
    );
  }
  const reason = suppressedReasonLabel(contact.suppressed_reason);
  if (reason) parts.push(reason);
  return parts.join(' · ');
}

/**
 * What to say when an export stopped early.
 *
 * The row ceiling is a **routine** outcome here, not a rare one: a campaign can
 * hold a million contacts and the ceiling is 50,000. So the copy names the
 * remedy rather than only reporting the fact — an operator told "truncated" and
 * nothing else has no next step and will hand the file over anyway.
 */
export function exportTruncationNotice(
  reason: string | null,
  rowLimit: number | null,
  rows: number | null,
  /**
   * Which surface the message is shown on. It decides which filters the remedy
   * may name — see below.
   */
  kind: 'attempts' | 'contacts' = 'attempts',
): string {
  const count = rows !== null ? `${rows.toLocaleString()} rows` : 'a partial file';
  if (reason === 'deadline') {
    return `The export stopped early — it took too long to assemble. ${count} were downloaded. `
      + 'Narrow the filters and try again.';
  }
  const ceiling = rowLimit !== null
    ? `the ${rowLimit.toLocaleString()}-row export limit`
    : 'the export limit';
  // ── The remedy must name controls that exist ON THIS PAGE ──────────────────
  // The first version of this sentence said "a date range, a state or an
  // outcome" on both surfaces. The roster has neither a date range nor an
  // outcome filter, so it sent the operator looking for controls that are not
  // there — and the date remedy could not have worked on a roster anyway:
  // ingest bulk-inserts inside one transaction where `now()` is fixed, so
  // essentially the whole roster shares one `created_at` and no date range
  // partitions it. A remedy the reader cannot follow is worse than none.
  const remedy = kind === 'attempts'
    ? 'Narrow it down — a date range, or a specific outcome — and export again for the rest.'
    : 'Narrow it down — a contact state, or a suppression reason — and export again for the rest. '
      + 'A whole roster of this size cannot be exported in one file.';
  return `The export stopped at ${ceiling}, so this file is not the whole set. ${count} were `
    + `downloaded. ${remedy}`;
}

/**
 * The standing note on both bulk views.
 *
 * Shown rather than left implicit because the numbers on screen are the personal
 * data of everyone on the roster, and the export makes a copy of them that
 * leaves the platform.
 */
export const SPINE_PRIVACY_NOTE =
  'Phone numbers are shown in full. Exports contain them too — treat the file as personal data.';

/** What the attempts view is, in one line, for the page description. */
export const ATTEMPTS_DESCRIPTION =
  'Every dial this campaign placed, newest first — including the ones that never reached an agent. '
  + 'This is the operational record: what was dialed, to whom, and what happened.';

/**
 * ── "Never dialed because they were suppressed" ─────────────────────────────
 *
 * That is what this said, and it has the causality backwards in the more
 * prominent of the two slots on the page — `PageDescription` renders it as the
 * standing paragraph above the tips, so a reader who never expands the guide
 * saw only this.
 *
 * Suppression is not a pre-dial filter. It is also the terminal state a contact
 * reaches when an agent files a disposition carrying `suppress: true` — a
 * promise to pay, most often — so on the production campaign this branch was
 * written from, 23 of 36 suppressed contacts had been dialed, spoken to, and
 * closed as wins. Told they were "never dialed", a supervisor reads the
 * campaign's best outcomes as contacts it failed to reach.
 *
 * The same inversion was fixed in the funnel's Suppressed hint and in this
 * page's own tips; this constant is the third copy and was missed. All three are
 * pinned by tests now.
 */
export const ROSTER_DESCRIPTION =
  'Every contact on this campaign and where each one got to — including the ones nothing will '
  + 'dial again, whether they were closed by an agent or never dialed at all.';
