import { useId } from 'react';
import { Check, TriangleAlert, Users } from 'lucide-react';
import { COMPARE_PAGE_MAX_AGENTS } from '@magick-agency/contracts/api/agency/compare';
import type { AgencyTeamAgentRow, AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';
import { formatCount } from '../../../utils/format/number';
import { initialsFor } from '../../../utils/initials';
import {
  CHOOSE_FLOOR,
  CHOOSE_ONE_CAMPAIGN_NOTE,
  CHOOSE_ONE_CAMPAIGN_TO_COMPARE_NOTE,
  breakMinutes,
  clockOrDash,
  compareDisabledReason,
  findingBadge,
  mainFloor,
  percent,
  pickLabel,
  picksLine,
  rateLabel,
  withheldWords,
} from '../../../utils/agency/team/teamCopy';
import { rowName, sortTeamRows } from '../../../utils/agency/team/teamSort';
import { inlineScale, inlineShare } from '../../../utils/agency/team/teamCharts';
import type { TeamSort } from '../../../utils/agency/team/teamUrl';
import styles from './Team.module.css';

/**
 * The agents (`docs/team-performance.md` §2 item 4): one row per cohort agent, sorted in the
 * browser (TP16) by the pills above it (toggle buttons, `aria-pressed`), each row's figures with
 * the team median's tick on its bar, and Worth a look from the answer's findings (TP15; only with
 * one campaign, TP7). With Compare agents on, up to three rows are picked ("Pick {name} to
 * compare", the count said politely to a screen reader) and Compare picked opens them (TP18).
 *
 * One semantic table at every width. On a wide screen it scrolls inside its card with the Agent
 * column held; below about 640px each row is laid out as a card (CSS only): the pick box, rank and
 * name, its badges, then the figures, each under its column's name (`data-label`).
 */
export interface TeamAgentsTableProps {
  data: AgencyTeamPerformance;
  label: string;
  /** "today", "last 7 days": the heading's period. */
  period: string;
  sort: TeamSort;
  onSort: (sort: TeamSort) => void;
  /** Compare agents is on: the pick boxes and Compare picked are offered. */
  canCompare: boolean;
  /**
   * The answer is for the filters on screen. While a new question loads, or after it failed, the
   * rows on screen are another question's: the pick boxes and Compare picked are disabled, so a
   * pick never opens Compare on the new filters with the old filters' agents.
   */
  canPickNow: boolean;
  picks: readonly string[];
  onTogglePick: (agentId: string) => void;
  onComparePicked: () => void;
}

export function TeamAgentsTable(props: TeamAgentsTableProps) {
  const { data, label, period, sort, onSort, canCompare, canPickNow, picks, onTogglePick, onComparePicked } = props;
  const titleId = useId();
  const sortId = useId();
  const reasonId = useId();
  const rows = sortTeamRows(data.agents, sort);
  const floor = mainFloor(data.main_outcome.kind);
  const callsScale = inlineScale(rows.map((r) => r.calls_handled), data.medians.calls_handled);
  const rateScale = inlineScale(rows.map((r) => (r.main.reportable ? r.main.value : null)), data.medians.main_rate);
  const full = picks.length >= COMPARE_PAGE_MAX_AGENTS;
  // Agents are picked only within one campaign (TP18, CP8): with All campaigns there are no boxes.
  const canPick = canCompare && data.comparable;
  const reason = compareDisabledReason(data.comparable, picks.length);
  const badges = new Map<string, Array<{ label: string; tone: 'best' | 'watch' }>>();
  if (data.comparable) {
    for (const f of data.findings) {
      const badge = findingBadge(f, label);
      if (badge) badges.set(f.agent_user_id, [...(badges.get(f.agent_user_id) ?? []), badge]);
    }
  }
  const sorts: Array<{ id: TeamSort; label: string }> = [
    { id: 'rate', label: rateLabel(label) },
    { id: 'calls', label: 'Calls handled' },
    { id: 'shortest', label: 'Shortest calls' },
  ];

  return (
    <section className={styles.card} aria-labelledby={titleId} data-testid="team-agents">
      <div className={styles.agentsHead}>
        <div className={styles.cardHead}>
          <Users size={16} aria-hidden="true" className={styles.cardIcon} />
          <h2 className={styles.cardTitle} id={titleId}>
            {`Agents · ${period}`}
          </h2>
        </div>
        <div className={styles.sortRow}>
          <span className={styles.sortLabel} id={sortId}>
            Sort by
          </span>
          <div className={styles.pills} role="group" aria-labelledby={sortId}>
            {sorts.map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.pill}
                aria-pressed={sort === s.id}
                onClick={() => onSort(s.id)}
                data-testid={`team-sort-${s.id}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {canCompare ? (
          <div className={styles.pickBar}>
            {canPick ? (
              <p className={styles.picksLine} role="status" aria-live="polite" data-testid="team-picks">
                {picksLine(picks.length)}
              </p>
            ) : null}
            <button
              type="button"
              className={`btn-primary ${styles.compareButton}`}
              disabled={reason !== null || !canPickNow}
              aria-describedby={reason ? reasonId : undefined}
              onClick={onComparePicked}
              data-testid="team-compare-picked"
            >
              <Users size={15} aria-hidden="true" />
              Compare picked
            </button>
          </div>
        ) : null}
      </div>
      {/* With All campaigns one note says both what is missing and why Compare picked is off. */}
      {!data.comparable ? (
        <p className={styles.note} id={reasonId} data-testid="team-choose-one">
          {canCompare ? CHOOSE_ONE_CAMPAIGN_TO_COMPARE_NOTE : CHOOSE_ONE_CAMPAIGN_NOTE}
        </p>
      ) : canCompare && reason ? (
        <p className={styles.hint} id={reasonId} data-testid="team-compare-reason">
          {reason}
        </p>
      ) : null}

      {/* Its own name: the section around it already carries the heading's. */}
      <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Agents table">
        {/* The roles restate the table's own: below 640px the rows are laid out as cards (CSS), and a
            browser drops a table's semantics once its parts are no longer displayed as one. */}
        <table className={styles.table} role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader" className={styles.agentCol}>
                Agent
              </th>
              <th scope="col" role="columnheader">Calls handled</th>
              <th scope="col" role="columnheader">{label}</th>
              <th scope="col" role="columnheader">Avg call</th>
              <th scope="col" role="columnheader">Choose outcome</th>
              <th scope="col" role="columnheader">Break</th>
              <th scope="col" role="columnheader">Worth a look</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row, i) => {
              const picked = picks.includes(row.agent_user_id);
              const rowBadges = badges.get(row.agent_user_id) ?? [];
              return (
                <tr key={row.agent_user_id} role="row" data-picked={picked || undefined} data-testid="team-row">
                  <th scope="row" role="rowheader" className={styles.agentCol}>
                    <span className={styles.agentCell}>
                      {canPick ? (
                        <input
                          type="checkbox"
                          className={styles.pickBox}
                          checked={picked}
                          disabled={!canPickNow || (!picked && full)}
                          aria-label={pickLabel(rowName(row))}
                          onChange={() => onTogglePick(row.agent_user_id)}
                        />
                      ) : null}
                      <span className={styles.rank}>{i + 1}</span>
                      <span className={styles.avatar} aria-hidden="true">
                        {initialsFor(rowName(row))}
                      </span>
                      <span className={styles.agentName} title={rowName(row)}>
                        {rowName(row)}
                        {row.departed ? <span className={styles.left}> (left)</span> : null}
                      </span>
                    </span>
                  </th>
                  <td role="cell" data-label="Calls handled">
                    <span className={styles.figure}>
                      <span className={`${styles.num} ${styles.figureNum}`}>{formatCount(row.calls_handled)}</span>
                      <InlineBar share={inlineShare(row.calls_handled, callsScale)} median={inlineShare(data.medians.calls_handled, callsScale)} />
                    </span>
                  </td>
                  <td role="cell" data-label={label}>
                    <MainCell row={row} floor={floor} scale={rateScale} median={inlineShare(data.medians.main_rate, rateScale)} />
                  </td>
                  <td role="cell" className={styles.num} data-label="Avg call">
                    {clockOrDash(row.avg_call_seconds)}
                  </td>
                  <td role="cell" className={styles.num} data-label="Choose outcome">
                    {row.choose.value === null ? (
                      '—'
                    ) : row.choose.reportable ? (
                      clockOrDash(row.choose.value)
                    ) : (
                      <>
                        <span className={styles.muted}>{clockOrDash(row.choose.value)}</span>
                        <span className={styles.cellSub}>{withheldWords(row.choose, CHOOSE_FLOOR)}</span>
                      </>
                    )}
                  </td>
                  <td role="cell" className={styles.num} data-label="Break">
                    {breakMinutes(row.break_seconds)}
                  </td>
                  <td role="cell" className={styles.worth} data-empty={rowBadges.length === 0 || undefined}>
                    <WorthALook badges={rowBadges} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.foot}>
        {/* No bars on a phone, so no tick to explain there. */}
        <span className={styles.tickNote}>Tick on a bar: the team median. </span>
        Rates under {formatCount(floor)} calls are said in words, not drawn.
      </p>
    </section>
  );
}

/** The main outcome: its count and rate, with a bar; under the floor, words and no bar. */
function MainCell({ row, floor, scale, median }: { row: AgencyTeamAgentRow; floor: number; scale: number; median: number | null }) {
  const { main } = row;
  if (!main.reportable || main.value === null) {
    return (
      <span className={styles.figure}>
        <span className={`${styles.num} ${styles.figureNum}`}>{formatCount(main.numerator)}</span>
        <span className={styles.withheld}>{withheldWords(main, floor)}</span>
      </span>
    );
  }
  return (
    <span className={styles.figure}>
      <span className={`${styles.num} ${styles.figureNum}`}>{formatCount(main.numerator)}</span>
      <span className={styles.rate}>{percent(main.value)}</span>
      <InlineBar share={inlineShare(main.value, scale)} median={median} />
    </span>
  );
}

/** A bar with the team median's tick, for the eye only: the number beside it is the figure. */
function InlineBar({ share, median }: { share: number | null; median: number | null }) {
  if (share === null) return null;
  return (
    <span className={styles.inlineBar} aria-hidden="true">
      <span className={styles.inlineFill} style={{ width: `${share}%` }} />
      {median !== null ? <span className={styles.medianTick} style={{ left: `${median}%` }} /> : null}
    </span>
  );
}

/** A row's badges; `badges` is empty unless the answer is comparable (the one place that rule is applied, above). */
function WorthALook({ badges }: { badges: ReadonlyArray<{ label: string; tone: 'best' | 'watch' }> }) {
  if (badges.length === 0) return <span className={styles.muted}>—</span>;
  return (
    <span className={styles.badges}>
      {badges.map((b) => (
        <span key={b.label} className={styles.badge} data-tone={b.tone} data-testid="team-badge">
          {b.tone === 'best' ? <Check size={13} aria-hidden="true" /> : <TriangleAlert size={13} aria-hidden="true" />}
          {b.label}
        </span>
      ))}
    </span>
  );
}
