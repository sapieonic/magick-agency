import type { AgencyAgentStatsBucket, AgencyStatsBucketWidth } from './agency-stats';

/**
 * One campaign's numbers over TIME — `GET /proxy/agency/campaigns/:id/stats/series`.
 *
 * ── Why this is a third file rather than a field on either neighbour ────────
 * `agency-campaign.ts` holds the supervisor payload for one campaign as it
 * stands right now; `agency-stats.ts` holds one AGENT's numbers across every
 * campaign they worked. This is the third folding — one campaign, cut by day —
 * and it belongs to neither: putting it in `agency-campaign.ts` would make that
 * file import the bucket type out of `agency-stats.ts`, which already imports
 * `AgencyAgentsByState` back out of it, and a cycle between two type files is a
 * thing that compiles right up until somebody adds a value to one of them.
 *
 * ── The bucket is REUSED, not re-declared ──────────────────────────────────
 * `buckets[]` is {@link AgencyAgentStatsBucket} field-for-field, which is
 * the public API layer's contract rather than a coincidence this file is exploiting. That is
 * what lets `bucketSeries` / `bucketDay` — and every off-by-one those two have
 * already been fixed for — serve this series unchanged. A parallel
 * `AgencyCampaignStatsBucket` with the same five fields would be a second copy
 * of a shape whose whole value is that there is one, and the first thing to
 * drift would be `bucket_start`'s "never hand this to `new Date()`" rule.
 *
 * ── Every day in the range is present, zeros included ──────────────────────
 * A weekend arrives as `attempts: 0`, not as an absent key. "No dials that day"
 * and "that day was not in the response" are different facts and only the first
 * one can be drawn — a chart that closed the gap would draw a week as six days.
 *
 * ── No rates on the wire ───────────────────────────────────────────────────
 * The response carries counts only. Connect rate (`connected / attempts`) and
 * conversion (`successes / connected`) are derived per bucket in
 * `utils/agencyCampaignSeries.ts` and are **`null` wherever the denominator is
 * zero** — never `0`. This is the same null-not-zero rule
 * `abandonment_rate_24h_pct` carries, and a line chart is where breaking it is
 * most expensive: a day with no dials plotted at 0% draws a cliff into the
 * middle of a campaign that was simply not running that day.
 */
export interface AgencyCampaignSeries {
  campaign_id: string;
  bucket: AgencyStatsBucketWidth;
  /**
   * The IANA zone the days were cut in — the campaign's own, the one its
   * calling window is enforced in.
   *
   * Echoed back so the chart can NAME it. Unlike the per-agent series, where a
   * "day" can span two zones and the chart has to explain that in words
   * (`BUCKET_TIMEZONE_NOTE`), one campaign has exactly one zone: the honest
   * note here is short and specific, and it needs the zone's name to be either.
   *
   * Optional because it is the one field of this payload with no consequence
   * when absent — the note is dropped, the bars are unchanged.
   */
  timezone?: string | null;
  /** The range actually served, echoed back. Half-open `[from, to)`. */
  from?: string;
  to?: string;
  /** Oldest first, and **not re-sorted by this client** — see `bucketSeries`. */
  buckets: AgencyAgentStatsBucket[];
}
