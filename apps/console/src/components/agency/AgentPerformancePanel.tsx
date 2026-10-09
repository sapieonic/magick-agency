import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  AGENT_STATS_WINDOW_LABELS,
  OCCUPANCY_UNMEASURED_NOTE,
  agentCount,
  bucketSeries,
  campaignLabel,
  conversionRateReadout,
  handleTimeReadout,
  headlineTrio,
  isEmptyRange,
  occupancyBreakdown,
  occupancySegmentText,
  rowConnectRate,
  rowSeconds,
  wrapupReadout,
  type AgentStatsWindow,
} from '../../utils/agencyAgentPerformance';
import type { PerformanceReadout } from '../../utils/agencyCampaignPerformance';
import type { AgencyAgentStats, AgencyAgentStatsByCampaign } from '../../types/agency-stats';
import type { PeriodState, PeriodStates } from '../../hooks/useAgentPerformance';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { AgentBucketChart } from './AgentBucketChart';
import styles from './AgentPerformancePanel.module.css';

/**
 * One agent's shift, rendered — and the only component that renders it.
 *
 * ── Why one component serves two surfaces ──────────────────────────────────
 * `/dialer/performance` (the agent's own) and the supervisor's per-agent section
 * on `AgencyAnalyticsPage` read the same body from paired routes with different
 * floors. Giving each its own renderer would let the agent's view of their
 * numbers and their supervisor's view of the same numbers drift apart in
 * wording, in rounding, and in what counts as absent — and a coaching
 * conversation held over two different screens about one shift is worse than no
 * screen at all. So the panel is shared and the difference between the two
 * surfaces is entirely the shell around it and which route filled the props.
 *
 * ── The tiles are the window selector ──────────────────────────────────────
 * Every window is on screen at once, and pressing one re-focuses everything
 * below it. A separate selector would either duplicate the numbers or hide them
 * — and "how am I doing today against how I did last month" is the comparison
 * this page exists for, so every headline row stays visible whichever is
 * selected.
 *
 * ── Which windows is the CALLER's decision, not this component's ───────────
 * `windows` defaults to all five (`AGENT_STATS_WINDOWS`). It is a prop because
 * "three tiles fit in a row" was, for a while, the actual reason an agent could
 * not ask what they did last month — a layout constraint that had hardened into
 * a type and then into a product limit. A caller that wants fewer passes fewer;
 * nothing here assumes a count. The grid wraps rather than dividing by a fixed
 * number of columns, so adding a sixth window is a change to one array.
 *
 * ── Dials and conversations are never one number ───────────────────────────
 * Every tile carries `Dials · Connect rate · Conversations`, in that order, from
 * `headlineTrio`. That is a product rule rather than a layout preference:
 * "calls" is ambiguous in exactly the way that matters to the person being
 * measured on it. The rate sits between its own denominator and numerator so it
 * cannot be read as a fourth independent figure.
 */

export interface AgentPerformancePanelProps {
  periods: PeriodStates;
  selected: AgentStatsWindow;
  onSelect: (period: AgentStatsWindow) => void;
  /**
   * Which windows to render as tiles, in order — **the `windows` the hook
   * returned**, not a list assembled here.
   *
   * Required, and that is the point. It used to be optional and defaulted to
   * `AGENT_STATS_WINDOWS`, which `useAgentPerformance` also defaulted to
   * independently: two defaults agreeing by coincidence, with nothing tying them.
   * A window rendered here but not requested reads
   * `periods[window] ?? { status: 'loading' }` and spins forever; one requested
   * but not rendered is a request made for nothing. Taking it from the hook's
   * return makes divergence unrepresentable rather than merely discouraged.
   *
   * No stability requirement: the hook keys its effect on the list's CONTENTS
   * and returns one stable array, so an inline literal at the call site is fine.
   */
  windows: readonly AgentStatsWindow[];
  /** Rendered under the tiles. The agent's page states how far back they reach. */
  reachNote?: string;
  /**
   * Campaign id → name, for the per-campaign breakdown.
   *
   * A prop rather than a fetch, because the two surfaces have different lists to
   * resolve from and neither of them belongs to this component: the agent's page
   * has their staffing history, the supervisor's page already holds the account's
   * campaign list. `by_campaign[]` carries ids and no names — master's contract —
   * and an unmatched id renders as a shortened id rather than as a blank row.
   */
  campaignNames: ReadonlyMap<string, string | null>;
  /**
   * Narrow every period to one campaign, or leave the whole record in view.
   *
   * Optional, and absent means no control is rendered — a caller that has not
   * threaded the scope into `useAgentPerformance` must not show a selector whose
   * choice would change nothing, which is a worse control than none.
   *
   * The options come from `campaignNames`, so this offers exactly the campaigns
   * the caller could already name: on the agent's own page their staffing history
   * (ended assignments included), on the supervisor's the account's list. An id
   * the caller cannot name is deliberately not OFFERED — picking "Campaign
   * 4f21ab90" from a menu is not a choice anyone can make on purpose, and the
   * unnameable ids still appear in the breakdown below, where a shortened id is a
   * label rather than a decision.
   *
   * The one exception is an id already in `value`: a scope in force is always
   * shown and always clearable, even when it cannot be named. Offering a choice
   * and reporting an applied filter are different jobs, and only the first is
   * improved by being selective. See `showScope`.
   *
   * **`value` is the caller's to reset.** It is a campaign id from one workspace,
   * so a caller that keeps it across a tenant or account switch scopes the figures
   * to a campaign in a tenant the reader has left. `AgentPerformancePage` keys the
   * component that owns it by workspace and `AgentAnalyticsSection` keys its own
   * by `userId`; both remount rather than clearing in an effect, because an effect
   * runs after the render that has already issued the reads.
   */
  campaignFilter?: {
    value: string | null;
    onChange: (campaignId: string | null) => void;
  };
  /** Retry, offered on a failed period. */
  onRetry?: () => void;
}

export function AgentPerformancePanel({
  periods,
  selected,
  onSelect,
  windows,
  reachNote,
  campaignNames,
  campaignFilter,
  onRetry,
}: AgentPerformancePanelProps) {
  /*
    `undefined` when the caller has not asked for the selected window — a
    programming error rather than a state, but it renders as `loading` instead of
    throwing, because a panel that crashes on a prop mismatch takes the whole
    surface down for something that shows as an empty tile.
  */
  const active = periods[selected] ?? { status: 'loading' as const };
  /**
   * The tiles are the tablist and everything below them is the one panel they
   * control, following `PromptEditorPage`'s inspector: `aria-controls` on each
   * tab, `role="tabpanel"` on the region. `useId` rather than a literal, because
   * a page may one day carry two of these (an agent's own beside a colleague's)
   * and a duplicated id points both tablists at the first panel.
   */
  const detailId = useId();
  const scopeId = useId();

  /**
   * Only the campaigns this caller can name, sorted by that name.
   *
   * Sorted here rather than by the caller because the menu's order is this
   * component's business, and `campaignNames` arrives in whatever order the list
   * behind it happened to be in — staffing history is ordered by assignment date,
   * which is not an order anyone scans a menu in.
   */
  const scopeOptions = campaignFilter
    ? [...campaignNames.entries()]
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .sort((a, b) => a[1].localeCompare(b[1]))
    : [];

  /**
   * Whether the selector is on screen at all.
   *
   * "More than one answer" is the threshold — one campaign means the record
   * already IS that campaign's, so a selector would offer a filter whose only
   * setting changes nothing; none means an agent who has never been staffed, who
   * is being told that by the section below.
   *
   * **The second clause is not a widening of that, it is the thing that keeps it
   * honest.** The filter APPLIES whenever `value !== null`, so a visibility rule
   * that looked only at the option count could hide the control while a scope was
   * in force: the tiles counted one campaign, the note said so, and there
   * was nothing on screen to switch it off. That is exactly what a workspace
   * switch used to produce — a scope from the previous tenant, whose id is absent
   * from the new options list. The page now remounts the scope on a switch, so
   * this is the belt to that braces: an applied filter is always visible, whatever
   * put it there.
   */
  const showScope = Boolean(campaignFilter)
    && (scopeOptions.length > 1 || (campaignFilter?.value ?? null) !== null);

  return (
    <div className={styles.panel}>
      {campaignFilter && showScope && (
        /* See `showScope`: a choice to make, or a filter already in force. */
        <div className={styles.scope}>
          <label className={styles.scopeLabel} htmlFor={scopeId}>
            Campaign
          </label>
          <select
            id={scopeId}
            className={styles.scopeSelect}
            value={campaignFilter.value ?? ''}
            onChange={(event) => campaignFilter.onChange(event.target.value || null)}
            data-testid="campaign-scope"
          >
            <option value="">All campaigns</option>
            {scopeOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            {campaignFilter.value !== null
              && !scopeOptions.some(([id]) => id === campaignFilter.value) && (
              /*
                The applied scope, when the caller cannot name it. Without this
                option the `<select>` falls back to rendering "All campaigns"
                while the request is still scoped — a control that reports the
                opposite of what it is doing, and no way to clear it. Labelled
                with the shortened id rather than a name this client invented,
                the same degradation the breakdown below uses.
              */
              <option value={campaignFilter.value}>
                {campaignLabel(campaignFilter.value, campaignNames)}
              </option>
            )}
          </select>
          {campaignFilter.value !== null && (
            /*
              Says what the tiles now mean. Without it the period figures
              silently become one campaign's, and a reader who arrives at a
              scrolled page — or comes back to a tab — reads a campaign's morning
              as their whole morning.
            */
            <span className={styles.scopeNote} data-testid="campaign-scope-note">
              Every figure below counts this campaign only.
            </span>
          )}
        </div>
      )}

      <div className={styles.tiles} role="tablist" aria-label="Period">
        {windows.map((period) => (
          <PeriodTile
            key={period}
            period={period}
            state={periods[period] ?? { status: 'loading' }}
            selected={period === selected}
            onSelect={onSelect}
            controls={detailId}
          />
        ))}
      </div>

      {reachNote && (
        /*
          How far back these figures go, said once and near the tiles that
          decide it. Five windows read as "all of it" to somebody who has worked
          here a year, and the endpoint's 92-day cap means the furthest of them
          is last month — so the note names the surface that IS unbounded rather
          than leaving the ceiling to be discovered.
        */
        <p className={styles.scopeNote} data-testid="history-reach-note">
          {reachNote}
        </p>
      )}

      <HeadlineKey />

      <div id={detailId} role="tabpanel" className={styles.detail}>
        {active.status === 'loading' && (
          <div className={styles.centred}>
            <LoadingSpinner />
          </div>
        )}

        {active.status === 'error' && (
          <div className={styles.failed} data-testid="period-error">
            <p className={styles.failedTitle}>We couldn’t load {AGENT_STATS_WINDOW_LABELS[selected].toLowerCase()}</p>
            <p className={styles.failedBody}>{active.message}</p>
            {onRetry && (
              <button type="button" className={styles.retry} onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}

        {active.status === 'ready' && (
          <>
            {isEmptyRange(active.stats) && (
              /*
                Said once, plainly, instead of being left to be inferred from four
                em dashes and an empty table. "Nothing here" and "we couldn't read
                it" look identical when both are absences, and only one of them is
                the reader's own quiet morning.

                The rest of the panel still renders below it: occupancy is measured
                from station activity rather than from calls, so somebody who sat
                available all morning without a dial reaching them has a shift worth
                seeing — and that is exactly the person this message is for.
              */
              <p className={styles.emptyRange} data-testid="empty-range">
                No calls reached you {AGENT_STATS_WINDOW_LABELS[selected].toLowerCase()}.
              </p>
            )}

            <div className={styles.readouts}>
              <Readout label="Conversion rate" testId="conversion-rate-readout" readout={conversionRateReadout(active.stats.totals)} />
              <Readout label="Average call" testId="handle-time-readout" readout={handleTimeReadout(active.stats.totals)} />
              <Readout label="Wrap-up" testId="wrapup-readout" readout={wrapupReadout(active.stats.totals)} />
            </div>

            <AgentBucketChart series={bucketSeries(active.stats.buckets)} />

            <Occupancy stats={active.stats} />

            <CampaignBreakdown stats={active.stats} campaignNames={campaignNames} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One period, and the three numbers that are never collapsed.
 *
 * A `button` with `role="tab"` rather than a link: the period is view state on a
 * page that is already scoped to one person, and putting it in the URL would make
 * an agent's bookmark of their own page carry a range that is stale the next
 * morning.
 */
function PeriodTile({
  period,
  state,
  selected,
  onSelect,
  controls,
}: {
  period: AgentStatsWindow;
  state: PeriodState;
  selected: boolean;
  onSelect: (period: AgentStatsWindow) => void;
  controls: string;
}) {
  const totals = state.status === 'ready' ? state.stats.totals : undefined;
  const figures = headlineTrio(totals);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
      className={styles.tile}
      data-selected={selected ? 'true' : 'false'}
      data-testid={`period-tile-${period}`}
      onClick={() => onSelect(period)}
    >
      <span className={styles.tileLabel}>{AGENT_STATS_WINDOW_LABELS[period]}</span>
      {state.status === 'error' ? (
        /* Named rather than left blank. A tile with three em dashes and no
           explanation reads as "you did nothing", which is the one reading this
           page must never produce by accident. */
        <span className={styles.tileFailed} data-testid={`period-tile-${period}-failed`}>
          Didn’t load
        </span>
      ) : (
        <span className={styles.trio}>
          {figures.map((figure) => (
            <span key={figure.key} className={styles.figure} data-testid={`${period}-${figure.key}`}>
              <span className={figure.known ? styles.figureValue : styles.figureValueUnknown}>
                {state.status === 'loading' ? '…' : figure.value}
              </span>
              <span className={styles.figureLabel}>{figure.label}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * What the three headline figures actually count.
 *
 * ── Rendered once, not once per tile ────────────────────────────────────────
 * `headlineTrio` has always carried a `hint` per figure and this panel read none
 * of them, so an agent got a bare `Dials · Connect rate · Conversations` while
 * their supervisor's campaign screens explained every figure they showed. The
 * person being measured was the one left to guess, which is the wrong way round
 * for the same reason the null-not-zero rule is aimed at them.
 *
 * The tiles are compact and every one carries three figures, so a clause inside each
 * would bury the numbers they explain. One definition list beneath the tablist
 * says each thing once, and it is real text rather than a `title` — a tooltip is
 * a hint only for somebody holding a mouse.
 *
 * A `<dl>` rather than three lines of prose because the pairing has to survive
 * the label and its clause not being adjacent on screen: `<dt>`/`<dd>` is the
 * association, and it is what a screen reader reads as one item.
 *
 * The values are irrelevant here — `headlineTrio(undefined)` is called for its
 * labels and hints, which do not depend on a payload. Taking them from the
 * function rather than restating them is what keeps this and the tiles from
 * drifting into two vocabularies for one number.
 */
function HeadlineKey() {
  return (
    <dl className={styles.headlineKey} data-testid="headline-key">
      {headlineTrio(undefined).map((figure) => (
        <div key={figure.key} className={styles.headlineKeyRow}>
          <dt className={styles.headlineKeyTerm}>{figure.label}</dt>
          <dd className={styles.headlineKeyHint}>{figure.hint}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One derived figure.
 *
 * The same shape as `CampaignPerformance`'s readout, deliberately: an unknown
 * value is DIMMED and never coloured as a warning, because "we couldn't read
 * this" and "this number is bad" must not look alike — least of all to the person
 * the number is about.
 */
function Readout({
  label,
  testId,
  readout,
}: {
  label: string;
  testId: string;
  readout: PerformanceReadout;
}) {
  return (
    <div className={styles.readout} data-testid={testId} data-known={readout.known ? 'true' : 'false'}>
      <span className={styles.readoutLabel}>{label}</span>
      <span className={styles.valueRow}>
        <span className={readout.known ? styles.readoutValue : styles.readoutValueUnknown}>
          {readout.value}
        </span>
        {readout.secondary && <span className={styles.secondary}>{readout.secondary}</span>}
      </span>
      <span className={styles.readoutDetail}>{readout.detail}</span>
    </div>
  );
}

/**
 * Where the shift went — or, when there is no record, the sentence saying so.
 *
 * **A zeroed breakdown is never drawn.** Core computes occupancy from an event
 * log that shipped after the dialer, so a session predating it returns zeros
 * rather than nulls — and a bar built from those zeros claims an agent spent a
 * shift doing nothing. Same defect as printing a null rate as `0.0%`, aimed at
 * the same person. `occupancyBreakdown` makes the call; this component only obeys
 * it.
 *
 * **Signed-out time is not part of the shift and is not drawn.** Core's
 * `shift_seconds` excludes `offline` for the reason its own comment gives — an
 * agent who logged out at 17:00 was not on shift at 18:00 — so a bar that
 * included it would report a third of a worked hour on calls as a twentieth of a
 * day. That exclusion is also what makes the gap note below reachable: while
 * `offline` was in the sum, the recorded total could never fall short of a shift
 * that excludes it, and the sentence could never render.
 */
function Occupancy({ stats }: { stats: AgencyAgentStats }) {
  const breakdown = occupancyBreakdown(stats.totals.occupancy);

  return (
    <section className={styles.occupancy} aria-label="Where your time went">
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionHeading}>Where the time went</h3>
      </div>

      {!breakdown.measured ? (
        <p className={styles.unmeasured} data-testid="occupancy-unmeasured">
          <AlertTriangle size={13} className={styles.unmeasuredIcon} aria-hidden="true" />
          {OCCUPANCY_UNMEASURED_NOTE}
        </p>
      ) : (
        <>
          {/* Stacked, because these ARE parts of one whole — unlike dials and
              conversations above, which overlap and are therefore grouped. The
              2px gaps are surface-coloured rather than strokes: a border around
              a segment is ink that is not data. */}
          <div className={styles.bar} data-testid="occupancy-bar">
            {breakdown.segments.map((segment) => (
              <span
                key={segment.state}
                className={styles.barSegment}
                data-state={segment.state}
                style={{ flexBasis: `${segment.sharePct}%` }}
                title={`${segment.label}: ${occupancySegmentText(segment)}`}
              />
            ))}
          </div>
          <ul className={styles.occupancyList}>
            {breakdown.segments.map((segment) => (
              <li
                key={segment.state}
                className={styles.occupancyRow}
                data-testid={`occupancy-${segment.state}`}
              >
                <span className={styles.occupancyDot} data-state={segment.state} aria-hidden="true" />
                <span className={styles.occupancyLabel}>{segment.label}</span>
                <span className={styles.occupancyValue}>{occupancySegmentText(segment)}</span>
              </li>
            ))}
          </ul>
          {breakdown.unaccountedSeconds > 0 && (
            <p className={styles.note} data-testid="occupancy-gap">
              Some of this shift isn’t accounted for above — that happens when a station
              closes without signing out, and the shares are worked out from the time we
              can see.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Per campaign, for the range. Ids resolved through the caller's own list. */
function CampaignBreakdown({
  stats,
  campaignNames,
}: {
  stats: AgencyAgentStats;
  campaignNames: ReadonlyMap<string, string | null>;
}) {
  const rows: AgencyAgentStatsByCampaign[] = stats.by_campaign;

  return (
    <section className={styles.breakdown} aria-label="By campaign">
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionHeading}>By campaign</h3>
        <span className={styles.sectionMeta} data-testid="campaigns-worked">
          {stats.totals.campaigns === 1
            ? '1 campaign'
            : `${agentCount(stats.totals.campaigns)} campaigns`}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className={styles.note} data-testid="breakdown-empty">
          No calls on any campaign in this period.
        </p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table} data-testid="campaign-breakdown">
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Dials</th>
                <th scope="col">Connect rate</th>
                <th scope="col">Conversations</th>
                <th scope="col">Counted</th>
                <th scope="col">On calls</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.campaign_id} data-testid={`campaign-row-${row.campaign_id}`}>
                  <th scope="row">{campaignLabel(row.campaign_id, campaignNames)}</th>
                  <td>{agentCount(row.attempts)}</td>
                  {/* Derived here only because `by_campaign[]` carries no rates —
                      and guarded, so a campaign with no dials reads as an em dash
                      rather than as a 0% connect rate it has not earned. */}
                  <td>{rowConnectRate(row)}</td>
                  <td>{agentCount(row.connected)}</td>
                  <td>{agentCount(row.successes)}</td>
                  <td>{rowSeconds(row.talk_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default AgentPerformancePanel;
