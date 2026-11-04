import type { AgencyInsightsSummary } from '../../../types/agency-insights';

/** How often the as-of-now reads (summary, allocation) are polled while anything moves. */
export const INSIGHTS_REFRESH_MS = 10_000;

/**
 * Whether the Insights tab's as-of-now reads poll.
 *
 * Running and stopping campaigns are moving by definition. A paused campaign
 * places no new calls but its live ones run to their end, so it polls while the
 * headline still counts calls finishing, and stops the moment they have. A draft
 * has nothing moving, and a stopped or completed campaign never moves again: no
 * read is spent on either. Before the first summary arrives there is nothing to
 * decide on, so nothing polls (the first load is not a poll).
 */
export function insightsShouldPoll(summary: Pick<AgencyInsightsSummary, 'status' | 'headline'> | null): boolean {
  if (!summary) return false;
  switch (summary.status) {
    case 'running':
    case 'stopping':
      return true;
    case 'paused':
      return (summary.headline.paused?.calls_finishing ?? 0) > 0;
    default:
      return false;
  }
}
