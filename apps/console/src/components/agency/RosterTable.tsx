import { useId, useMemo } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import {
  agentDisplayName,
  hasResolvedName,
} from '../../utils/agencyAgentFloor';
import {
  ROSTER_COLUMNS,
  agentInitials,
  ahtBandReadout,
  ariaSort,
  bandReadout,
  benchmarkUsable,
  cellMeasured,
  cohortComparable,
  connectBullet,
  connectRateCell,
  connectsText,
  conversionCell,
  conversionsText,
  dialsText,
  handleTimeCell,
  pooledRate,
  ratedBasisNote,
  rosterAttentionRows,
  rosterConnectAxis,
  rosterFlag,
  rosterSubline,
  teamUtilisation,
  utilisationBasis,
  utilisationCell,
  withheldRateTitle,
  type RosterBullet,
  type RosterCell,
  type RosterFlag,
} from '../../utils/agencyAgentRoster';
import { agentSeconds } from '../../utils/agencyAgentPerformance';
import type {
  AgencyRosterAgentRowWithName,
  AgencyRosterOrder,
  AgencyRosterPage,
  AgencyRosterSort,
} from '../../types/agency-stats';
import styles from './RosterTable.module.css';

/**
 * The floor, ranked — one row per agent, with the cohort pinned beneath them.
 *
 * ── What this replaced, and why a table rather than a picker ───────────────
 * The supervisor's per-agent surface used to open with a dropdown of colleagues.
 * That control answers "show me Ravi" and cannot answer the question a supervisor
 * actually arrives with, which is *"who should I be asking about"* — a name
 * picker requires you to already know the answer. Worse, it made the numbers
 * unreadable even once you got there: a 31% connect rate is good or bad only
 * against the floor, and a screen showing one person at a time never shows the
 * floor.
 *
 * So this table is the entry point and the per-agent panel is the drill-down. The
 * panel itself is untouched — see `AgentPerformancePanel`, which is shared between
 * an agent's own view and their supervisor's precisely so a coaching conversation
 * happens over one screen. A roster row leads INTO that screen; it does not
 * reimplement any part of it.
 *
 * ── Nothing in this file divides ───────────────────────────────────────────
 * The rates, the percentiles and the pooled team rates arrive on one payload —
 * deliberate on the contract's side ("rates and their denominators travel
 * together") — and the two figures that do not (the team row's pooled utilisation
 * and its own arithmetic) are derived in `agencyAgentRoster.ts`, where they are
 * unit-tested. This component is a renderer: the only arithmetic in it is the
 * bullet's geometry, and that lives in the same module for the same reason.
 *
 * ── The three absences, in a table ────────────────────────────────────────
 * A table is scanned, not read, so a wrong absence here is invisible in a way it
 * is not in a sentence: `0%` among real percentages looks exactly like a bad
 * week. Every metric cell therefore comes from a {@link RosterCell}, and a
 * `withheld` cell renders **words** — "Not enough calls" — rather than a faint
 * number. A rate greyed out is still a rate, and it is the one that gets read
 * aloud.
 *
 * ── The bullet is not the measurement ─────────────────────────────────────
 * The numeric rate sits beside the bullet in every row, and the flag chip carries
 * its own label. Nothing on this table is conveyed by colour or by length alone —
 * which is not only an accessibility floor but a correctness one, because a bar
 * whose axis is shared across the column is a comparison, and a comparison is not
 * a value.
 */

export interface RosterTableProps {
  page: AgencyRosterPage;
  sort: AgencyRosterSort;
  order: AgencyRosterOrder;
  /**
   * A column header was pressed.
   *
   * The caller decides what that means, and on this surface it means a
   * **refetch** — `limit` truncates to the top N of the chosen order, so
   * re-sorting the rows in hand would re-rank a page selected by a different
   * question. See `useAgentRoster`.
   */
  onSort: (column: AgencyRosterSort) => void;
  /** Drill into one person. The row is the affordance; there is no separate link. */
  onSelect: (row: AgencyRosterAgentRowWithName) => void;
  /** What the table is called for a screen reader, e.g. "Everyone who dialled this week". */
  caption: string;
  /**
   * Show only the rows carrying a flag.
   *
   * A CLIENT-side filter over the rows already in hand, and the only one on this
   * table. It exists because `limit` is the roster's real constraint: this console
   * asks for the contract's maximum and there is no paging, so on a large floor
   * the ranking decides who is visible — and the flag column cannot be sorted (it
   * is derived from a row's relationship to the benchmark, so no server can order
   * by it). Filtering is what makes a marked row reachable without asking a
   * different question.
   *
   * It changes which rows are LISTED and nothing else: the pinned team row, the
   * axis and the counts all stay measured over the whole page, because they are
   * facts about the cohort rather than about the filter.
   */
  onlyFlagged?: boolean;
}

export function RosterTable({
  page,
  sort,
  order,
  onSort,
  onSelect,
  caption,
  onlyFlagged = false,
}: RosterTableProps) {
  const bandId = useId();

  /**
   * The axis every bullet in the column shares, computed once.
   *
   * Once per PAGE rather than per row, because a per-row axis would draw two
   * different rates as identical bars — which is worse than no chart, and is the
   * mistake a naive `value / max(row)` makes silently.
   *
   * Over the whole page rather than over the filtered rows, so switching the
   * flag filter on does not rescale the column and make the same rate a different
   * length.
   */
  const axis = useMemo(
    () => rosterConnectAxis(page.rows, page.benchmark),
    [page.rows, page.benchmark],
  );

  /**
   * Whether a row may be compared against the band at all.
   *
   * Two independent conditions, and both are about honesty rather than
   * aesthetics. `cohortComparable` is false on the all-campaigns read, where the
   * median pools different dealers' lead lists and a per-person comparison against
   * it is not like-for-like. `benchmarkUsable` is false when fewer than two agents
   * cleared the dial threshold, because one rated agent IS the median. When either
   * holds, the bullets and the two band chips go away and every figure stays.
   */
  const comparable = cohortComparable(page) && benchmarkUsable(page.benchmark);

  /**
   * The team row's two derived readouts, computed once for the footer.
   *
   * Both are about the BENCHMARK and nothing else — not the rows, and not the
   * filtered rows — which is what keeps the pinned row a fact about the cohort
   * rather than about whatever the reader has narrowed to. See `teamUtilisation`
   * for the pooled-versus-median decision and for what happens when the additive
   * fields have not arrived.
   */
  const utilisation = useMemo(() => teamUtilisation(page.benchmark), [page.benchmark]);
  const ahtBand = useMemo(() => ahtBandReadout(page.benchmark), [page.benchmark]);

  /* Filtered for LISTING only — see `onlyFlagged`. */
  const rows = onlyFlagged
    ? rosterAttentionRows(page.rows, page.benchmark, comparable)
    : page.rows;

  return (
    <div className={styles.tableWrap} data-testid="roster-table">
      <table className={styles.table}>
        <caption className={styles.srOnly}>{caption}</caption>
        <thead>
          <tr>
            {ROSTER_COLUMNS.map((column) => (
              <th
                key={column.sort}
                scope="col"
                aria-sort={ariaSort(column.sort, sort, order)}
                data-numeric={column.numeric ? 'true' : 'false'}
              >
                {/*
                  A real button, not a `<th>` with an onClick. The header IS the
                  control that reorders the table, so it has to be reachable by
                  keyboard and announced as pressable; `aria-sort` on the cell
                  then says which way it currently goes. `DataTable` established
                  this pattern and this table follows it rather than inventing a
                  second one.

                  The columns come from `ROSTER_COLUMNS`, which is also what
                  builds the sort menu above the table — so an order the reader can
                  choose and a column they can see are one list rather than two
                  that agreed until they did not.
                */}
                <button
                  type="button"
                  className={styles.sortButton}
                  data-active={column.sort === sort ? 'true' : 'false'}
                  onClick={() => onSort(column.sort)}
                >
                  <span className={styles.headLabel}>
                    {column.label}
                    {column.sort === sort ? (
                      order === 'asc' ? (
                        <ArrowUp size={12} aria-hidden="true" />
                      ) : (
                        <ArrowDown size={12} aria-hidden="true" />
                      )
                    ) : (
                      <ChevronsUpDown size={12} aria-hidden="true" className={styles.sortIdle} />
                    )}
                  </span>
                  {/*
                    The definition, rendered rather than hidden in a `title`. A
                    denominator a reader has to hover for is a denominator most of
                    them never see, and on the utilisation column that is the
                    difference between a figure and a figure they can check.
                  */}
                  {column.hint && <span className={styles.headHint}>{column.hint}</span>}
                </button>
              </th>
            ))}
            {/*
              Not sortable, and not because it was forgotten: the flag is derived
              from a row's relationship to the benchmark, so it is not a column
              the server can order by — and a client-side sort on it would reorder
              a page the server selected under a different question. What the
              reader gets instead is the caller's "needs attention" filter, which
              hides rows rather than reordering them.
            */}
            <th scope="col">Flag</th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <RosterRow
              key={row.agent_user_id}
              row={row}
              page={page}
              axis={axis}
              comparable={comparable}
              onSelect={onSelect}
            />
          ))}
        </tbody>

        {/*
          The cohort, pinned in a `<tfoot>`.

          A footer rather than a first row: it is not an agent and must never sort
          or drill like one, and `tfoot` is the element that says "totals for the
          rows above" to a screen reader without a label claiming it. Every bullet
          in the table is measured against this row, so it stays on screen with
          them — `position: sticky`, in the stylesheet, along with the header. That
          sentence used to be in this comment and nowhere in the CSS.
        */}
        <tfoot>
          <tr className={styles.teamRow} data-testid="roster-team-row">
            <th scope="row">
              <span className={styles.teamName}>Team · this window</span>
              <span className={styles.subline}>
                {page.campaign_id === null ? 'Every campaign pooled' : 'This campaign only'}
              </span>
            </th>
            <td data-numeric="true">{page.benchmark.attempts.toLocaleString()}</td>
            <td data-numeric="true">{page.benchmark.connected.toLocaleString()}</td>
            <td>
              <div className={styles.teamRate}>
                <span className={styles.teamPooled}>{pooledRate(page.benchmark.connect_rate_pct)}</span>
                <span className={styles.subline} id={bandId} data-testid="roster-connect-band">
                  {bandReadout(page.benchmark.connect_rate)}
                </span>
              </div>
            </td>
            {/*
              The cohort's conversions, beside the column the roster's default
              order ranks by. It was on the payload and rendered nowhere, which
              left the one figure a dealer pays for absent from both the row and
              the team line.
            */}
            <td data-numeric="true">{page.benchmark.successes.toLocaleString()}</td>
            <td data-numeric="true">
              <div className={styles.teamRate}>
                <span className={styles.teamPooled}>{pooledRate(page.benchmark.success_rate_pct)}</span>
                {/*
                  Rendered from ITS OWN percentile block and nothing else. The
                  success-rate pool additionally requires `connected >= 20`, so a
                  row can be `rates_reportable: true`, sit in the connect-rate pool
                  and be absent from this one — which means `agents_rated` is not
                  this band's basis and each block's absence has to be reported on
                  its own terms.
                */}
                <span className={styles.subline} data-testid="roster-conversion-band">
                  {bandReadout(page.benchmark.success_rate)}
                </span>
              </div>
            </td>
            <td data-numeric="true">
              <div className={styles.teamRate}>
                <span className={styles.teamPooled}>
                  {page.benchmark.aht_seconds === null
                    ? '—'
                    : agentSeconds(page.benchmark.aht_seconds)}
                </span>
                {/*
                  AHT was the one metric with a team figure and no band beside it:
                  the benchmark carried handling time only as a pooled scalar, so
                  four minutes had nothing saying whether it was ordinary here. The
                  block is additive (D10), so an absent one renders NO line rather
                  than "no median yet" — that sentence is a claim about the floor,
                  and making it about a field master has not shipped would be a
                  false one. Same "median … · middle half …" shape as the two bands
                  above, in SECONDS.
                */}
                {ahtBand && (
                  <span className={styles.subline} data-testid="roster-aht-band">
                    {ahtBand}
                  </span>
                )}
              </div>
            </td>
            <td data-numeric="true">
              <div className={styles.teamRate}>
                {/*
                  A REAL pooled rate, now that the benchmark carries a pooled
                  `shift_seconds` (D10): `(talk + wrapup) / shift`, all of it off
                  the BENCHMARK. Summing the rows instead would make this cell move
                  when the reader revealed former members, which the benchmark's
                  contract forbids and a test pins by comparing this row's whole
                  `textContent` across that toggle.

                  Three states, handled in `teamUtilisation`: the floor's own rate
                  with its arithmetic beneath it; the cohort MEDIAN, labelled as
                  the typical agent, when the additive field has not arrived; and
                  an em dash when the floor has no measured shift at all. Gated
                  differently again upstream: this pool is `rates_reportable` plus
                  non-null, with NO minimum-shift floor.
                */}
                <span className={styles.teamPooled}>{utilisation.text}</span>
                {utilisation.basis && (
                  <span className={styles.subline} data-testid="roster-utilisation-basis">
                    {utilisation.basis}
                  </span>
                )}
                <span className={styles.subline} data-testid="roster-utilisation-band">
                  {utilisation.note}
                </span>
              </div>
            </td>
            <td>
              {/*
                `agents_rated` beside `agents`, always both — the percentiles are
                computed over the rated rows only (a new joiner's 11-call rate would
                drag the median), so the population behind them has to be visible or
                the bands are numbers with no denominator.

                Worded as the HEADLINE threshold rather than attached to any one
                median, because it only exactly describes the connect-rate pool: the
                success-rate pool wants `connected >= 20` on top, and the
                utilisation pool is gated on non-null seconds. "With enough calls to
                rate" is true of all three without claiming to be the basis of any.
              */}
              <span className={styles.ratedCount} data-testid="roster-rated-count">
                {ratedBasisNote(page.benchmark)}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function RosterRow({
  row,
  page,
  axis,
  comparable,
  onSelect,
}: {
  row: AgencyRosterAgentRowWithName;
  page: AgencyRosterPage;
  axis: number;
  comparable: boolean;
  onSelect: (row: AgencyRosterAgentRowWithName) => void;
}) {
  const name = agentDisplayName(row);
  const connect = connectRateCell(row);
  const bullet = comparable ? connectBullet(row, page.benchmark, axis) : null;
  const flag = rosterFlag(row, page.benchmark, comparable);
  const basis = utilisationBasis(row);

  return (
    <tr data-testid={`roster-row-${row.agent_user_id}`}>
      <th scope="row" className={styles.agentCell}>
        {/*
          The whole name cell is the button, so the row is reachable by keyboard
          and announced once. A `tabIndex` on the `<tr>` with a click handler
          would be focusable without being a control — no role, no Enter/Space
          handling, nothing in the a11y tree saying it does anything.
        */}
        <button
          type="button"
          className={styles.rowButton}
          onClick={() => onSelect(row)}
          data-testid={`roster-open-${row.agent_user_id}`}
        >
          <span className={styles.avatar} aria-hidden="true">
            {agentInitials(name)}
          </span>
          <span className={styles.agentText}>
            <span className={hasResolvedName(row) ? styles.name : styles.nameFallback}>{name}</span>
            <span className={styles.subline}>{rosterSubline(row)}</span>
          </span>
        </button>
      </th>

      <td data-numeric="true">{dialsText(row)}</td>
      <td data-numeric="true">{connectsText(row)}</td>

      <td>
        <ConnectCell cell={connect} bullet={bullet} />
      </td>

      <td data-numeric="true">{conversionsText(row)}</td>
      <td data-numeric="true">
        <MetricCell cell={conversionCell(row)} />
      </td>
      <td data-numeric="true">
        <MetricCell cell={handleTimeCell(row)} />
      </td>
      <td data-numeric="true">
        {/*
          The percentage AND its denominator, because this is the figure most
          likely to be quoted in a pay review and `37.5%` over a six-hour shift is
          not the same finding as `37.5%` over forty minutes. Both halves were on
          the payload for exactly this reason and neither was on screen.
        */}
        <span className={styles.utilisation}>
          <MetricCell cell={utilisationCell(row)} />
          {basis && <span className={styles.subline}>{basis}</span>}
        </span>
      </td>

      <td>{flag && <FlagChip flag={flag} agentUserId={row.agent_user_id} />}</td>
    </tr>
  );
}

/**
 * The flag, as a word and as an accessible name.
 *
 * ── The explanation is not mouse-only ─────────────────────────────────────
 * The sentence behind the chip used to live in `title` alone, which is a tooltip
 * on hover and nothing at all to a screen reader, to a keyboard user or on a
 * touch screen. `role="note"` gives the span a role that can carry a name, and
 * `aria-label` is then the whole finding — label and reason — announced in one
 * go. The `title` stays for the pointer, and the visible text stays the label:
 * every chip carries its own word, so the colour is a second channel and never
 * the only one.
 */
function FlagChip({ flag, agentUserId }: { flag: RosterFlag; agentUserId: string }) {
  return (
    <span
      className={styles.flag}
      data-kind={flag.kind}
      role="note"
      title={flag.detail}
      aria-label={`${flag.label}. ${flag.detail}`}
      data-testid={`roster-flag-${agentUserId}`}
    >
      {flag.label}
    </span>
  );
}

/**
 * The connect-rate cell: the number, then the bullet.
 *
 * The number FIRST and always. The bullet is a comparison against the cohort and
 * is omitted whenever there is nothing honest to draw — an unmeasured rate, a
 * withheld one, or a cohort too small to have quartiles — but the cell's text is
 * never omitted, so the column reads the same whether or not a band exists.
 */
function ConnectCell({ cell, bullet }: { cell: RosterCell; bullet: RosterBullet | null }) {
  return (
    <div className={styles.connectCell}>
      <MetricCell cell={cell} />
      {bullet && cellMeasured(cell) && (
        <span className={styles.bullet} aria-hidden="true">
          {/*
            `aria-hidden`, deliberately. Everything the bullet shows is already
            available in text: this row's rate is the sibling above it and the
            band is spelled out in words on the pinned team row. Announcing a
            second, wordless copy of both would make the column twice as long to
            listen to and no more informative.
          */}
          {bullet.band && (
            <span
              className={styles.bulletBand}
              style={{
                left: `${bullet.band.start}%`,
                width: `${Math.max(1, bullet.band.end - bullet.band.start)}%`,
              }}
            />
          )}
          {bullet.median !== null && (
            <span className={styles.bulletMedian} style={{ left: `${bullet.median}%` }} />
          )}
          <span className={styles.bulletValue} style={{ width: `${bullet.value}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * One metric, in whichever of its three states it is in.
 *
 * A `withheld` cell renders the words and the denominator beneath them, and the
 * threshold is named in the `title` rather than in the cell: every withheld cell
 * in the table would otherwise repeat the same sentence, and a column of repeated
 * sentences is a column nobody reads.
 *
 * That sentence comes from `withheldRateTitle` and therefore names the cell's OWN
 * denominator. It used to be written here as "Fewer than 20 calls", which is false
 * on exactly the row this phase exists to fix: 41 dials and 11 connects withholds
 * the conversion rate for want of CONNECTS, and this component cannot tell which
 * metric it is rendering — the cell can, and now does.
 */
function MetricCell({ cell }: { cell: RosterCell }) {
  if (cell.kind === 'measured') {
    return <span className={styles.value}>{cell.text}</span>;
  }
  return (
    <span
      className={cell.kind === 'withheld' ? styles.withheld : styles.unmeasured}
      title={cell.kind === 'withheld' ? withheldRateTitle(cell) : undefined}
    >
      <span className={styles.absentText}>{cell.text}</span>
      <span className={styles.subline}>{cell.note}</span>
    </span>
  );
}

export default RosterTable;
