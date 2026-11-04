import type { ReactNode } from 'react';
import type { AgencyInsightsAllocation, AgencyInsightsAllocationRow } from '../../../../types/agency-insights';
import { formatCount } from '../../../../utils/format/number';
import {
  actorName,
  AGENT_STATE_LABELS,
  ASSIGNMENT_MODE_LABELS,
  formatZoned,
} from '../../../../utils/agency/insights/copy';
import { attemptsLink, contactsLink, type InsightsContactsFilter } from '../../../../utils/agency/insights/links';
import { insightsCsvFilename } from '../../../../utils/agency/insights/csv';
import {
  CountLink,
  CsvButton,
  InsightsTable,
  Panel,
  ReconciliationChips,
  tableCsv,
  type InsightsColumn,
  type InsightsFooterRow,
} from './InsightsParts';
import styles from './Insights.module.css';

type Counts = AgencyInsightsAllocation['totals'];
/** The numeric fields of a row (everything but `last_activity_at`). */
type CountKey = { [K in keyof Counts]: Counts[K] extends number ? K : never }[keyof Counts];

/** The count columns: shared by agent rows, the Unassigned row and the Total row. */
interface CountColumn {
  key: CountKey;
  header: string;
  /** The contacts filter behind the number; the owner is added per row. */
  contacts?: InsightsContactsFilter;
  /** Or the attempts filter behind it (agent rows only: the pool places no dials). */
  attempts?: { redial?: boolean; agent_reopened?: boolean; agent_manual?: boolean };
}

const COUNT_COLUMNS: CountColumn[] = [
  { key: 'allocated', header: 'Allocated', contacts: {} },
  { key: 'attempted', header: 'Attempted', contacts: { attempted: true } },
  { key: 'not_attempted', header: 'Not yet', contacts: { attempted: false } },
  { key: 'due_now', header: 'Due now', contacts: { state: ['pending'], waiting: 'due_now' } },
  { key: 'waiting_retry', header: 'Waiting for retry', contacts: { state: ['pending'], waiting: 'retry' } },
  { key: 'callbacks_due_today', header: 'Callbacks today', contacts: { state: ['pending'], waiting: 'callback' } },
  { key: 'callbacks_overdue', header: 'Callbacks overdue' },
  { key: 'reached', header: 'Reached' },
  { key: 'successes', header: 'Successes' },
  { key: 'not_reached', header: 'Not reached' },
  { key: 'exhausted', header: 'Exhausted', contacts: { state: ['exhausted'] } },
  { key: 'dnc', header: 'Do Not Call', contacts: { state: ['suppressed'], suppressed_reason: ['dnc'] } },
  { key: 'redials', header: 'Redials', attempts: { redial: true } },
  { key: 'retries_reopened', header: 'Retries reopened', attempts: { agent_reopened: true } },
  { key: 'retries_manual', header: 'Retries dialled by hand', attempts: { agent_manual: true } },
  { key: 'overrides_used', header: 'Overrides used' },
];

/** `owner`: an agent id, `null` for the pool, `undefined` for the whole campaign. */
function countCell(campaignId: string, column: CountColumn, value: number, owner: string | null | undefined): ReactNode {
  if (column.contacts) {
    const filter: InsightsContactsFilter = { ...column.contacts, ...(owner !== undefined ? { assigned_to: owner } : {}) };
    return <CountLink to={contactsLink(campaignId, filter)} value={value} label={column.header.toLowerCase()} />;
  }
  if (column.attempts && owner !== null) {
    return (
      <CountLink
        to={attemptsLink(campaignId, { ...column.attempts, ...(owner ? { agent_user_id: owner } : {}) })}
        value={value}
        label={column.header.toLowerCase()}
      />
    );
  }
  return formatCount(value);
}

function humanKind(kind: string): string {
  const text = kind.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function AllocationSection({
  campaignId,
  campaignName,
  allocation,
  timezone,
}: {
  campaignId: string;
  campaignName: string;
  allocation: AgencyInsightsAllocation;
  timezone: string;
}) {
  const names = new Map(allocation.agents.map((a) => [a.agent_user_id, a.agent_name ?? 'Unknown agent']));
  const nameOf = (id: string) => names.get(id) ?? 'Unknown agent';
  const high = new Map(allocation.imbalance.high.map((h) => [h.agent_user_id, h.factor]));

  const columns: InsightsColumn<AgencyInsightsAllocationRow>[] = [
    {
      key: 'agent',
      header: 'Agent',
      render: (row) => (
        <>
          {row.agent_name ?? 'Unknown agent'}
          {!row.staffed ? <span className={styles.flag}>not staffed</span> : null}
          {high.has(row.agent_user_id) ? <span className={styles.flag}>{`backlog ${(high.get(row.agent_user_id) ?? 0).toFixed(1)}×`}</span> : null}
        </>
      ),
      csv: (row) => row.agent_name ?? row.agent_user_id,
    },
    ...COUNT_COLUMNS.map<InsightsColumn<AgencyInsightsAllocationRow>>((column) => ({
      key: column.key,
      header: column.header,
      numeric: true,
      render: (row) => countCell(campaignId, column, row[column.key], row.agent_user_id),
      csv: (row) => row[column.key],
    })),
    {
      key: 'state',
      header: 'Now',
      render: (row) => (
        <>
          <span className={styles.stateDot} data-state={row.state} aria-hidden="true" />
          {AGENT_STATE_LABELS[row.state]}
          {row.state === 'offline' && row.last_seen_at ? ` · last seen ${formatZoned(row.last_seen_at, timezone)}` : ''}
        </>
      ),
      csv: (row) => row.state,
    },
    {
      key: 'last_activity_at',
      header: 'Last activity',
      render: (row) => formatZoned(row.last_activity_at, timezone),
      csv: (row) => row.last_activity_at,
    },
  ];

  const footerLine = (kind: string, label: string, counts: Counts, owner: string | null | undefined): InsightsFooterRow => ({
    kind,
    cells: {
      agent: label,
      ...Object.fromEntries(COUNT_COLUMNS.map((c) => [c.key, countCell(campaignId, c, counts[c.key], owner)])),
    },
    csv: { agent: label, ...Object.fromEntries(COUNT_COLUMNS.map((c) => [c.key, counts[c.key]])) },
  });
  const footer = [
    footerLine('unassigned', 'Unassigned', allocation.unassigned, null),
    footerLine('total', 'Total', allocation.totals, undefined),
  ];

  const online = allocation.agents.filter((a) => a.state !== 'offline').length;
  const lastOp = allocation.history[0];

  return (
    <Panel
      id="allocation"
      title="Allocation by agent"
      sub={`${ASSIGNMENT_MODE_LABELS[allocation.assignment_mode]} mode · ${formatCount(allocation.totals.allocated - allocation.unassigned.allocated)} allocated · ${formatCount(allocation.unassigned.allocated)} unassigned · ${formatCount(online)} of ${formatCount(allocation.agents.length)} online · as of now`}
      actions={
        <CsvButton filename={insightsCsvFilename(campaignName, 'allocation', campaignId)} build={() => tableCsv(columns, allocation.agents, footer)} />
      }
    >
      <InsightsTable
        caption="Allocation by agent, with the unassigned pool and the total"
        columns={columns}
        rows={allocation.agents}
        rowKey={(row) => row.agent_user_id}
        footer={footer}
        sortable
        testId="allocation-table"
      />

      <ul className={styles.callouts} aria-label="Allocation warnings">
        {allocation.at_risk.held_by_absent.map((held) => (
          <li key={`risk-${held.agent_user_id}`} className={styles.callout} data-tone="warn" data-testid="allocation-at-risk">
            <strong>At risk:</strong>{' '}
            <CountLink to={contactsLink(campaignId, { state: ['pending'], waiting: 'due_now', assigned_to: held.agent_user_id })} value={held.due} label="due contacts" />
            {` due contacts held by ${nameOf(held.agent_user_id)} `}
            {held.staffed
              ? `(away${held.away_since ? ` since ${formatZoned(held.away_since, timezone)}` : ''}, more than ${formatCount(allocation.absent_after_minutes)} minutes)`
              : '(no longer staffed on this campaign)'}
          </li>
        ))}
        {allocation.at_risk.overdue_callbacks_absent_owner > 0 ? (
          <li className={styles.callout} data-tone="warn">
            <strong>{formatCount(allocation.at_risk.overdue_callbacks_absent_owner)}</strong> overdue callbacks belong to owners who are away.
          </li>
        ) : null}
        {allocation.imbalance.high.map((h) => (
          <li key={`high-${h.agent_user_id}`} className={styles.callout} data-tone="warn" data-testid="allocation-imbalance">
            <strong>Imbalance:</strong> {`${nameOf(h.agent_user_id)}’s due queue is ${h.factor.toFixed(1)}× the staffed average.`}
          </li>
        ))}
        {allocation.imbalance.empty.length > 0 ? (
          <li className={styles.callout} data-testid="allocation-empty">
            <strong>Nothing due:</strong> {allocation.imbalance.empty.map(nameOf).join(', ')}
          </li>
        ) : null}
        {lastOp ? (
          <li className={styles.callout}>
            <strong>Last bulk change:</strong> {`${humanKind(lastOp.kind)}, ${formatCount(lastOp.moved)} contacts, by ${actorName(lastOp.actor, 'the system')}, ${formatZoned(lastOp.at, timezone)}`}
          </li>
        ) : null}
      </ul>

      {allocation.history.length > 0 ? (
        <>
          <h4 className={styles.subTitle}>Assignment history</h4>
          <div className={styles.historyList}>
            <InsightsTable
              caption="Bulk assignment changes, newest first"
              columns={[
                { key: 'at', header: 'When', render: (h) => formatZoned(h.at, timezone), csv: (h) => h.at },
                { key: 'kind', header: 'Change', render: (h) => humanKind(h.kind), csv: (h) => h.kind },
                { key: 'moved', header: 'Contacts moved', numeric: true, render: (h) => formatCount(h.moved), csv: (h) => h.moved },
                { key: 'actor', header: 'By', render: (h) => actorName(h.actor, 'The system'), csv: (h) => h.actor?.name ?? h.actor?.user_id ?? 'system' },
              ]}
              rows={allocation.history}
              rowKey={(h) => `${h.at}-${h.batch_id ?? h.kind}`}
              testId="allocation-history"
            />
          </div>
        </>
      ) : null}

      <ReconciliationChips checks={allocation.reconciliation} />
    </Panel>
  );
}
