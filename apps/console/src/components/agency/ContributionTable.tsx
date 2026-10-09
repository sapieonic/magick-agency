import { agentCount } from '../../utils/agencyAgentPerformance';
import {
  CONTRIBUTION_COLUMNS,
  CONTRIBUTION_TOTAL_LABEL,
  CONTRIBUTION_TOTAL_SUBLINE,
  contributionAgentName,
  contributionAriaSort,
  contributionConnectRateCell,
  contributionConversionCell,
  contributionHandleTimeCell,
  contributionNameResolved,
  contributionRowKey,
  contributionShareCell,
} from '../../utils/agencyCampaignContribution';
import { agentInitials, withheldRateTitle, type RosterCell } from '../../utils/agencyAgentRoster';
import type { NamedAgent } from '../../utils/agencyAgentFloor';
import {
  type AgencyGroupPage,
  type AgencyGroupRow,
  type AgencyGroupRowWithName,
} from '../../types/agency-stats';
import styles from './RosterTable.module.css';

/**
 * One campaign, then the people who drove it — the contribution table.
 *
 * ── What it is for, and what the roster could not do ──────────────────────
 * The roster ranks the whole floor against a cohort and answers "who should I be
 * asking about". It cannot answer "who drove THIS campaign", because a roster row
 * is a person's whole window and the campaign's own total is not on that payload.
 * This table puts the two side by side: the campaign's line pinned in the footer,
 * and each agent's share of it above.
 *
 * ── The pinned footer is NOT the sum of the rows ──────────────────────────
 * It is a separate read of the same route grouped by `campaign` alone, and that is
 * the one thing about this screen a reader has to be told: with `agent` grouped,
 * master drops the rows of people who have since left the team and the rows it
 * could not attribute to anybody, and it has nothing to drop from a
 * campaign-grouped aggregate. So the rows can add to LESS than the footer and the
 * Share column to less than 100%. The caller renders `contributionAsymmetryNote`
 * above the table whenever that is the case — the two figures are never adjacent
 * with nothing said, and the footer is never hidden to make the arithmetic tidy.
 * What that note does NOT do is equate the gap with the dropped rows' work: a
 * departed member who booked nothing moves no share, and `limit` cuts rows for an
 * unrelated reason.
 *
 * ── Same dialect as the roster, down to the stylesheet ────────────────────
 * The cells are `RosterCell`s, the words are **connects** and **conversions**, all
 * three absences render the way they do there (a real `0` is `0%`; a `null` is an
 * em dash and a phrase; a rate the server said not to quote is WORDS), and the CSS
 * module is literally the roster's. A supervisor is one click from one table to the
 * other and must not have to learn a second vocabulary in between.
 *
 * ── A row IS a way into that person's figures ─────────────────────────────
 * It opens the same two shared panels a roster row does, and it needs nothing
 * fabricated to do it: those panels are built against a user id and a name, which
 * is exactly what an `agent`-grouped row carries. Reaching them from here rather
 * than sending the reader back to the roster to find the same person is the
 * difference between one click and re-asking the question — and coming BACK lands
 * on this table, not on the roster, because this is where they were.
 *
 * A row with no `agent_user_id` is not pressable: an unattributable group is not a
 * person, and a control that looked identical and led nowhere is worse than a
 * plain cell. That is what `.agentStatic` remains for.
 *
 * ── There is no band, no chip and no bullet, deliberately ─────────────────
 * The grouped read carries no benchmark: a cohort of hours or of dispositions is
 * not a peer group, so the contract keeps comparison on the roster rather than
 * shipping a median with no meaning that a console would nonetheless render. It
 * does carry `rates_reportable`, so a thin row's connect and conversion rates are
 * withheld here exactly as they are on the roster — while Dials, Connects,
 * Conversions, Share and AHT stay on screen, because those are the figures that
 * show WHY the rates were withheld.
 */

export interface ContributionTableProps {
  page: AgencyGroupPage;
  /**
   * The campaign's own line, or `null` when it could not be read.
   *
   * A prop rather than something derived here, because it is a different request:
   * see the note above on why it is not the sum of `page.rows`.
   */
  total: AgencyGroupRow | null;
  /** What the campaign is called, resolved by the caller from the list it holds. */
  campaignName: string;
  /** What the table is called for a screen reader. */
  caption: string;
  /**
   * Open one person's figures.
   *
   * A {@link NamedAgent} rather than the whole row: that is the entire shape the
   * shared panels need (a user id, and the name master resolved for it), so nothing
   * about a roster row has to be invented to reach them. Optional, and a table
   * without it renders plain cells rather than dead controls.
   */
  onSelect?: (agent: NamedAgent) => void;
}

export function ContributionTable({
  page,
  total,
  campaignName,
  caption,
  onSelect,
}: ContributionTableProps) {
  return (
    <div className={styles.tableWrap} data-testid="contribution-table">
      <table className={styles.table}>
        <caption className={styles.srOnly}>{caption}</caption>
        <thead>
          <tr>
            {CONTRIBUTION_COLUMNS.map((column) => (
              <th
                key={column.label}
                scope="col"
                data-numeric={column.numeric ? 'true' : 'false'}
                /*
                  Derived from the SERVER's echoed sort, never from a flag on the
                  column, and derived in ONE place — `contributionAriaSort`, beside
                  the column list it reads. The flag read `ranked: true` on
                  Conversions (the order this view always asks for) while the caption
                  beside it read the echo, so a server that defaulted or clamped the
                  sort would have announced one column and captioned another.
                */
                aria-sort={contributionAriaSort(column, page)}
              >
                <span className={styles.headLabel}>{column.label}</span>
                {column.hint && <span className={styles.headHint}>{column.hint}</span>}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {page.rows.map((row, index) => (
            <ContributionRow
              key={contributionRowKey(row, index)}
              row={row}
              total={total}
              testId={contributionRowKey(row, index)}
              onSelect={onSelect}
            />
          ))}
        </tbody>

        {/*
          The campaign, pinned in a `<tfoot>` — the same place, the same styling and
          the same reasoning as the roster's team row: it is not one of the rows
          above, it must never look sortable or pressable, and `tfoot` is the
          element that says "the figure the rows are read against" to a screen
          reader without a label claiming it.
        */}
        <tfoot>
          <tr className={styles.teamRow} data-testid="contribution-total-row">
            <th scope="row">
              <span className={styles.teamName}>{CONTRIBUTION_TOTAL_LABEL}</span>
              {/*
                Named as the campaign rather than as a "Total", and said in words:
                this line is the denominator of the Share column, and a footer
                labelled "Total" leaves a reader to guess whether it totals the rows
                above it (it does not) or the campaign (it does). The campaign's own
                name is here too, because the reader arrived from a table of people.
              */}
              <span className={styles.subline}>
                {campaignName} · {CONTRIBUTION_TOTAL_SUBLINE}
              </span>
            </th>

            {total === null ? (
              /*
                The campaign line could not be read. One cell spanning the metrics,
                saying so — rather than seven em dashes, which read as seven
                separately absent figures rather than as one absent read. The rows
                above are unaffected and stay on screen; the caller says what
                happened.
              */
              <td colSpan={CONTRIBUTION_COLUMNS.length - 1}>
                <span className={styles.unmeasured} data-testid="contribution-total-missing">
                  <span className={styles.absentText}>—</span>
                  <span className={styles.subline}>
                    The campaign’s own total could not be read, so the rows above are shown
                    without it.
                  </span>
                </span>
              </td>
            ) : (
              <>
                <td data-numeric="true">{agentCount(total.attempts)}</td>
                <td data-numeric="true">{agentCount(total.connected)}</td>
                <td data-numeric="true">{agentCount(total.successes)}</td>
                {/*
                  The campaign's share of itself. It is `100%` whenever the campaign
                  booked anything, and that is worth rendering rather than blanking:
                  it is the total the column adds up to, and seeing it is how a
                  reader notices that the rows above it do not.
                */}
                <td data-numeric="true">
                  <MetricCell cell={contributionShareCell(total, total)} />
                </td>
                <td data-numeric="true">
                  <MetricCell cell={contributionConnectRateCell(total)} />
                </td>
                <td data-numeric="true">
                  <MetricCell cell={contributionConversionCell(total)} />
                </td>
                <td data-numeric="true">
                  <MetricCell cell={contributionHandleTimeCell(total)} />
                </td>
              </>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ContributionRow({
  row,
  total,
  testId,
  onSelect,
}: {
  row: AgencyGroupRowWithName;
  total: AgencyGroupRow | null;
  testId: string;
  onSelect?: (agent: NamedAgent) => void;
}) {
  const name = contributionAgentName(row);
  const agentUserId = row.key.agent_user_id;

  return (
    <tr data-testid={`contribution-row-${testId}`}>
      <th scope="row" className={styles.agentCell}>
        {onSelect && agentUserId ? (
          /*
            The whole name cell is the button, exactly as on the roster, so the row
            is reachable by keyboard and announced once. A `tabIndex` on the `<tr>`
            with a click handler would be focusable without being a control.

            What it hands up is a `NamedAgent` — the id off the group KEY (that is
            where a grouped row keeps it) and the name master resolved beside it,
            which is the whole shape the panels behind it are built against.
          */
          <button
            type="button"
            className={styles.rowButton}
            onClick={() => onSelect({ agent_user_id: agentUserId, agent_name: row.agent_name ?? null })}
            data-testid={`contribution-open-${agentUserId}`}
          >
            <span className={styles.avatar} aria-hidden="true">
              {agentInitials(name)}
            </span>
            <span className={styles.agentText}>
              <span className={contributionNameResolved(row) ? styles.name : styles.nameFallback}>
                {name}
              </span>
            </span>
          </button>
        ) : (
          /*
            No id, or no handler: a plain cell. An `agent`-grouped row without an
            `agent_user_id` is a contract violation rather than a person, and a
            control that looked identical and led nowhere is worse than a plain cell.
            See `.agentStatic` in the stylesheet.
          */
          <span className={styles.agentStatic}>
            <span className={styles.avatar} aria-hidden="true">
              {agentInitials(name)}
            </span>
            <span className={styles.agentText}>
              <span className={contributionNameResolved(row) ? styles.name : styles.nameFallback}>
                {name}
              </span>
            </span>
          </span>
        )}
      </th>

      <td data-numeric="true">{agentCount(row.attempts)}</td>
      <td data-numeric="true">{agentCount(row.connected)}</td>
      <td data-numeric="true">{agentCount(row.successes)}</td>
      <td data-numeric="true">
        <MetricCell cell={contributionShareCell(row, total)} />
      </td>
      <td data-numeric="true">
        <MetricCell cell={contributionConnectRateCell(row)} />
      </td>
      <td data-numeric="true">
        <MetricCell cell={contributionConversionCell(row)} />
      </td>
      <td data-numeric="true">
        <MetricCell cell={contributionHandleTimeCell(row)} />
      </td>
    </tr>
  );
}

/**
 * One metric, in whichever of its three states it is in.
 *
 * The roster's renderer, including the `withheld` arm's tooltip — the grouped read
 * now carries `rates_reportable`, so that arm is reachable, and the threshold is
 * named in the `title` for the roster's reason: every withheld cell would otherwise
 * repeat the same sentence, and a column of repeated sentences is one nobody reads.
 *
 * The sentence is `withheldRateTitle`'s, so it names the cell's own denominator —
 * dials for a connect rate, connects for a conversion rate. This file's own copy
 * said "calls" for both, which on a 41-dial/11-connect row claimed a shortfall of
 * the one number that was fine.
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

export default ContributionTable;
