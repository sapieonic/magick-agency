import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import type { AsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type { AgencyInsightsReconciliation } from '../../../../types/agency-insights';
import { formatCount } from '../../../../utils/format/number';
import { rateText, type InsightsRate } from '../../../../utils/agency/insights/rates';
import { csvFromColumns, downloadCsv, type CsvCell } from '../../../../utils/agency/insights/csv';
import styles from './Insights.module.css';

/**
 * The building blocks every Insights panel is made of, so the panels differ only
 * in what they say: a titled section, a figure, a number that opens its list, a
 * rate that knows when to withhold itself, a sortable table with its own CSV.
 */

export function Panel({
  id,
  title,
  sub,
  actions,
  children,
  testId,
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const headingId = `insights-${id}-heading`;
  return (
    <section className={styles.panel} aria-labelledby={headingId} data-testid={testId ?? `insights-${id}`}>
      <div className={styles.panelHead}>
        <div>
          <h3 className={styles.panelTitle} id={headingId}>{title}</h3>
          {sub ? <p className={styles.panelSub}>{sub}</p> : null}
        </div>
        {actions ? <div className={styles.panelActions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** One figure: label, value, and an optional line beneath. */
export function Kpi({
  label,
  value,
  sub,
  withheld,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** The value is a "Not enough calls yet" or a dash, styled down. */
  withheld?: boolean;
  testId?: string;
}) {
  return (
    <div className={styles.kpi} data-testid={testId}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue} data-withheld={String(Boolean(withheld))}>{value}</span>
      {sub ? <span className={styles.kpiSub}>{sub}</span> : null}
    </div>
  );
}

/** A count that opens the list it counts. `label` names the list for a screen reader. */
export function CountLink({ to, value, label }: { to: string; value: number; label?: string }) {
  return (
    <Link to={to} className={styles.numLink} aria-label={label ? `${formatCount(value)} ${label}` : undefined}>
      {formatCount(value)}
    </Link>
  );
}

/** The figure for a rate, and whether it was withheld (for `Kpi`'s styling). */
export function rateFigure(rate: InsightsRate, noun: 'calls' | 'contacts' = 'calls'): { value: string; withheld: boolean } {
  return { value: rateText(rate, noun), withheld: rate.kind !== 'value' };
}

/** Loading / error / empty for a section that waits on its own read. */
export function SectionBody<T>({
  resource,
  children,
  loadingText = 'Loading…',
}: {
  resource: AsyncResource<T | null>;
  children: (data: T) => ReactNode;
  loadingText?: string;
}) {
  if (resource.data === null) {
    if (resource.error) return <p className={styles.sectionError} role="alert">{resource.error}</p>;
    return <p className={styles.sectionState}>{loadingText}</p>;
  }
  return (
    <>
      {resource.error ? <p className={styles.sectionError} role="alert">{resource.error}</p> : null}
      {children(resource.data)}
    </>
  );
}

const CHECK_LABELS: Record<string, string> = {
  contact_states_vs_total: 'States add up to the roster',
  attempts_per_contact_vs_attempted: 'Attempts per contact add up to the attempted',
  waiting_vs_open: 'Waiting adds up to the open contacts',
  allocated_plus_unassigned_vs_total: 'Allocated and unassigned add up to the roster',
  agent_buckets_vs_allocated: 'Each agent’s states add up to their allocation',
  outcomes_vs_dials: 'Outcomes add up to dials',
  dispositions_vs_connected: 'Dispositions add up to connected calls',
  agents_vs_total: 'Agents add up to the total',
};

/** A server reconciliation as a reader sees it. Unknown check names are spaced out, not hidden. */
export function reconciliationLabel(check: string): string {
  return CHECK_LABELS[check] ?? check.replace(/_/g, ' ');
}

/** The `reconciliation[]` block of a section, as chips. */
export function ReconciliationChips({ checks }: { checks: AgencyInsightsReconciliation[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label="Checks" data-testid="reconciliation">
      {checks.map((check) => (
        <li key={check.check} className={styles.chip} data-ok={String(check.ok)}>
          <span aria-hidden="true">{check.ok ? '✓' : '✕'}</span>
          {check.ok
            ? `${reconciliationLabel(check.check)}: ${formatCount(check.actual)}`
            : `${reconciliationLabel(check.check)}: ${formatCount(check.actual)} of ${formatCount(check.expected)}`}
        </li>
      ))}
    </ul>
  );
}

/** A "Download CSV" button that builds the file from the rows it is handed. */
export function CsvButton({ filename, build, label = 'Download CSV' }: { filename: string; build: () => string; label?: string }) {
  return (
    <button
      type="button"
      className={`btn-secondary ${styles.toolButton}`}
      onClick={() => downloadCsv(filename, build())}
    >
      <Download size={14} aria-hidden="true" />
      {label}
    </button>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

export interface InsightsColumn<Row> {
  key: string;
  header: string;
  /** Right-aligned, tabular. */
  numeric?: boolean;
  render: (row: Row) => ReactNode;
  /** The raw value for the CSV (and for sorting, unless `sort` is given). */
  csv: (row: Row) => CsvCell;
  /** Sort key; columns without `csv`-sortable values can opt out with `sortable: false`. */
  sortable?: boolean;
}

/** One row outside the sorted body: Unassigned and Total. */
export interface InsightsFooterRow {
  kind: string;
  cells: Record<string, ReactNode>;
  csv: Record<string, CsvCell>;
}

function compare(a: CsvCell, b: CsvCell): number {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * A table with semantic headers, optional sorting and its own CSV.
 *
 * Its CSV ({@link tableCsv}) is every body row in the order the server sent,
 * then the footer rows, with raw values (`csv`), never the formatted cells. The
 * first column is the row header (`<th scope="row">`).
 */
export function InsightsTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  footer = [],
  sortable = false,
  defaultSort,
  rowKind,
  testId,
}: {
  caption: string;
  columns: InsightsColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  footer?: InsightsFooterRow[];
  sortable?: boolean;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  rowKind?: (row: Row) => string | undefined;
  testId?: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null);
  const sortedRows = sortedBy(rows, columns, sort);

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} data-testid={testId}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const canSort = sortable && column.sortable !== false;
              return (
                <th
                  key={column.key}
                  scope="col"
                  data-num={String(Boolean(column.numeric))}
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {canSort ? (
                    <button
                      type="button"
                      className={styles.sortButton}
                      onClick={() =>
                        setSort((prev) =>
                          prev?.key === column.key
                            ? { key: column.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                            : { key: column.key, dir: column.numeric ? 'desc' : 'asc' },
                        )
                      }
                    >
                      {column.header}
                      {active ? (sort?.dir === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />) : null}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={rowKey(row)} data-kind={rowKind?.(row)}>
              {columns.map((column, index) =>
                index === 0 ? (
                  <th key={column.key} scope="row">{column.render(row)}</th>
                ) : (
                  <td key={column.key} data-num={String(Boolean(column.numeric))}>{column.render(row)}</td>
                ),
              )}
            </tr>
          ))}
          {footer.map((line) => (
            <tr key={line.kind} data-kind={line.kind}>
              {columns.map((column, index) =>
                index === 0 ? (
                  <th key={column.key} scope="row">{line.cells[column.key] ?? ''}</th>
                ) : (
                  <td key={column.key} data-num={String(Boolean(column.numeric))}>{line.cells[column.key] ?? '—'}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sortedBy<Row>(rows: Row[], columns: InsightsColumn<Row>[], sort: { key: string; dir: 'asc' | 'desc' } | null): Row[] {
  if (!sort) return rows;
  const column = columns.find((c) => c.key === sort.key);
  if (!column) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => sign * compare(column.csv(a), column.csv(b)));
}

/** The CSV for a table: the body rows as given, then the footer rows. */
export function tableCsv<Row>(columns: InsightsColumn<Row>[], rows: Row[], footer: InsightsFooterRow[] = []): string {
  const body = csvFromColumns(columns.map((c) => ({ header: c.header, value: c.csv })), rows);
  if (footer.length === 0) return body;
  const extra = csvFromColumns(
    columns.map((c) => ({ header: c.header, value: (line: InsightsFooterRow) => line.csv[c.key] })),
    footer,
  );
  // Drop the second header row.
  return body + extra.slice(extra.indexOf('\r\n') + 2);
}

/** A disclosure that mounts its content only while open. */
export function Disclosure({ label, children }: { label: [string, string]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" className={styles.disclosure} aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {open ? label[1] : label[0]}
      </button>
      {open ? <div id={id}>{children}</div> : null}
    </>
  );
}
