import { useMemo } from 'react';
import { getAgencyGroupedStats } from '../api/agencyStats';
import { todayByCampaign, todayTotals, type TodayTotals } from '../utils/agency/home';
import { useDailyRead } from './useDailyRead';

/** The grouped read's own ceiling (1..1000): one row per campaign that dialled today. */
export const TODAY_ROW_LIMIT = 1000;

export type TodayState =
  | { status: 'loading' }
  /**
   * `day`: the viewer's local day the totals are for (`localDay`). `byCampaign`: each campaign's
   * own totals, for Live floor's campaign filter; a campaign that dialled nothing has no entry.
   */
  | { status: 'ready'; totals: TodayTotals; byCampaign: Record<string, TodayTotals>; day: string }
  /** The read failed, or the server held rows back: nothing honest to print. */
  | { status: 'unavailable' };

/** The grouped read summed; null when the server held rows back (a partial sum is not a total). */
async function readToday(window: { from: string; to: string }, tenantId: string, accountId: string) {
  const page = await getAgencyGroupedStats({ ...window, group_by: ['campaign'], limit: TODAY_ROW_LIMIT }, tenantId, accountId);
  const totals = todayTotals(page);
  const byCampaign = todayByCampaign(page);
  return totals && byCampaign ? { totals, byCampaign } : null;
}

/**
 * Today so far for the whole account: ONE grouped read
 * (`GET /proxy/agency/agents/grouped-stats`, `group_by=campaign`, the viewer's local midnight to
 * now), the same read and the same counters as a campaign's contribution total. `agency.supervise`,
 * which Home's gate already requires.
 *
 * Polled by `useDailyRead`'s rules: one read at a time (a new scope reads at once, and an older
 * read that answers after it is ignored); on the minute and on a return to the tab only once the
 * totals are a minute old (a switch of tab fires both `focus` and `visibilitychange`, and each would
 * otherwise be an account-wide read of up to 1000 rows); a failed refresh keeps today's totals,
 * never yesterday's; read again at local midnight. A 403 is a failed read like any other here.
 */
export function useTodaySoFar(tenantId: string | null | undefined, accountId: string | null | undefined, enabled: boolean): TodayState {
  const { state } = useDailyRead({ tenantId, accountId, enabled, read: readToday });
  return useMemo(
    () => (state.status === 'ready' ? { status: 'ready', ...state.value, day: state.day } : state),
    [state],
  );
}
