import { Link } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, ArrowRight, CheckCircle2, Info } from 'lucide-react';
import type {
  AgencyInsightsActivity,
  AgencyInsightsAllocation,
  AgencyInsightsHealth,
  AgencyInsightsSummary,
} from '../../../../types/agency-insights';
import { campaignTabHref } from '../../../../utils/agencyCampaignTabs';
import { formatCount, plural } from '../../../../utils/format/number';
import { ceilingPctText } from '../../../../utils/agency/abandonmentCeiling';
import {
  abandonmentRate,
  callsConnectRate,
  penetrationRate,
  successRate,
} from '../../../../utils/agency/insights/rates';
import { attemptsLink, rosterBucketLink } from '../../../../utils/agency/insights/links';
import {
  agentsTeaser,
  callsTeaser,
  healthTeaser,
  type Attention,
  type AttentionTone,
  type TabTeaser,
} from '../../../../utils/agency/insights/overview';
import type { RangeSectionContext } from './ActivitySections';
import { CountLink, Kpi, Panel, rateFigure } from './InsightsParts';
import styles from './Insights.module.css';
import { StatGrid } from '../../../../components/common/StatGrid';

/**
 * The Overview tab's own parts (decision IN13): the headline numbers, what needs
 * the supervisor, and a card per tab that says what is on it. The headline card
 * and the roster sit beside these; every detail table lives on its own tab.
 */

/**
 * Why a read has nothing to show — an invalid range, or a read that failed — or
 * null while it is fine or still loading. A figure says "—" and a card says why,
 * rather than waiting for a read that is not coming.
 */
export interface OverviewUnavailable {
  activity: string | null;
  health: string | null;
  allocation: string | null;
}

/**
 * Six figures across the top. Each says whether it is a position ("now") or
 * follows the range, so nobody has to work out which number the picker moves.
 */
export function OverviewKpis({
  ctx,
  summary,
  allocation,
  activity,
  health,
  unavailable,
}: {
  ctx: RangeSectionContext;
  summary: AgencyInsightsSummary;
  allocation: AgencyInsightsAllocation | null;
  activity: AgencyInsightsActivity | null;
  health: AgencyInsightsHealth | null;
  unavailable: OverviewUnavailable;
}) {
  const { campaignId, range, rangeLabel } = ctx;
  const roster = summary.roster;
  const reached = rateFigure(penetrationRate(roster), 'contacts');
  const calls = activity?.calls ?? null;
  const connect = calls ? rateFigure(callsConnectRate(calls)) : null;
  const success = calls ? rateFigure(successRate(calls.successes, calls.conversations)) : null;
  const abandonment = health ? rateFigure(abandonmentRate(health.abandonment.rolling_24h)) : null;
  const overdue = allocation?.totals.callbacks_overdue ?? null;
  // Waiting, or a read that failed: the error itself is said once, above.
  const pending = (read: keyof OverviewUnavailable) => (unavailable[read] ? '—' : '…');

  return (
    <StatGrid testId="overview-kpis">
      <Kpi
        label="Reached · now"
        value={reached.value}
        withheld={reached.withheld}
        sub={<><CountLink to={rosterBucketLink(campaignId, 'attempted')} value={roster.attempted} label="contacts attempted" />{` of ${formatCount(roster.total)} dialled at least once`}</>}
        testId="overview-kpi-reached"
      />
      <Kpi
        label={`Dials · ${rangeLabel}`}
        value={calls ? <CountLink to={attemptsLink(campaignId, range)} value={calls.dials} label="dials" /> : pending('activity')}
        withheld={!calls}
        sub={calls ? 'Wrap-up redials included' : undefined}
        testId="overview-kpi-dials"
      />
      <Kpi
        label={`Connect rate · ${rangeLabel}`}
        value={connect ? connect.value : pending('activity')}
        withheld={!connect || connect.withheld}
        sub={calls ? `${formatCount(calls.connected)} connected calls` : undefined}
        testId="overview-kpi-connect"
      />
      <Kpi
        label={`Successes · ${rangeLabel}`}
        value={calls ? formatCount(calls.successes) : pending('activity')}
        withheld={!calls}
        sub={calls && success ? `${success.value} of ${formatCount(calls.conversations)} conversations` : undefined}
        testId="overview-kpi-successes"
      />
      <Kpi
        label="Callbacks overdue · now"
        value={overdue === null ? pending('allocation') : <span data-tone={overdue > 0 ? 'bad' : undefined} className={styles.toneValue}>{formatCount(overdue)}</span>}
        withheld={overdue === null}
        sub={allocation ? `${formatCount(allocation.totals.callbacks_due_today)} due later today` : undefined}
        testId="overview-kpi-callbacks"
      />
      <Kpi
        label="Abandonment · 24 h"
        value={abandonment ? abandonment.value : pending('health')}
        withheld={!abandonment || abandonment.withheld}
        sub={health ? `Ceiling ${ceilingPctText(health.abandonment.ceiling_pct)}` : undefined}
        testId="overview-kpi-abandonment"
      />
    </StatGrid>
  );
}

const TONE_ICON: Record<AttentionTone, typeof Info> = {
  danger: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
};

/** What needs the supervisor, most urgent first, each with the tab that answers it. */
export function AttentionPanel({
  attention,
  campaignId,
  search,
  loading,
  healthUnavailable,
}: {
  attention: Attention;
  campaignId: string;
  search: string;
  /** The health or allocation read is still out: the list may grow. */
  loading: boolean;
  /** The health checks could not run (an invalid range, a failed read): never an all-clear. */
  healthUnavailable: string | null;
}) {
  const { items, clear } = attention;
  const skipped = healthUnavailable ? (
    <p className={styles.attentionSkipped} data-testid="attention-skipped">
      <AlertTriangle size={14} aria-hidden="true" />
      {`The health checks (abandonment, carrier failures, recordings) did not run: ${healthUnavailable}`}
    </p>
  ) : null;
  return (
    <Panel
      id="attention"
      title="Needs your attention"
      sub={items.length === 0 ? undefined : `${plural(items.length, 'item')}, most urgent first`}
    >
      {items.length === 0 && skipped ? (
        skipped
      ) : items.length === 0 ? (
        <p className={styles.attentionNone} data-testid="attention-none">
          <CheckCircle2 size={16} aria-hidden="true" />
          {loading ? 'Checking…' : 'Nothing needs you right now.'}
        </p>
      ) : (
        <ul className={styles.attentionList} data-testid="attention-list">
          {items.map((item) => {
            const Icon = TONE_ICON[item.tone];
            return (
              <li key={item.id} className={styles.attentionItem} data-tone={item.tone} data-testid={`attention-${item.id}`}>
                <span className={styles.attentionIcon} aria-hidden="true"><Icon size={16} /></span>
                <div className={styles.attentionText}>
                  <p className={styles.attentionTitle}>{item.title}</p>
                  <p className={styles.attentionBody}>{item.body}</p>
                </div>
                <Link to={campaignTabHref(item.tab, campaignId, search)} className={`btn-secondary ${styles.toolButton}`}>
                  {item.action}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 ? skipped : null}
      {clear.length > 0 ? (
        <p className={styles.attentionClear} data-testid="attention-clear">
          <CheckCircle2 size={14} aria-hidden="true" />
          {`Clear: ${clear.join(', ')}.`}
        </p>
      ) : null}
    </Panel>
  );
}

function TeaserCard({ title, teaser, unavailable, to, testId }: { title: string; teaser: TabTeaser | null; unavailable: string | null; to: string; testId: string }) {
  return (
    <Link to={to} className={styles.teaser} data-testid={testId}>
      <span className={styles.teaserHead}>
        <span className={styles.panelTitle}>{title}</span>
        <ArrowRight size={15} aria-hidden="true" />
      </span>
      <span className={styles.teaserLine}>{teaser ? teaser.line1 : unavailable ?? 'Loading…'}</span>
      {teaser?.line2 ? <span className={styles.teaserLine2}>{teaser.line2}</span> : null}
    </Link>
  );
}

/** One card per detail tab, saying what is on it before it is opened. */
export function OverviewTeasers({
  campaignId,
  search,
  activity,
  allocation,
  health,
  unavailable,
}: {
  campaignId: string;
  search: string;
  activity: AgencyInsightsActivity | null;
  allocation: AgencyInsightsAllocation | null;
  health: AgencyInsightsHealth | null;
  unavailable: OverviewUnavailable;
}) {
  return (
    <nav className={styles.teasers} aria-label="More on this campaign">
      <TeaserCard title="Calls" teaser={activity ? callsTeaser(activity) : null} unavailable={unavailable.activity} to={campaignTabHref('calls', campaignId, search)} testId="teaser-calls" />
      <TeaserCard title="Agents" teaser={activity || allocation ? agentsTeaser(activity, allocation) : null} unavailable={unavailable.allocation && unavailable.activity} to={campaignTabHref('agents', campaignId, search)} testId="teaser-agents" />
      <TeaserCard title="Health" teaser={health ? healthTeaser(health) : null} unavailable={unavailable.health} to={campaignTabHref('health', campaignId, search)} testId="teaser-health" />
    </nav>
  );
}
