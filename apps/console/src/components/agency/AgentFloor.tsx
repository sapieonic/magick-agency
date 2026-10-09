import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, WifiOff } from 'lucide-react';
import {
  handledShare,
  perAgentLabel,
  AGENCY_FLOOR_RISK_FLAG,
  AGENCY_FLOOR_RISK_NOTE,
  AGENCY_FLOOR_STATE_LABELS,
  AGENCY_FLOOR_TICK_MS,
  agentInitials,
  canForceAvailable,
  floorRiskSummary,
  floorStateSlices,
  floorTotals,
  floorZeroStates,
  hasResolvedName,
  isWarningRisk,
  rankFloor,
  secondsInStateBucket,
  stateSummary,
  type AgencyFloorSort,
  type RankedFloorAgent,
} from '../../utils/agencyAgentFloor';
import { formatDuration } from '../../utils/agencyClock';
import { trackAgencyFloorIntervention } from '../../analytics/events';
import type {
  AgencyAgentsByState,
  AgencySupervisorAgent,
  AgencyCampaignStats,
} from '../../types/agency-campaign';
import { AgentFloorDrawer } from './AgentFloorDrawer';
import styles from './AgentFloor.module.css';

/**
 * The agent floor — the half of the supervisor screen that answers
 * **which agent**.
 *
 * Everything else on the campaign aggregates: the health strip says the
 * campaign is not dialing, the Overview counters say five agents are on break.
 * Neither names a person, and every action a supervisor can take is aimed at
 * one. Those counters are a section away rather than directly
 * above — the strip's diagnosis still sits above this, on every section.
 *
 * ── A summary card, then a table ────────────────────────────────────────────
 * The floor used to be a grid of tiles, which cost four rows of vertical space
 * to say nine things and — because the columns were percentage-width — stretched
 * a name across a gulf on a wide screen. It is now two blocks: a card that says
 * how the floor is DISTRIBUTED (a stacked bar, its legend, and the warnings as
 * one sentence), and a dense table of the people themselves. The table's
 * identity, state and duration columns are FIXED widths and the measure — calls
 * handled — absorbs the slack, so the row reads at 1280px and at 2272px.
 *
 * ── The sort is the feature ─────────────────────────────────────────────────
 * All the ordering and threshold logic is in `utils/agencyAgentFloor`, which is
 * pure so the ranking can be asserted against fixtures that span ADJACENT ranks
 * rather than by looking at a table. This component renders the order it is
 * given and does not re-derive it.
 *
 * ── Time in state ticks here, from `state_since` ────────────────────────────
 * The server never sends a duration and the console must not ask for one. The
 * poll interval is ten seconds, so a server-computed "8m 41s" would be up to ten
 * seconds stale on arrival and would then sit frozen — which reads as a hung
 * screen precisely while a supervisor watches a wrap-up overrun. The interval
 * below is a repaint trigger and never a time source: every duration is
 * recomputed from the absolute anchor, so nothing accumulates and nothing
 * drifts (`utils/agencyClock`'s rule). One timer serves the whole table.
 */

export interface AgentFloorProps {
  /** Attributes the floor's analytics events to a campaign — never an agent identity. */
  campaignId: string;
  /** Null while the first load is in flight, or when the stats read failed. */
  stats: AgencyCampaignStats | null;
  /** The campaign's configured wrap-up window — rank 1's threshold. */
  wrapupSeconds?: number | null;
  /**
   * `hasPermission(role, 'agency.supervise')`, computed by the page.
   *
   * **This must be that exact permission.** The API gates
   * `POST /proxy/agency/sessions/:id/force-available` on
   * `requirePermission('agency.supervise')`; a looser gate here shows a
   * `viewer`, `operator` or `agent` a button that 403s on click, and a tighter
   * one hides a control from someone who holds it.
   */
  canSupervise: boolean;
  /** Re-read the campaign after a forced return, so the floor reflects it. */
  onForced: () => void;
}

/**
 * A repainting `now`.
 *
 * Kept in this file rather than in the pure module because it is a lifecycle
 * concern, and out of the rows so the whole table shares one timer instead of
 * running one per agent.
 */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Re-read on mount/activation too: a tab restored from the background can be
    // arbitrarily far from the last painted value, and waiting a full second to
    // correct it shows a stale duration at the worst moment.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), AGENCY_FLOOR_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** `state_since` that will not parse renders no digits — never `0:00`. */
function TimeInState({ elapsedMs }: { elapsedMs: number | null }) {
  if (elapsedMs === null) {
    return (
      <span className={styles.duration} data-testid="floor-duration-unknown">
        —
      </span>
    );
  }
  return (
    <span className={styles.duration} data-testid="floor-duration">
      {formatDuration(elapsedMs)}
    </span>
  );
}

/**
 * How the floor is distributed, above the people in it.
 *
 * The bar is `aria-hidden`: it is a picture of numbers that are stated in words
 * immediately below it, in the legend and in the roll-up line, and a screen
 * reader announcing six unlabelled bands adds nothing to either.
 */
function FloorSummary({
  agents,
  ranked,
  byState,
}: {
  agents: readonly AgencySupervisorAgent[];
  ranked: readonly RankedFloorAgent[];
  byState: AgencyAgentsByState | undefined;
}) {
  const slices = floorStateSlices(byState);
  const zeros = floorZeroStates(byState);
  const summary = stateSummary(byState);
  const risks = floorRiskSummary(ranked);
  const totals = floorTotals(agents);

  return (
    <section className={styles.summaryCard} aria-label="The floor right now">
      <div className={styles.summaryDistribution}>
        {slices.length > 0 && (
          <>
            <div className={styles.stateBar} aria-hidden="true">
              {slices.map((slice) => (
                <span
                  key={slice.state}
                  className={styles.stateBand}
                  data-state={slice.state}
                  style={{ width: `${slice.pct}%` }}
                />
              ))}
            </div>
            {/*
              The same distribution as one sentence. Visually redundant beside the
              legend, which is why it is only for assistive tech — but it is also
              the string the `agents` list cannot produce, so it is the one thing
              left standing in the unavailable branch below and keeps its id here
              so both readings are of the same line.
            */}
            <p className={styles.srOnly} data-testid="floor-state-summary">{summary}</p>
            <div className={styles.legend}>
              {slices.map((slice) => (
                <span key={slice.state} className={styles.legendItem}>
                  <span className={styles.swatch} data-state={slice.state} aria-hidden="true" />
                  {slice.label}
                  <strong className={styles.legendCount}>{slice.count.toLocaleString()}</strong>
                </span>
              ))}
              {zeros && (
                <span className={styles.legendZeros}>
                  <span className={styles.swatch} data-state="empty" aria-hidden="true" />
                  {zeros}
                </span>
              )}
            </div>
          </>
        )}

        {/*
          The ranking, said once in words. The rows carry the same flags, but a
          supervisor arriving at this section should not have to read nine of
          them to learn whether anyone needs them at all.
        */}
        {risks && (
          <p className={styles.riskPill} data-testid="floor-risk-summary">
            <AlertTriangle size={13} aria-hidden="true" />
            {risks}
          </p>
        )}
      </div>

      <div className={styles.readouts}>
        <div className={styles.readout}>
          <span className={styles.kicker}>Free to take a call</span>
          <span className={styles.readoutLine}>
            <span className={styles.readoutValueFree} data-testid="floor-available">
              {totals.available.toLocaleString()}
            </span>
            <span className={styles.readoutDenom}>of {totals.onShift.toLocaleString()} on shift</span>
          </span>
        </div>
        <div className={styles.divider} />
        <div className={styles.readout}>
          <span className={styles.kicker}>Calls handled this shift</span>
          <span className={styles.readoutLine}>
            <span className={styles.readoutValue} data-testid="floor-handled">
              {totals.handled.toLocaleString()}
            </span>
            {perAgentLabel(totals.perAgent) && (
              <span className={styles.readoutDenom}>{perAgentLabel(totals.perAgent)}</span>
            )}
          </span>
        </div>
      </div>
    </section>
  );
}

function AgentRow({
  ranked,
  busiest,
  canSupervise,
  onOpen,
}: {
  ranked: RankedFloorAgent;
  /** The floor's busiest agent — what this row's bar is drawn against. */
  busiest: number;
  canSupervise: boolean;
  onOpen: (agent: AgencySupervisorAgent) => void;
}) {
  const { agent, risk, displayName, elapsedMs } = ranked;
  const warning = isWarningRisk(risk);
  const note = AGENCY_FLOOR_RISK_NOTE[risk];
  const flag = AGENCY_FLOOR_RISK_FLAG[risk];
  const offerForce = canSupervise && canForceAvailable(agent);
  const share = handledShare(agent.calls_handled, busiest);
  const open = () => onOpen(agent);
  /*
    A click anywhere on the row is the mouse affordance; the keyboard path is
    the name button in the first cell and the action button in the last, both
    real `<button>`s with their own accessible names. A `<button>` cannot wrap a
    `<tr>` (the table would stop being a table), and `role="button"` on the row
    would take the same semantics away — so the row's own handler is deliberately
    an extra, never the only way in. Inner controls stop propagation so one
    press opens the drawer once.
  */
  const openFromControl = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    open();
  };

  return (
    <tr
      className={styles.row}
      data-testid={`floor-row-${agent.session_id}`}
      data-risk={risk}
      data-state={agent.state}
      data-warning={warning ? 'true' : 'false'}
      onClick={open}
      // The note is the row's tooltip too, so the flag glyph is never the only
      // carrier of what is wrong — the flag's own words sit beside it.
      title={note ?? undefined}
    >
      <td className={styles.agentTd}>
        <span className={styles.agentCell}>
          <span className={styles.avatar} aria-hidden="true">{agentInitials(displayName)}</span>
          <button
            type="button"
            className={styles.agentButton}
            onClick={openFromControl}
            // A fallback id is not a name, and a supervisor quoting it to support
            // should know that. `title` says so without spending a column on it.
            title={
              hasResolvedName(agent)
                ? displayName
                : `We couldn’t look up this person’s name. This is their user id: ${agent.agent_user_id}`
            }
          >
            <span className={hasResolvedName(agent) ? styles.name : styles.nameFallback}>{displayName}</span>
          </button>
          {/*
            `connected === false` only. `null` is the API's Redis read having failed,
            and rendering it as a dropped station would send a supervisor chasing
            an agent who is sitting right there.

            Rendered independently of the risk rank: an agent who is BOTH
            disconnected and overrunning a wrap-up ranks as the wrap-up, so the
            Actions cell would otherwise be the only place the dropped station
            could show and it is already taken.
          */}
          {agent.connected === false && (
            <WifiOff
              size={13}
              role="img"
              className={styles.offlineIcon}
              aria-label="Station disconnected — no heartbeat"
              data-testid={`floor-offline-${agent.session_id}`}
            />
          )}
        </span>
      </td>

      <td>
        <span className={styles.stateCell}>
          <span className={styles.stateDot} data-state={agent.state} aria-hidden="true" />
          <span className={styles.stateLabel}>
            {AGENCY_FLOOR_STATE_LABELS[agent.state]}
            {agent.state === 'break' && agent.break_reason ? ` · ${agent.break_reason}` : ''}
          </span>
        </span>
      </td>

      <td>
        <TimeInState elapsedMs={elapsedMs} />
      </td>

      <td>
        <span className={styles.handledCell}>
          <span className={styles.handledBar} aria-hidden="true">
            <span className={styles.handledFill} style={{ width: `${share}%` }} />
          </span>
          <span className={styles.handledCount}>{agent.calls_handled.toLocaleString()}</span>
        </span>
      </td>

      <td className={styles.actionsTd}>
        {offerForce ? (
          /*
            The remedy in place of the flag, on the one row that has one. The
            glyph moves onto the control rather than being dropped: a supervisor
            scanning for warnings must find this row too, and the row is already
            tinted for the same reason.

            Labelled with an ellipsis because it opens the drawer rather than
            acting — the irreversible press is behind that, and behind a confirm
            that names what the call loses.
          */
          <button
            type="button"
            className={warning ? styles.miniButtonWarn : styles.miniButton}
            onClick={openFromControl}
            title={note ?? undefined}
          >
            {warning && (
              <AlertTriangle size={12} aria-hidden="true" data-testid={`floor-warning-${agent.session_id}`} />
            )}
            End wrap-up…
          </button>
        ) : warning ? (
          <span className={styles.riskFlag} title={note ?? undefined}>
            <AlertTriangle
              size={12}
              role="img"
              aria-label={note ?? 'Needs attention'}
              data-testid={`floor-warning-${agent.session_id}`}
            />
            {flag}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

export function AgentFloor({ campaignId, stats, wrapupSeconds, canSupervise, onForced }: AgentFloorProps) {
  const [sort, setSort] = useState<AgencyFloorSort>('risk');
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  const agents = stats?.agents;
  const now = useTickingNow((agents?.length ?? 0) > 0);
  const summary = stateSummary(stats?.agents_by_state);

  const ranked = useMemo(
    () => rankFloor(agents ?? [], now, { wrapupSeconds, ahtSeconds: stats?.aht_seconds }, sort),
    [agents, now, wrapupSeconds, stats?.aht_seconds, sort],
  );

  /*
    Read out of the LIVE list rather than held in state, so a poll that changes
    the agent's state — or removes them from the floor entirely — is reflected in
    the open drawer instead of leaving a supervisor acting on a stale snapshot.
    An agent who leaves closes it (below).
  */
  const openAgent = openSessionId
    ? (agents ?? []).find((a) => a.session_id === openSessionId) ?? null
    : null;
  useEffect(() => {
    if (openSessionId && !openAgent) setOpenSessionId(null);
  }, [openSessionId, openAgent]);

  /*
    `undefined` and `[]` are different facts and are said differently. An absent
    roster is this payload not carrying one — an older server, or a
    partial read — and rendering it as "nobody is on this campaign" would be a
    confident claim about staffing drawn from our own ignorance. Same rule as
    `concurrency_in_use`.
  */
  if (agents === undefined) {
    return (
      <section className={styles.wrap} aria-labelledby="agent-floor-heading">
        <h2 className={styles.heading} id="agent-floor-heading">Agents</h2>
        <p className={styles.empty} data-testid="floor-unavailable">
          The per-agent list didn’t load with these figures.
          {typeof stats?.agents_live === 'number'
            ? ` ${stats.agents_live === 1 ? '1 agent is' : `${stats.agents_live} agents are`} on this campaign.`
            : ''}
        </p>
        {/*
          Defensive, and deliberately not load-bearing. **The API cannot currently
          produce this state**: `agents_by_state` is `agents.reduce(...)` over
          the very array `agents[]` comes from, tallied rather than queried
          separately precisely so the roll-up and the floor can never disagree.
          So the two arrive together or not at all, and this branch is unreachable
          today.

          It is here anyway because it costs a conditional and the alternative —
          a `!` on a field that is only co-derived by convention — is the kind of
          coupling that breaks silently if the API ever does split the two reads.

          Note this is also the branch that draws NO bar: an absent roll-up is
          "we don't know how the floor is distributed", and an empty bar would
          say "the floor is empty", which is the other payload entirely.
        */}
        {summary && (
          <p className={styles.stateSummary} data-testid="floor-state-summary">{summary}</p>
        )}
      </section>
    );
  }

  const busiest = floorTotals(agents).busiest;

  return (
    <section className={styles.wrap} aria-labelledby="agent-floor-heading">
      <div className={styles.header}>
        <h2 className={styles.heading} id="agent-floor-heading">
          Agents
          {agents.length > 0 && <span className={styles.count}>{agents.length}</span>}
        </h2>
      </div>

      {agents.length === 0 ? (
        <p className={styles.empty} data-testid="floor-empty">
          Nobody is on this campaign right now.
        </p>
      ) : (
        <>
          <FloorSummary agents={agents} ranked={ranked} byState={stats?.agents_by_state} />

          <section className={styles.tableCard} aria-label="Live agents">
            <div className={styles.tableHeader}>
              <div>
                <h3 className={styles.cardTitle}>Live agents</h3>
                <p className={styles.cardDesc}>
                  {sort === 'risk'
                    ? 'Ordered by what needs attention first, not alphabetically.'
                    : 'In alphabetical order, for roll-call.'}
                </p>
              </div>
              {agents.length > 1 && (
                <div className={styles.sortToggle} role="group" aria-label="Sort agents">
                  {/*
                    Risk first and selected by default — the default is what gets
                    used, and a floor sorted by name makes a supervisor read every
                    row to find the one that needs them. The alphabet is here for
                    roll-call, which is a real job, just not the urgent one.
                  */}
                  <button
                    type="button"
                    className={sort === 'risk' ? styles.sortActive : styles.sortButton}
                    aria-pressed={sort === 'risk'}
                    onClick={() => setSort('risk')}
                  >
                    Needs attention
                  </button>
                  <button
                    type="button"
                    className={sort === 'name' ? styles.sortActive : styles.sortButton}
                    aria-pressed={sort === 'name'}
                    onClick={() => setSort('name')}
                  >
                    By name
                  </button>
                </div>
              )}
            </div>

            <div className={styles.tableScroll}>
              <table className={styles.table}>
                {/*
                  Fixed widths on identity, state and duration; the measure takes
                  the slack. Percentages here are what stretched a name across
                  700px of empty row on a wide monitor.
                */}
                <colgroup>
                  <col className={styles.colAgent} />
                  <col className={styles.colState} />
                  <col className={styles.colFor} />
                  <col />
                  <col className={styles.colActions} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">State</th>
                    <th scope="col">For</th>
                    <th scope="col">Calls handled</th>
                    {/* Never an empty header cell — the column has a meaning even
                        when most rows have nothing in it. */}
                    <th scope="col" className={styles.actionsTd}>
                      <span className={styles.srOnly}>Needs attention</span>
                    </th>
                  </tr>
                </thead>
                <tbody data-testid="agent-floor-rows">
                  {ranked.map((entry) => (
                    <AgentRow
                      key={entry.agent.session_id}
                      ranked={entry}
                      busiest={busiest}
                      canSupervise={canSupervise}
                      onOpen={(agent) => {
                        // Bucketed state, never the agent's id/name — see events.ts.
                        trackAgencyFloorIntervention({
                          campaign_id: campaignId,
                          action: 'drawer_opened',
                          target_state: agent.state,
                          seconds_in_state_bucket: secondsInStateBucket(entry.elapsedMs),
                          sort,
                        });
                        setOpenSessionId(agent.session_id);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {openAgent && (
        <AgentFloorDrawer
          // Keyed on the session so switching rows resets the drawer's own
          // state (the reason box, in particular) rather than carrying one
          // agent's half-typed note onto another.
          key={openAgent.session_id}
          campaignId={campaignId}
          agent={openAgent}
          now={now}
          canSupervise={canSupervise}
          // The sort the floor was in when this drawer was opened, for the
          // force-available analytics event — never re-derived inside the
          // drawer, which has no notion of floor ordering.
          sort={sort}
          onClose={() => setOpenSessionId(null)}
          onForced={() => {
            setOpenSessionId(null);
            onForced();
          }}
        />
      )}
    </section>
  );
}

export default AgentFloor;
