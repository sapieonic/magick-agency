import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Users } from 'lucide-react';
import type { AgencyFloorAgent } from '@magick-agency/contracts/api/agency/floor';
import { homeFloor, type HomeCampaignRead } from '../../../utils/agency/home';
import { AGENT_CHIPS, agentChips, floorWords } from '../../../utils/agency/liveFloor';
import {
  FLOOR_CARD_LABELS,
  FLOOR_CARD_STATES,
  floorStateCounts,
  type FloorCard,
  type FloorChipFilter,
} from '../../../utils/agency/liveFloorAgents';
import { formatCount } from '../../../utils/format/number';
import type { MessageTarget } from '../../../utils/agency/floorAssist';
import { AgentGrid } from './AgentGrid';
import styles from './LiveFloor.module.css';

/** The floor read as the panel needs it (`useAgentFloor`, narrowed to the shown campaigns). */
export interface AgentsPanelFloor {
  rows: readonly AgencyFloorAgent[];
  /** The same rows as cards, in the page's one ranking (`rankFloorCards` on its risk clock). */
  cards: readonly FloorCard[];
  clockOffsetMs: number;
  stale: boolean;
  onChanged: () => void;
  /**
   * Floor assist (LF4, LF5): the page's message dialog, or null while its flag is off, when the
   * cards offer no Talk or Send reminder and the panel no Need help chip.
   */
  onMessage?: ((target: MessageTarget) => void) | null;
}

/**
 * Agents: a card per agent (`AgentGrid`, from the floor read, B28b) with state chips that filter
 * it, the chips counted from the same rows. Until the floor answers, or when it cannot be read,
 * the panel is Phase 1's: the chips counted from each campaign's `agents_by_state` on the board,
 * and a link to each campaign's Agents tab. While floor assist is on, a "Need help" chip counts the
 * agents asking for help (LF4: on a call or in wrap-up as well, so it overlaps their state's chip)
 * and filters the grid to them; the board knows nothing of requests, so its chips have none.
 */
export function AgentsPanel({
  reads,
  floor,
  floorFailed = false,
  onRetryFloor,
}: {
  reads: readonly HomeCampaignRead[];
  floor?: AgentsPanelFloor | null;
  /** The floor read failed or was refused: say so beside the board's figures. */
  floorFailed?: boolean;
  /** Reads the floor again: a refused read asks nothing more until this (B28a). */
  onRetryFloor?: () => void;
}) {
  const [filter, setFilter] = useState<FloorChipFilter>('all');

  return (
    <section className={styles.card} aria-labelledby="home-agents-heading">
      <div className={styles.chipRow}>
        <h2 id="home-agents-heading" className={styles.cardTitle}>
          <Users size={18} aria-hidden="true" />
          Agents
        </h2>
        {floor ? <FloorChips rows={floor.rows} filter={filter} onFilter={setFilter} showHelp={Boolean(floor.onMessage)} /> : <BoardChips reads={reads} />}
        {floor?.stale && <span className={styles.staleTag} data-testid="home-agents-stale">Not refreshed</span>}
      </div>
      {floor ? (
        <AgentGrid cards={floor.cards} filter={filter} clockOffsetMs={floor.clockOffsetMs} onChanged={floor.onChanged} onMessage={floor.onMessage ?? null} />
      ) : (
        <BoardFloor reads={reads} failed={floorFailed} onRetry={onRetryFloor} />
      )}
    </section>
  );
}

/** The chips over the floor's rows: buttons that filter the grid (`aria-pressed`). */
function FloorChips({ rows, filter, onFilter, showHelp }: {
  rows: readonly AgencyFloorAgent[];
  filter: FloorChipFilter;
  onFilter: (filter: FloorChipFilter) => void;
  /** Floor assist is on: the Need help chip. */
  showHelp: boolean;
}) {
  const { total, help, counts } = floorStateCounts(rows);
  const chip = (id: FloorChipFilter, text: string) => (
    <li key={id}>
      <button
        type="button"
        className={`${styles.chip} ${styles.chipButton}`}
        data-state={id}
        aria-pressed={filter === id}
        onClick={() => onFilter(filter === id && id !== 'all' ? 'all' : id)}
        data-testid={`home-chip-${id}`}
      >
        {id !== 'all' && <i aria-hidden="true" />}
        {text}
      </button>
    </li>
  );
  return (
    <ul className={styles.chips} aria-label="Show agents by state" data-testid="home-agent-chips">
      {chip('all', `All ${formatCount(total)}`)}
      {(showHelp || filter === 'help') && chip('help', `Need help ${formatCount(help)}`)}
      {FLOOR_CARD_STATES
        // The soft phone's chip only while someone is on it (or it is the filter): most accounts have none.
        .filter((state) => state !== 'softphone' || counts.softphone > 0 || filter === 'softphone')
        .map((state) => chip(state, `${FLOOR_CARD_LABELS[state]} ${formatCount(counts[state])}`))}
    </ul>
  );
}

/** Phase 1's chips: counts per state from the board, not a filter. */
function BoardChips({ reads }: { reads: readonly HomeCampaignRead[] }) {
  const chips = agentChips(reads);
  return (
    <ul className={styles.chips} aria-label="Agents by state" data-testid="home-agent-chips">
      <li className={`${styles.chip} ${styles.chipAll}`} data-testid="home-chip-all">
        {`All ${formatCount(chips.total)}`}
      </li>
      {AGENT_CHIPS.map((chip) => (
        <li key={chip.id} className={styles.chip} data-state={chip.id} data-testid={`home-chip-${chip.id}`}>
          <i aria-hidden="true" />
          {`${chip.label} ${formatCount(chips.counts[chip.id])}`}
        </li>
      ))}
    </ul>
  );
}

/** Phase 1's floor: each campaign's agents in a few words, linking to its Agents tab. */
function BoardFloor({ reads, failed, onRetry }: { reads: readonly HomeCampaignRead[]; failed: boolean; onRetry?: () => void }) {
  const chips = agentChips(reads);
  const floor = homeFloor(reads);
  return (
    <>
      {failed && (
        <div className={styles.staleNote} role="status" data-testid="home-agents-unavailable">
          <span>The agents’ cards didn’t load. These are each campaign’s figures.</span>
          {onRetry && (
            <button type="button" className={`btn-secondary ${styles.action}`} onClick={onRetry}>
              <RefreshCw size={14} aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      )}
      {chips.partial && (
        <p className={styles.cardNote}>Some campaigns’ figures haven’t loaded, so the states add up to less than the total.</p>
      )}
      {floor.length > 0 ? (
        <div className={styles.floorLinks}>
          <p className={styles.cardNote}>Open a campaign’s Agents tab to see each agent:</p>
          <ul data-testid="home-floor">
            {floor.map((row) => (
              <li key={row.campaign.id}>
                <Link to={row.to}>{row.campaign.name}</Link>
                <span className={styles.quiet}>{` · ${floorWords(row.agentsLive)}`}</span>
                {row.stale && <span className={styles.staleTag}>Not refreshed</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={styles.quiet} data-testid="home-floor-none">No campaign is running and nobody is on the floor.</p>
      )}
    </>
  );
}
