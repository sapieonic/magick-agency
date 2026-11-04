import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgencyInsightsActivity, AgencyInsightsAgentActivityRow } from '../../../../types/agency-insights';
import { formatCount, pct } from '../../../../utils/format/number';
import { durationWords } from '../../../../utils/format/duration';
import {
  average,
  agentConnectRate,
  occupancy,
  rateText,
  rateValue,
  successRate,
} from '../../../../utils/agency/insights/rates';
import { agentLink, attemptsLink, type InsightsAttemptsFilter } from '../../../../utils/agency/insights/links';
import { insightsCsvFilename } from '../../../../utils/agency/insights/csv';
import { CountLink, CsvButton, InsightsTable, Panel, tableCsv, type InsightsColumn } from './InsightsParts';
import type { RangeSectionContext } from './ActivitySections';
import styles from './Insights.module.css';

type Row = AgencyInsightsAgentActivityRow;

function breakSeconds(row: Row): number {
  return Object.values(row.state_seconds.break_by_reason).reduce((sum, n) => sum + n, 0);
}

function breakTitle(row: Row): string | undefined {
  const parts = Object.entries(row.state_seconds.break_by_reason)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason.replace(/_/g, ' ')} ${durationWords(n)}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** The "no agent" row (dials placed with no reserved agent session) is named, never linked. */
export const NO_AGENT_LABEL = 'No agent (dials with no agent session)';

function agentLabel(row: Row, ctx: RangeSectionContext): string {
  if (row.agent_user_id === null) return NO_AGENT_LABEL;
  return row.agent_name ?? ctx.agentName(row.agent_user_id);
}

function handleSeconds(row: Row): number | null {
  const talk = average(row.talk_seconds, row.connected);
  if (talk === null) return null;
  return talk + (average(row.wrapup_seconds, row.wrapup_measured) ?? 0);
}

/**
 * The leaderboard order: most successes, then the better connect rate, then
 * the most dials. A rate that is withheld ranks below any measured one.
 */
export function leaderboard(rows: Row[]): Row[] {
  return rows.slice().sort((a, b) =>
    b.successes - a.successes
    || (rateValue(agentConnectRate(b)) ?? -1) - (rateValue(agentConnectRate(a)) ?? -1)
    || b.dials - a.dials,
  );
}

export function AgentsSection({ ctx, activity }: { ctx: RangeSectionContext; activity: AgencyInsightsActivity }) {
  const [ranked, setRanked] = useState(false);
  const rows = ranked ? leaderboard(activity.agents) : activity.agents;
  const rank = new Map(leaderboard(activity.agents).map((row, index) => [row.agent_user_id, index + 1]));
  const { campaignId, range } = ctx;
  /** An agent's count, linked to their dials; the no-agent row has no list to open (no filter selects it). */
  const agentCount = (row: Row, filter: InsightsAttemptsFilter, value: number, label: string) => (row.agent_user_id === null
    ? formatCount(value)
    : <CountLink to={attemptsLink(campaignId, { ...filter, agent_user_id: row.agent_user_id })} value={value} label={label} />);

  const columns: InsightsColumn<Row>[] = [
    {
      key: 'agent',
      header: 'Agent',
      render: (row) => (
        <>
          {ranked ? <span className={styles.muted}>{`${rank.get(row.agent_user_id)}. `}</span> : null}
          {row.agent_user_id === null
            ? agentLabel(row, ctx)
            : <Link to={agentLink(campaignId, row.agent_user_id)}>{agentLabel(row, ctx)}</Link>}
        </>
      ),
      csv: (row) => agentLabel(row, ctx),
    },
    { key: 'online', header: 'Online', numeric: true, render: (r) => durationWords(r.online_seconds), csv: (r) => r.online_seconds },
    { key: 'available', header: 'Available', numeric: true, render: (r) => durationWords(r.state_seconds.available), csv: (r) => r.state_seconds.available },
    { key: 'on_call', header: 'On a call', numeric: true, render: (r) => durationWords(r.state_seconds.on_call), csv: (r) => r.state_seconds.on_call },
    { key: 'wrapup', header: 'Wrap-up', numeric: true, render: (r) => durationWords(r.state_seconds.wrapup), csv: (r) => r.state_seconds.wrapup },
    {
      key: 'break',
      header: 'Break',
      numeric: true,
      render: (r) => <span title={breakTitle(r)}>{durationWords(breakSeconds(r))}</span>,
      csv: (r) => breakSeconds(r),
    },
    {
      key: 'occupancy',
      header: 'Occupancy',
      numeric: true,
      render: (r) => {
        const value = occupancy(r);
        return value === null ? '—' : pct(value);
      },
      csv: (r) => occupancy(r),
    },
    {
      key: 'dials',
      header: 'Dials',
      numeric: true,
      render: (r) => agentCount(r, { ...range }, r.dials, 'dials'),
      csv: (r) => r.dials,
    },
    {
      key: 'connected',
      header: 'Connected',
      numeric: true,
      render: (r) => agentCount(r, { ...range, outcome: 'connected', redial: false }, r.connected, 'connected calls'),
      csv: (r) => r.connected,
    },
    { key: 'connect_rate', header: 'Connect rate', numeric: true, render: (r) => rateText(agentConnectRate(r)), csv: (r) => rateValue(agentConnectRate(r)) },
    { key: 'successes', header: 'Successes', numeric: true, render: (r) => formatCount(r.successes), csv: (r) => r.successes },
    {
      key: 'success_rate',
      header: 'Success rate',
      numeric: true,
      render: (r) => rateText(successRate(r.successes, r.conversations)),
      csv: (r) => rateValue(successRate(r.successes, r.conversations)),
    },
    {
      key: 'aht',
      header: 'Avg handle',
      numeric: true,
      render: (r) => {
        const value = handleSeconds(r);
        return value === null ? '—' : durationWords(value);
      },
      csv: (r) => handleSeconds(r),
    },
    {
      key: 'redials',
      header: 'Redials',
      numeric: true,
      render: (r) => agentCount(r, { ...range, redial: true }, r.redials, 'redials'),
      csv: (r) => r.redials,
    },
    { key: 'retries', header: 'Retries', numeric: true, render: (r) => formatCount(r.retries), csv: (r) => r.retries },
    { key: 'overrides', header: 'Overrides', numeric: true, render: (r) => formatCount(r.overrides), csv: (r) => r.overrides },
  ];

  return (
    <Panel
      id="agents"
      title="Agents"
      sub={`${ctx.rangeLabel} · time in each state, occupancy and results`}
      actions={
        <>
          <label className={styles.toggle}>
            <input type="checkbox" checked={ranked} onChange={(e) => setRanked(e.target.checked)} />
            Leaderboard
          </label>
          <CsvButton filename={insightsCsvFilename(ctx.campaignName, 'agents', campaignId)} build={() => tableCsv(columns, rows)} />
        </>
      }
    >
      {activity.agents.length === 0 ? (
        <p className={styles.muted}>No agent worked this campaign in this range.</p>
      ) : (
        <InsightsTable
          // Remounted on the toggle, so a column sort chosen before does not
          // reorder the leaderboard.
          key={ranked ? 'ranked' : 'plain'}
          caption={ranked ? 'Agents ranked by successes' : 'Agents on this campaign'}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.agent_user_id ?? 'no-agent'}
          sortable={!ranked}
          testId="agents-table"
        />
      )}
      {activity.never_joined.length > 0 ? (
        <p className={styles.muted} data-testid="never-joined">
          {`Staffed but never joined in this range: ${activity.never_joined.map((id) => ctx.agentName(id)).join(', ')}`}
        </p>
      ) : null}
    </Panel>
  );
}
