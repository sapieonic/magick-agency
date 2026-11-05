import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAsyncResource, type AsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../contexts/TenantContext';
import {
  getInsightsActivity,
  getInsightsAllocation,
  getInsightsHealth,
  getInsightsReadiness,
  getInsightsSummary,
  getInsightsTrends,
  getInsightsUploads,
} from '../api/agencyInsights';
import { useVisibleInterval } from './useVisibleInterval';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { INSIGHTS_REFRESH_MS, insightsShouldPoll } from '../utils/agency/insights/polling';
import { insightsRangeQuery, type InsightsResolvedRange } from '../utils/agency/insights/range';
import type {
  AgencyInsightsActivity,
  AgencyInsightsAllocation,
  AgencyInsightsBucket,
  AgencyInsightsHealth,
  AgencyInsightsReadiness,
  AgencyInsightsSummary,
  AgencyInsightsTrends,
  AgencyInsightsUploads,
} from '../types/agency-insights';

/**
 * The Insights tab's data, in two halves that refresh on different rules.
 *
 * ── As of now: polled ───────────────────────────────────────────────────────
 * `summary` and `allocation` are positions, and they poll every 10 s while the
 * campaign is moving (`insightsShouldPoll`: running, stopping, or paused with
 * calls still finishing), visible tabs only and one tick at a time
 * (`useVisibleInterval`). `readiness` is read for a draft only; `uploads` once.
 * None of these is ever polled on a draft or a finished campaign.
 *
 * ── Over a range: never polled ──────────────────────────────────────────────
 * `activity`, `trends` and `health` are aggregates over a range of up to 92
 * days. They load once the page has painted its as-of-now numbers (`active`),
 * and again only when the range or the bucket changes or Refresh is pressed
 * (`refreshToken`): re-reading a quarter of a year every ten seconds would move
 * nothing a supervisor can see.
 *
 * Both halves keep what is on screen while a newer read is in flight
 * (`useAsyncResource` keeps `data` on a reload), so a poll never flashes a
 * spinner over the numbers it is replacing.
 */

export interface InsightsLive {
  summary: AsyncResource<AgencyInsightsSummary | null>;
  allocation: AsyncResource<AgencyInsightsAllocation | null>;
  readiness: AsyncResource<AgencyInsightsReadiness | null>;
  uploads: AsyncResource<AgencyInsightsUploads | null>;
  /** The as-of-now reads are polling. */
  polling: boolean;
  /** When the summary last answered. */
  lastUpdatedAt: Date | null;
  /** Re-read every as-of-now section. */
  refresh: () => Promise<void>;
}

export function useInsightsLive(campaignId: string | undefined): InsightsLive {
  const { tenantId, accountId } = useTenant();
  const ready = Boolean(campaignId && tenantId && accountId);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const fetchSummary = useCallback(async () => {
    const summary = await getInsightsSummary(campaignId as string, tenantId ?? undefined, accountId ?? undefined);
    setLastUpdatedAt(new Date());
    return summary;
  }, [campaignId, tenantId, accountId]);
  const fetchAllocation = useCallback(
    () => getInsightsAllocation(campaignId as string, tenantId ?? undefined, accountId ?? undefined),
    [campaignId, tenantId, accountId],
  );
  const fetchReadiness = useCallback(
    () => getInsightsReadiness(campaignId as string, tenantId ?? undefined, accountId ?? undefined),
    [campaignId, tenantId, accountId],
  );
  const fetchUploads = useCallback(
    () => getInsightsUploads(campaignId as string, tenantId ?? undefined, accountId ?? undefined),
    [campaignId, tenantId, accountId],
  );

  const summary = useAsyncResource<AgencyInsightsSummary | null>(fetchSummary, {
    initialData: null,
    enabled: ready,
    errorMessage: 'Could not load this campaign’s insights.',
  });
  const allocation = useAsyncResource<AgencyInsightsAllocation | null>(fetchAllocation, {
    initialData: null,
    enabled: ready,
    errorMessage: 'Could not load the allocation.',
  });
  // A draft's checklist only. The status comes from the summary, so this waits for it.
  const isDraft = summary.data?.status === 'draft';
  const readiness = useAsyncResource<AgencyInsightsReadiness | null>(fetchReadiness, {
    initialData: null,
    enabled: ready && isDraft,
    errorMessage: 'Could not load the launch checklist.',
  });
  const uploads = useAsyncResource<AgencyInsightsUploads | null>(fetchUploads, {
    initialData: null,
    enabled: ready,
    errorMessage: 'Could not load the upload history.',
  });

  const polling = insightsShouldPoll(summary.data);

  // Read through refs so the interval and the return handler never call a stale reload.
  const live = useRef({ summary, allocation, readiness, uploads });
  live.current = { summary, allocation, readiness, uploads };

  const tick = useCallback(
    () => Promise.all([live.current.summary.reload(), live.current.allocation.reload()]).then(() => undefined),
    [],
  );
  useVisibleInterval(tick, INSIGHTS_REFRESH_MS, polling);
  // A tab that comes back from the background catches up at once, polled or not.
  useRefetchOnReturn(() => (ready ? tick() : undefined));

  const refresh = useCallback(async () => {
    const { summary: s, allocation: a, readiness: r, uploads: u } = live.current;
    await Promise.all([s.reload(), a.reload(), r.reload(), u.reload()]);
  }, []);

  return { summary, allocation, readiness, uploads, polling, lastUpdatedAt, refresh };
}

export interface InsightsRangeData {
  activity: AsyncResource<AgencyInsightsActivity | null>;
  trends: AsyncResource<AgencyInsightsTrends | null>;
  health: AsyncResource<AgencyInsightsHealth | null>;
  /** Any of the three is still loading (or has not started). */
  loading: boolean;
}

/**
 * The three range reads. `active` is false until the page has painted; a range
 * with an `error` (a custom range that cannot be sent) fetches nothing.
 * `refreshToken` is bumped by Refresh and never by the poll.
 */
export function useInsightsRange(
  campaignId: string | undefined,
  range: InsightsResolvedRange | null,
  bucket: AgencyInsightsBucket,
  active: boolean,
  refreshToken: number,
): InsightsRangeData {
  const { tenantId, accountId } = useTenant();
  const enabled = Boolean(active && campaignId && tenantId && accountId && range && !range.error);
  const from = range?.from;
  const to = range?.to;
  const lifetime = range?.lifetime ?? true;

  // The instants are the identity: the caller rebuilds the range object, and a
  // fresh object with the same instants must not refetch.
  const query = useMemo(
    () => insightsRangeQuery({ lifetime, from, to } as InsightsResolvedRange),
    [from, to, lifetime],
  );

  const t = tenantId ?? undefined;
  const a = accountId ?? undefined;
  const fetchActivity = useCallback(
    () => getInsightsActivity(campaignId as string, query, t, a),
    // `refreshToken` is a dependency on purpose: a new fetcher identity is a reload.
    [campaignId, query, t, a, refreshToken],
  );
  const fetchTrends = useCallback(
    () => getInsightsTrends(campaignId as string, query, bucket, t, a),
    [campaignId, query, bucket, t, a, refreshToken],
  );
  const fetchHealth = useCallback(
    () => getInsightsHealth(campaignId as string, query, t, a),
    [campaignId, query, t, a, refreshToken],
  );

  const activity = useAsyncResource<AgencyInsightsActivity | null>(fetchActivity, {
    initialData: null,
    enabled,
    errorMessage: 'Could not load calls and outcomes.',
  });
  const trends = useAsyncResource<AgencyInsightsTrends | null>(fetchTrends, {
    initialData: null,
    enabled,
    errorMessage: 'Could not load the trends.',
  });
  const health = useAsyncResource<AgencyInsightsHealth | null>(fetchHealth, {
    initialData: null,
    enabled,
    errorMessage: 'Could not load health and compliance.',
  });

  return { activity, trends, health, loading: activity.loading || trends.loading || health.loading };
}

/**
 * Flip to true once, right after the first paint that has `ready` set. The range
 * sections wait for it so the cheap as-of-now numbers are on screen first.
 * `force` (Print) flips it at once.
 */
export function useAfterFirstPaint(ready: boolean, force: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (active) return;
    if (force) {
      setActive(true);
      return;
    }
    if (!ready) return;
    // An effect runs after the browser has painted the render that set `ready`.
    setActive(true);
  }, [ready, force, active]);
  return active;
}
