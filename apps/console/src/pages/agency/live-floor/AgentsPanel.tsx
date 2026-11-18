import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { AgencyFloorAgent } from '@magick-agency/contracts/api/agency/floor';
import { homeFloor, type HomeCampaignRead } from '../../../utils/agency/home';
import { AGENT_CHIPS, agentChips, floorWords } from '../../../utils/agency/liveFloor';
import {
  FLOOR_CARD_LABELS,
  FLOOR_CARD_STATES,
  floorStateCounts,
  type FloorChipFilter,
} from '../../../utils/agency/liveFloorAgents';
import { formatCount } from '../../../utils/format/number';
import { ComingSoonBadge } from '../../../components/common/ComingSoon';
import { AgentGrid } from './AgentGrid';
import styles from './LiveFloor.module.css';

/** The floor read as the panel needs it (`useAgentFloor`, narrowed to the shown campaigns). */
export interface AgentsPanelFloor {
  rows: readonly AgencyFloorAgent[];
  clockOffsetMs: number;
  stale: boolean;
  onChanged: () => void;
}

/**
 * Agents: a card per agent (`AgentGrid`, from the floor read, B28b) with state chips that filter
 * it, the chips counted from the same rows. Until the floor answers, or when it cannot be read,
 * the panel is Phase 1's: the chips counted from each campaign's `agents_by_state` on the board,
 * and a link to each campaign's Agents tab. "Need help" is a state agents cannot raise yet
 * (Phase 3): its chip is marked coming soon and counts nothing.
 */
export function AgentsPanel({
  reads,
  floor,
  floorFailed = false,
}: {
  reads: readonly HomeCampaignRead[];
  floor?: AgentsPanelFloor | null;
  /** The floor read failed or was refused: say so beside the board's figures. */
  floorFailed?: boolean;
}) {
  const [filter, setFilter] = useState<FloorChipFilter>('all');

  return (
    <section className={styles.card} aria-labelledby="home-agents-heading">
      <div className={styles.chipRow}>
        <h2 id="home-agents-heading" className={styles.cardTitle}>
          <Users size={18} aria-hidden="true" />
          Agents
        </h2>
        {floor ? <FloorChips rows={floor.rows} filter={filter} onFilter={setFilter} /> : <BoardChips reads={reads} />}
        {floor?.stale && <span className={styles.staleTag} data-testid="home-agents-stale">Not refreshed</span>}
      </div>
      {floor ? (
        <AgentGrid rows={floor.rows} filter={filter} clockOffsetMs={floor.clockOffsetMs} onChanged={floor.onChanged} />
      ) : (
        <BoardFloor reads={reads} failed={floorFailed} />
      )}
    </section>
  );
}

function NeedHelpChip() {
  return (
    <li className={`${styles.chip} ${styles.chipSoon}`} data-state="help" data-testid="home-chip-help">
      <i aria-hidden="true" />
      Need help
      <ComingSoonBadge />
    </li>
  );
}

/** The chips over the floor's rows: buttons that filter the grid (`aria-pressed`). */
function FloorChips({ rows, filter, onFilter }: {
  rows: readonly AgencyFloorAgent[];
  filter: FloorChipFilter;
  onFilter: (filter: FloorChipFilter) => void;
}) {
  const { total, counts } = floorStateCounts(rows);
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
      <NeedHelpChip />
      {FLOOR_CARD_STATES.map((state) => chip(state, `${FLOOR_CARD_LABELS[state]} ${formatCount(counts[state])}`))}
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
      <NeedHelpChip />
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
function BoardFloor({ reads, failed }: { reads: readonly HomeCampaignRead[]; failed: boolean }) {
  const chips = agentChips(reads);
  const floor = homeFloor(reads);
  return (
    <>
      {failed && (
        <p className={styles.cardNote} data-testid="home-agents-unavailable">
          The agents’ cards didn’t load. These are each campaign’s figures.
        </p>
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
