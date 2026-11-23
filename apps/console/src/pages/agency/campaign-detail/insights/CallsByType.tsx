import { Link } from 'react-router-dom';
import { AGENCY_CALLS_BY_TYPE_NO_RATE, AGENCY_OUTBOUND_CONNECT_RATE_LABEL } from '../../../../types/agency-call-log';
import type { AgencyInsightsActivity, AgencyInsightsOutcomeByTypeRow } from '../../../../types/agency-insights';
import { durationWords } from '../../../../utils/format/duration';
import { formatCount } from '../../../../utils/format/number';
import { toFollowUpLink } from '../../../../utils/agency/insights/links';
import {
  callsByType,
  outboundConnectRate,
  rateText,
  showInboundFigures,
  showSoftphoneFigures,
  type CallsByType,
  type CallsByTypeColumn,
} from '../../../../utils/agency/insights/rates';
import { InsightsTable, Panel, type InsightsColumn } from './InsightsParts';
import styles from './Insights.module.css';

/**
 * A campaign's **Calls by type** (`docs/call-log.md` §6): a column per call type the page shows
 * (Dialler, Soft phone, Inbound) and All calls, the counts added. Counts, people reached and
 * talk time add up. Rates never do (CL7): each type keeps its own under its own name, All calls
 * says "not added", and the dialler and the soft phone together are the Outbound connect rate,
 * under the table. Drawn only when a second type shows ({@link CallsByType} is null otherwise).
 */

/** One line of the table: a figure across the types. */
interface Line {
  key: 'calls' | 'connected' | 'reached' | 'talk' | 'missed' | 'rate';
  label: string;
  cell: (column: CallsByTypeColumn) => React.ReactNode;
  csv: (column: CallsByTypeColumn) => string | number | null;
  all: React.ReactNode;
  allCsv: string | number | null;
}

const NA = '—';

function lines(table: CallsByType, campaignId: string): Line[] {
  const out: Line[] = [
    {
      key: 'calls',
      label: 'Calls',
      cell: (c) => `${formatCount(c.calls)} ${c.callsWord}`,
      csv: (c) => c.calls,
      all: formatCount(table.all.calls),
      allCsv: table.all.calls,
    },
    {
      key: 'connected',
      label: 'Connected',
      cell: (c) => (c.type === 'inbound' ? `${formatCount(c.connected)} answered` : formatCount(c.connected)),
      csv: (c) => c.connected,
      all: formatCount(table.all.connected),
      allCsv: table.all.connected,
    },
    {
      key: 'reached',
      label: 'Reached a person',
      cell: (c) => formatCount(c.reached),
      csv: (c) => c.reached,
      all: formatCount(table.all.reached),
      allCsv: table.all.reached,
    },
    {
      key: 'talk',
      label: 'Talk time',
      cell: (c) => (c.talk_seconds === null ? NA : durationWords(c.talk_seconds)),
      csv: (c) => c.talk_seconds,
      all: durationWords(table.all.talk_seconds),
      allCsv: table.all.talk_seconds,
    },
  ];
  if (table.all.missed !== null) {
    out.push({
      key: 'missed',
      label: 'Missed by us',
      cell: (c) => {
        if (c.missed === null) return NA;
        const open = c.open_follow_ups ?? 0;
        return (
          <>
            {formatCount(c.missed)}{' '}
            <span className={styles.muted} data-testid="calls-by-type-follow-ups">
              {'('}
              {open > 0 ? (
                <Link to={toFollowUpLink(campaignId)} aria-label={`${formatCount(open)} missed calls to follow up: open the list`}>
                  {`${formatCount(open)} to follow up`}
                </Link>
              ) : (
                '0 to follow up'
              )}
              {')'}
            </span>
          </>
        );
      },
      csv: (c) => c.missed,
      all: formatCount(table.all.missed),
      allCsv: table.all.missed,
    });
  }
  out.push({
    key: 'rate',
    label: 'Rate',
    cell: (c) => (
      <>
        <strong>{rateText(c.rate)}</strong>
        <br />
        <span className={styles.muted}>{c.rateLabel}</span>
      </>
    ),
    csv: (c) => (c.rate.kind === 'value' ? c.rate.pct : null),
    all: <span className={styles.muted}>{AGENCY_CALLS_BY_TYPE_NO_RATE}</span>,
    allCsv: null,
  });
  return out;
}

/**
 * The split at a glance, above the table: one bar, a segment per type in the Call log's own
 * type colours, and the counts beside their names. A type with no call has no segment (a
 * zero-width one would still leave its gap), and with no call at all there is no bar. The
 * figures are in the legend as text, so the colours carry nothing on their own.
 */
function CallsByTypeBar({ table }: { table: CallsByType }) {
  const total = table.all.calls;
  const summary = `${formatCount(total)} calls: ${table.columns.map((c) => `${formatCount(c.calls)} ${c.label.toLowerCase()}`).join(', ')}`;
  return (
    <div className={styles.typeStack} data-testid="calls-by-type-bar">
      {total > 0 ? (
        <div className={styles.typeStackBar} role="img" aria-label={summary}>
          {table.columns.filter((c) => c.calls > 0).map((c) => (
            <div key={c.type} className={styles.typeStackSegment} data-type={c.type} style={{ flexGrow: c.calls }} />
          ))}
        </div>
      ) : null}
      <ul className={styles.typeStackLegend}>
        {table.columns.map((c) => (
          <li key={c.type}>
            <span className={styles.typeStackSwatch} data-type={c.type} aria-hidden="true" />
            {c.label} <strong>{formatCount(c.calls)}</strong>
          </li>
        ))}
        <li>All calls <strong>{formatCount(total)}</strong></li>
      </ul>
    </div>
  );
}

export function CallsByTypeTable({
  table,
  campaignId,
  rangeLabel,
  heading = true,
}: {
  table: CallsByType;
  campaignId: string;
  rangeLabel: string;
  /** False inside a panel that already carries the title. */
  heading?: boolean;
}) {
  const columns: InsightsColumn<Line>[] = [
    { key: 'figure', header: rangeLabel, render: (l) => l.label, csv: (l) => l.label },
    ...table.columns.map((column): InsightsColumn<Line> => ({
      key: column.type,
      header: column.label,
      numeric: true,
      render: (l) => l.cell(column),
      csv: (l) => l.csv(column),
    })),
    { key: 'all', header: 'All calls', numeric: true, render: (l) => l.all, csv: (l) => l.allCsv },
  ];
  const outbound = table.outbound;
  const hasInbound = table.all.missed !== null;
  return (
    <div className={styles.subSection} data-testid="calls-by-type">
      {heading ? <h4 className={styles.subTitle}>Calls by type</h4> : null}
      <CallsByTypeBar table={table} />
      <InsightsTable
        caption="Calls by type: dialler, soft phone and inbound, and all calls added"
        columns={columns}
        rows={lines(table, campaignId)}
        rowKey={(l) => l.key}
        testId="calls-by-type-table"
      />
      <p className={styles.muted} data-testid="calls-by-type-note">
        {table.footnote}
        {hasInbound ? ' To follow up counts every missed call of this campaign still owed a call back now, whatever the dates.' : ''}
      </p>
      {outbound ? (
        <p className={styles.muted} data-testid="outbound-connect-rate">
          {`${AGENCY_OUTBOUND_CONNECT_RATE_LABEL} ${rateText(outboundConnectRate(outbound))} · ${formatCount(outbound.human_connects)} people answered of ${formatCount(outbound.first_dials)} first dials and soft-phone calls, the dialler and the soft phone together. Inbound calls are not in it.`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The campaign's outcomes on each call type (CL28): one outcome list for the campaign, so one
 * table. Only the types the Calls by type table shows; Total adds the columns printed.
 */
export function OutcomesByTypeTable({ rows, table }: { rows: AgencyInsightsOutcomeByTypeRow[]; table: CallsByType }) {
  const shown = table.columns.map((c) => c.type);
  const total = (row: AgencyInsightsOutcomeByTypeRow) => shown.reduce((sum, type) => sum + row[type], 0);
  const listed = rows.filter((row) => total(row) > 0).sort((a, b) => total(b) - total(a));
  const columns: InsightsColumn<AgencyInsightsOutcomeByTypeRow>[] = [
    {
      key: 'label',
      header: 'Outcome',
      render: (row) => (
        <>
          {row.code === null ? 'Closed with no outcome' : (row.label ?? row.code)}
          {row.is_success ? <span className={styles.success}> · Success</span> : null}
        </>
      ),
      csv: (row) => row.label ?? row.code ?? 'no outcome',
    },
    ...table.columns.map((column): InsightsColumn<AgencyInsightsOutcomeByTypeRow> => ({
      key: column.type,
      header: column.label,
      numeric: true,
      render: (row) => formatCount(row[column.type]),
      csv: (row) => row[column.type],
    })),
    { key: 'total', header: 'Total', numeric: true, render: (row) => formatCount(total(row)), csv: (row) => total(row) },
  ];
  return (
    <div className={styles.subSection} data-testid="outcomes-by-type">
      <h4 className={styles.subTitle}>Outcomes by type</h4>
      {listed.length === 0 ? (
        <p className={styles.muted}>No conversations in this range.</p>
      ) : (
        <InsightsTable
          caption="Outcomes by type of call: conversations on the dialler, the soft phone and inbound calls"
          columns={columns}
          rows={listed}
          rowKey={(row) => row.code ?? 'none'}
          testId="outcomes-by-type-table"
        />
      )}
    </div>
  );
}

/**
 * The table a range read's calls give, by the page's one gate: the soft phone's column while the
 * soft phone is on or the range holds a soft-phone call, inbound's while inbound is on or the
 * range holds an inbound call (SR5), and no table when only the dialler shows.
 */
export function callsByTypeFor(
  calls: AgencyInsightsActivity['calls'],
  flags: { softphoneEnabled?: boolean; inboundEnabled?: boolean },
): CallsByType | null {
  const soft = showSoftphoneFigures(flags.softphoneEnabled ?? false, calls.softphone) ? calls.softphone : null;
  const inbound = showInboundFigures(flags.inboundEnabled ?? false, calls.inbound) ? calls.inbound : null;
  return callsByType(calls, soft, inbound);
}

/** The Overview's Calls by type panel; nothing while the activity loads or only the dialler shows. */
export function OverviewCallsByType({
  campaignId,
  rangeLabel,
  activity,
  softphoneEnabled,
  inboundEnabled,
}: {
  campaignId: string;
  rangeLabel: string;
  activity: AgencyInsightsActivity | null;
  softphoneEnabled?: boolean;
  inboundEnabled?: boolean;
}) {
  const table = activity ? callsByTypeFor(activity.calls, { softphoneEnabled, inboundEnabled }) : null;
  if (!table) return null;
  return (
    <Panel id="calls-by-type" title="Calls by type" sub={rangeLabel}>
      <CallsByTypeTable table={table} campaignId={campaignId} rangeLabel={rangeLabel} heading={false} />
    </Panel>
  );
}
