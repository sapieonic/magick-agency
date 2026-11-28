import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import type { AgencyTeamPerformanceQuery } from '@magick-agency/contracts/api/agency/team-performance';
import { useTenant } from '../../contexts/TenantContext';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { COMPARE_SETTLE_MS } from '../../hooks/useCompareRead';
import { useTeamPerformance } from '../../hooks/useTeamPerformance';
import { useHeldCampaigns } from '../../hooks/useHeldCampaigns';
import { useZoneToday } from '../../hooks/useZoneToday';
import { hasPermission } from '../../utils/permissions';
import { pickerCampaignName } from '../../utils/agencyCampaignArchive';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { ExportReportButton } from '../../components/agency/reports/ExportReportButton';
import { COMPARE_FLAG } from '../../utils/agency/compare/compareFlag';
import { TEAM_PERFORMANCE_FLAG } from '../../utils/agency/team/teamPerformanceFlag';
import {
  comparePickedPath,
  teamStateFromParams,
  teamStateToParams,
  teamWindowDates,
  answerRunsToNow,
  teamWindowError,
  togglePick,
  windowAutoRefreshes,
  windowShorterThanWeek,
  type TeamUrlState,
  type TeamWindowPreset,
} from '../../utils/agency/team/teamUrl';
import { asOfWords, datesWords, mainLabel, periodWords, refreshFailedWords, staleWords } from '../../utils/agency/team/teamCopy';
import { browserZone } from '../../utils/reports/reportWindow';
import { TeamFilters } from '../../components/agency/team/TeamFilters';
import { TeamTiles, TeamTilesSkeleton } from '../../components/agency/team/TeamTiles';
import { MainOutcomePerDayChart } from '../../components/agency/team/MainOutcomePerDayChart';
import { OutcomeBreakdown } from '../../components/agency/team/OutcomeBreakdown';
import { TeamAgentsTable } from '../../components/agency/team/TeamAgentsTable';
import { TeamReadError } from '../../components/agency/team/TeamReadError';
import { teamErrors } from '../../api/teamPerformance';
import teamStyles from '../../components/agency/team/Team.module.css';
import styles from './TeamPerformancePage.module.css';

/**
 * Team performance (`docs/team-performance.md`): Reports' first tab, where a supervisor sees how
 * the whole team did over a period, on one campaign or across all of them. Supervisors only (TP3,
 * `agency.supervise`), behind `agency_team_performance_enabled`; the route's `RequireFlag` already
 * gates it and the flag is read again here so the page fails closed when mounted without its
 * route.
 *
 * The campaign, the window and the sort are in the URL (`teamUrl.ts`); the picks for Compare
 * picked are not, and clear when a filter changes (TP18).
 */
export default function TeamPerformancePage() {
  const { role, tenantId, accountId, accounts } = useTenant();
  const enabled = useFeatureFlagEnabled(TEAM_PERFORMANCE_FLAG);
  const canCompare = useFeatureFlagEnabled(COMPARE_FLAG);

  if (role === undefined) return <LoadingSpinner />;
  if (!enabled || !hasPermission(role, 'agency.supervise')) return <CapabilityUnavailable />;
  if (!tenantId || !accountId) return <LoadingSpinner />;
  return (
    <TeamPerformanceView
      tenantId={tenantId}
      accountId={accountId}
      accountName={accounts?.find((a) => a.id === accountId)?.name ?? null}
      canCompare={canCompare}
    />
  );
}

export interface TeamPerformanceViewProps {
  tenantId: string;
  accountId: string;
  /** The account report's subject name (Download Excel with All campaigns). */
  accountName: string | null;
  /** `agency_compare_enabled`: the pick boxes and Compare picked are offered (TP18). */
  canCompare: boolean;
  /** Injectable for tests: the clock "today" is read from. */
  now?: Date;
  /** Injectable for tests: how long the filters must stay still before the read is asked. */
  settleMs?: number;
}

export function TeamPerformanceView({ tenantId, accountId, accountName, canCompare, now, settleMs = COMPARE_SETTLE_MS }: TeamPerformanceViewProps) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => teamStateFromParams(params), [params]);
  const update = useCallback(
    (patch: Partial<TeamUrlState>) =>
      setParams((prev) => teamStateToParams({ ...teamStateFromParams(prev), ...patch }), { replace: true }),
    [setParams],
  );
  const [zone] = useState(browserZone);
  const today = useZoneToday(zone, now);
  const { campaigns, heldArchived, campaignNamed } = useHeldCampaigns(tenantId, accountId, state.campaignId);

  // ── The window and the read ──
  const dates = teamWindowDates(state, today);
  const dateError = teamWindowError(dates, today);
  const window = dateError === null ? dates : null;
  const query: AgencyTeamPerformanceQuery | null = window
    ? { from: window.from, to: window.to, timezone: zone, ...(state.campaignId ? { campaign_id: state.campaignId } : {}) }
    : null;
  // A window that holds today and spans at most a week is read again on its own (§2 States).
  const autoRefresh = windowAutoRefreshes(window, today);
  const read = useTeamPerformance(query, { tenantId, accountId, autoRefresh, today, settleMs });
  const data = read.data;
  const label = data ? mainLabel(data.main_outcome) : 'Will pay';
  // How far the figures run is the answer's (TP11), not the clock's: an answer read before
  // midnight still runs to then after it.
  const reach = data ? { runsToNow: answerRunsToNow(data), oneDay: data.from === data.to } : { runsToNow: false, oneDay: false };

  // ── Picks: not in the URL, cleared whenever the question changes (TP18): a filter, or a preset's
  // dates moving at midnight. The sort is not part of it. ──
  const [picks, setPicks] = useState<string[]>([]);
  const question = query ? `${query.from}/${query.to}/${query.campaign_id ?? ''}` : null;
  useEffect(() => setPicks([]), [question]);

  const setWindow = (preset: TeamWindowPreset) =>
    update(preset === 'custom' ? { window: preset, from: dates?.from ?? today, to: dates?.to ?? today } : { window: preset, from: null, to: null });

  const chosen = campaignNamed(state.campaignId);
  const exportTarget = state.campaignId
    ? {
        kind: 'campaign' as const,
        subject: { id: state.campaignId, name: chosen?.name ?? null },
        campaignTimezone: chosen?.default_timezone ?? null,
      }
    : { kind: 'account' as const, subject: { id: accountId, name: accountName } };

  const empty = data !== null && read.current && data.agents.length === 0 && data.totals.calls_handled === 0;
  // `failed` holds only when the answer on screen is not the current question's.
  const stale = data !== null && read.failed;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Team performance"
        subtitle="How the whole team did, on one campaign or all of them."
        actions={
          <ExportReportButton
            entry="team_performance"
            label="Download Excel"
            target={exportTarget}
            initial={{ ...(window ? { from: window.from, to: window.to } : {}), formats: { pdf: false, xlsx: true } }}
          />
        }
      />

      <TeamFilters
        campaigns={campaigns}
        campaignId={state.campaignId}
        heldName={heldArchived ? pickerCampaignName(heldArchived) : 'This campaign'}
        onCampaign={(campaignId) => update({ campaignId })}
        when={state.window}
        from={state.from}
        to={state.to}
        today={today}
        onWindow={setWindow}
        onDates={update}
        dateError={dateError}
        summary={data && read.current && window ? asOfWords(state.window, window, data.as_of, reach.runsToNow) : null}
      />

      {read.failed ? <TeamReadError error={read.error} onRetry={read.retry} /> : null}
      {stale ? (
        <p className={teamStyles.note} role="status" data-testid="team-stale">
          {staleWords(data, {
            differs: data.campaign_id !== state.campaignId,
            all: data.campaign_id === null,
            name: campaignNamed(data.campaign_id)?.name ?? null,
          })}
        </p>
      ) : null}
      {/* A failed quiet refresh keeps the figures up and says so calmly (no alert): the next tick
          tries again, or, once refreshing has stopped (a timeout), the reader can. */}
      {read.refreshFailed && data !== null ? (
        <div className={`${teamStyles.note} ${teamStyles.errorBox}`} role="status" data-testid="team-refresh-failed">
          <p className={teamStyles.errorText}>{refreshFailedWords(data.as_of)}</p>
          {/* Try again when nothing else will read: refreshing has stopped, or this window is not
              read again on its own (the one read once more after its last day). */}
          {(read.refreshStopped || !autoRefresh) && teamErrors.isRetryable(read.error) ? (
            <button type="button" className={teamStyles.linkButton} onClick={read.retry} data-testid="team-retry">
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {read.updating && data !== null ? (
        <p className={teamStyles.updating} role="status" data-testid="team-updating">
          Updating…
        </p>
      ) : null}

      {data === null && query !== null && !read.failed ? (
        <div aria-busy="true" aria-label="Loading the team’s figures">
          <TeamTilesSkeleton />
        </div>
      ) : null}

      {empty ? (
        <div className={styles.answer}>
          <EmptyState
            icon={<Users size={32} />}
            title="No calls in this period"
            description={state.campaignId ? 'Nobody took a dialler call on this campaign in this period.' : 'Nobody took a dialler call in this period.'}
            action={
              // More days only where the window is shorter than the last 7 days.
              windowShorterThanWeek(window) ? (
                <button type="button" className="btn-secondary" onClick={() => setWindow('last_7_days')} data-testid="team-try-7-days">
                  Show the last 7 days
                </button>
              ) : undefined
            }
          />
          {/* The team's earlier working days are still drawn (TP12, TP14): a window holding today
              with nobody dialled yet shows the days before it. */}
          {data.trend.dates.length > 0 ? <MainOutcomePerDayChart trend={data.trend} label={label} /> : null}
        </div>
      ) : null}

      {data !== null && !empty ? (
        <div className={styles.answer} aria-busy={read.updating || undefined}>
          <TeamTiles data={data} label={label} reach={reach} />
          <div className={styles.charts}>
            <MainOutcomePerDayChart trend={data.trend} label={label} />
            <OutcomeBreakdown data={data} label={label} preset={state.window} />
          </div>
          <TeamAgentsTable
            data={data}
            label={label}
            period={window ? periodWords(state.window, window) : datesWords(data)}
            sort={state.sort}
            onSort={(sort) => update({ sort })}
            canCompare={canCompare}
            // Picks are made from the answer to the filters on screen only: rows kept up while a new
            // question loads, or after it failed, belong to other filters (TP18).
            canPickNow={read.current}
            picks={picks}
            onTogglePick={(id) => setPicks((prev) => togglePick(prev, id))}
            onComparePicked={() => {
              if (read.current && data.campaign_id && picks.length > 0) navigate(comparePickedPath(state, data.campaign_id, picks));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
