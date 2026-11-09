/**
 * **NEW** — the super-admin usage-counts view.
 *
 * Read-only and charges nothing. v1 has no metering; this view exists so the
 * facts metering will need are visible from day one, and it reads only rows
 * agency already owns:
 *
 * | Field | Source row |
 * |---|---|
 * | `dials` | `agency_call_attempts` with `dialed_at` in the window (served by the `(dialed_at, campaign_id)` index), plus soft-phone dials (`agency_manual_calls.dialed_at`, SP5): every call agency placed in the window |
 * | `answered_calls` | the same attempts with `answered_at IS NOT NULL` (the carrier answered) |
 * | `connected_calls` | the same attempts with `bridged_at IS NOT NULL` (an agent was joined) |
 * | `talk_seconds` | Σ `agency_call_attempts.talk_seconds` over those attempts |
 * | `analysis_audio_seconds` | Σ `dialer_analysis_jobs.analysis_audio_seconds` for jobs on those attempts' calls |
 * | `inbound_*` | inbound calls with an account (`agency_inbound_calls`, docs/inbound.md §9), windowed on `arrived_at`: counted apart from the dials (the carrier bills a received call's minutes, holding included, not a dial), with the carrier time (answer to end) and the queue time measured |
 *
 * ── Decisions this shape makes, stated so Lane A can overturn them ──────────
 *  - **Seconds, not minutes.** The plan says "talk minutes, analysis minutes";
 *    the wire carries exact seconds and the console divides. A per-call
 *    rounding rule (ceil per call? per 30s block?) is a pricing decision, and
 *    making one here would be metering by the back door.
 *  - **One window rule for every field: the attempt's `dialed_at`, half-open
 *    `[from, to)`**, the same convention as `AgencyAgentStats` /
 *    `AgencyCampaignStatsSeries`. Analysis seconds are attributed to the dial
 *    they analysed, not to when the job ran, so every number on a row describes
 *    the same set of dials and the rows tile across consecutive windows.
 *  - **Both `answered_calls` and `connected_calls`.** They differ by exactly the
 *    abandoned population (answered, never bridged), and which one a future
 *    meter charges is undecided.
 *  - `talk_seconds` is the persisted column, which is anchored on `answered_at`
 *    and so includes an abandoned attempt's apology-clip time — the
 *    carrier-billed figure, deliberately NOT the agent-leg `ended_at - bridged_at`
 *    that `AgencyCampaignStats.aht_seconds` uses.
 */

/** `GET /super-admin/usage?from=&to=&tenant_id=&account_id=`. */
export interface UsageCountsQuery {
  /** ISO-8601, inclusive. */
  from: string;
  /** ISO-8601, EXCLUSIVE. */
  to: string;
  /** Narrow to one tenant. Absent ⇒ every tenant. */
  tenant_id?: string;
  /** Narrow to one account; requires `tenant_id`. */
  account_id?: string;
}

export interface UsageCounts {
  /** Placed calls only (campaign and soft phone); an inbound call is never a dial. */
  dials: number;
  answered_calls: number;
  connected_calls: number;
  talk_seconds: number;
  analysis_audio_seconds: number;
  /** Inbound calls that arrived in the window (with an account), refused ones included. */
  inbound_calls: number;
  /** Answered by our answer XML (a message, the queue, a voicemail): each billed by the carrier. */
  inbound_answered_calls: number;
  /** An agent was bridged. */
  inbound_connected_calls: number;
  /** Carrier time: the sum of answer-to-end over the answered calls that have ended. */
  inbound_seconds: number;
  /** Queue time: the sum of queued-to-bridged (else to the end) over the ended calls that queued. */
  inbound_hold_seconds: number;
  /** Talk time from the bridge. */
  inbound_talk_seconds: number;
  /** Analysis audio of the inbound calls' recordings. */
  inbound_analysis_audio_seconds: number;
}

export interface UsageCountsAccountRow {
  account_id: string;
  account_name: string;
  counts: UsageCounts;
}

export interface UsageCountsTenantRow {
  tenant_id: string;
  tenant_name: string;
  /** Exact sum of `accounts[].counts`. */
  counts: UsageCounts;
  /** Accounts with any activity in the window. */
  accounts: UsageCountsAccountRow[];
}

export interface UsageCountsResponse {
  /** Echoed, as applied. */
  from: string;
  to: string;
  /** Exact sum of `tenants[].counts`. */
  totals: UsageCounts;
  /** Tenants with any activity in the window. */
  tenants: UsageCountsTenantRow[];
}
