/**
 * The campaign report (`kind: 'campaign'`, supervisor audience only): the campaign Insights
 * tab's numbers over the window, as the tab's own wire objects (docs/insights.md), cut in the
 * campaign's zone (RP3).
 *
 * The four Insights reads are embedded VERBATIM, filled by the same `compute*` reads the routes
 * use, over `[range.start, range.end)`:
 * - `summary` is "as of now" by its nature (header, settings, status headline, roster states):
 *   it describes the campaign at `generated_at`, not over the window, and the report says so.
 * - `activity`, `trends` and `health` are range reads. `trends` is read with `bucket: 'day'`, so
 *   `trends.buckets` has one row per local day (`range.days` rows); its `best_hours` is the
 *   hour-of-day block (0–23, in each contact's zone), so there is no separate hourly series.
 *
 * Insights serves counts only: the renderer derives every rate from the counts beside it, and
 * withholds it below `floors.campaign_rate_min_first_dials` (RP9).
 */
import type { AgencyCampaignStatus } from '../agency/enums';
import type {
  AgencyInsightsActivity,
  AgencyInsightsHealth,
  AgencyInsightsSummary,
  AgencyInsightsTrends,
} from '../api/agency/insights';
import type { ReportDatasetBase } from './dataset';

export interface CampaignReportDataset extends ReportDatasetBase {
  kind: 'campaign';
  audience: 'supervisor';
  campaign: {
    id: string;
    name: string;
    /** As of `generated_at`. */
    status: AgencyCampaignStatus;
    /**
     * The campaign's resolved zone; equals `range.timezone`. A campaign whose zone changed after
     * the report was requested fails the run `subject_changed` rather than serve a window cut
     * in one zone with day buckets cut in another.
     */
    timezone: string;
  };
  summary: AgencyInsightsSummary;
  activity: AgencyInsightsActivity;
  /** Day buckets (`bucket: 'day'`), with `best_hours`. */
  trends: AgencyInsightsTrends;
  health: AgencyInsightsHealth;
  /**
   * Display names for every agent id the embedded objects carry without one
   * (`activity.callbacks.by_owner`, `activity.overrides[].by_agent`, `activity.dnc_marked.by_agent`,
   * `activity.never_joined`), and for those that do. Value null when the user no longer resolves:
   * the renderer prints the id, marked as one. Every non-null agent id in the embedded objects
   * is a key.
   */
  agent_names: Record<string, string | null>;
  floors: {
    /**
     * Insights' floor (`AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR`, 25, RP9): a campaign rate whose
     * denominator (first dials for the connect rate, conversations for the success rate,
     * answered calls for abandonment) is below it renders as words.
     */
    campaign_rate_min_first_dials: number;
  };
}
