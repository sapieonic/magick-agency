/**
 * **NEW.** The promises to pay recorded in an account over a window, per campaign (decision B28b;
 * promises themselves are PT1–PT14, `../../agency/promise.ts`): the Live floor's "Will pay" tile and
 * each campaign card's count. `GET /proxy/agency/promises/summary?from=<instant>&to=<instant>`.
 *
 * - **Gate:** `agency.supervise`, then the account scope (`400 account_scope_required`), then the
 *   dialer flag (`403 feature_disabled`), as Home's board.
 * - **Query:** `from` and `to`, ISO-8601 instants with their offsets, `from < to`, at most
 *   {@link AGENCY_PROMISES_SUMMARY_MAX_DAYS} days apart. Anything else is `400` with code
 *   {@link AGENCY_PROMISES_QUERY_ERROR_CODE}.
 * - **What counts:** every call of the account that carries a promise (a promised date, PT1) whose
 *   outcome was written in `[from, to)` (`dispositioned_at`): a dialler attempt, a soft-phone call
 *   and an inbound call alike. A same-code replay that corrects a promise moves it to the replay's
 *   time (the outcome is last-write-wins, PT1). Grouped by the call's campaign: an attempt's, a
 *   soft-phone call's tag, an inbound call's matched campaign; `null` for a call with none.
 * - **No currency:** none is stored with a promise (PT5). The amount is a bare decimal.
 */

/** The widest `[from, to)` the summary accepts, in days. */
export const AGENCY_PROMISES_SUMMARY_MAX_DAYS = 31;

/** The 400 `code` of a summary whose query the server refuses (body `{ error, code, message }`). */
export const AGENCY_PROMISES_QUERY_ERROR_CODE = 'invalid_promises_query';

/** `GET /promises/summary`. */
export interface AgencyPromisesSummaryQuery {
  /** ISO-8601 instant, inclusive. */
  from: string;
  /** ISO-8601 instant, exclusive. */
  to: string;
}

/** One campaign's promises in the window. */
export interface AgencyPromisesSummaryCampaign {
  /** The calls' campaign; null for the calls with none (an untagged soft-phone call, an unmatched inbound call). */
  campaign_id: string | null;
  /** Promises recorded. */
  promises: number;
  /** Of them, the ones with an amount. */
  with_amount: number;
  /**
   * The sum of their amounts, exact (summed as `NUMERIC` in SQL, never through a float), as a
   * decimal string with two places (`"240000.00"`; `"0.00"` when none had an amount).
   */
  amount_total: string;
}

/** `GET /promises/summary`. */
export interface AgencyPromisesSummaryResponse {
  /** One row per campaign (and one for no campaign) with any promise in the window; none without. By `campaign_id`, the null row last. */
  campaigns: AgencyPromisesSummaryCampaign[];
  /**
   * The account's ACTIVE campaigns (`running`, `stopping`, `paused`) whose outcome catalog has an
   * entry with `requires_promise`. Empty: no active campaign records promises (the console shows
   * Successes in place of Will pay).
   */
  promise_campaign_ids: string[];
  /** The window served, echoed as ISO-8601 (UTC). */
  from: string;
  to: string;
}
