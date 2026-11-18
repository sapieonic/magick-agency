import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import { homeFloor, type HomeCampaignRead } from '../../../utils/agency/home';
import { AGENT_CHIPS, agentChips, floorWords } from '../../../utils/agency/liveFloor';
import { formatCount } from '../../../utils/format/number';
import { ComingSoonBadge } from '../../../components/common/ComingSoon';
import styles from './LiveFloor.module.css';

/**
 * Agents: how many are in each state across the shown campaigns, as chips, and a way to each
 * campaign's own floor (its Agents tab), where every agent is. Phase 1 counts from each campaign's
 * `agents_by_state` on the board: the board carries no per-agent rows, and fetching each
 * campaign's `/stats` for them is what the board exists to avoid.
 *
 * Phase 2's seam: `grid` is the account-wide agent card grid (from the floor read), rendered in
 * place of the per-campaign links; the chips then become its filter. "Need help" is a state the
 * agents cannot raise yet (Phase 3), so its chip is marked coming soon and counts nothing.
 */
export function AgentsPanel({ reads, grid }: { reads: readonly HomeCampaignRead[]; grid?: ReactNode }) {
  const chips = agentChips(reads);
  const floor = homeFloor(reads);
  return (
    <section className={styles.card} aria-labelledby="home-agents-heading">
      <div className={styles.chipRow}>
        <h2 id="home-agents-heading" className={styles.cardTitle}>
          <Users size={18} aria-hidden="true" />
          Agents
        </h2>
        <ul className={styles.chips} aria-label="Agents by state" data-testid="home-agent-chips">
          <li className={`${styles.chip} ${styles.chipAll}`} data-testid="home-chip-all">
            {`All ${formatCount(chips.total)}`}
          </li>
          <li className={`${styles.chip} ${styles.chipSoon}`} data-state="help" data-testid="home-chip-help">
            <i aria-hidden="true" />
            Need help
            <ComingSoonBadge />
          </li>
          {AGENT_CHIPS.map((chip) => (
            <li key={chip.id} className={styles.chip} data-state={chip.id} data-testid={`home-chip-${chip.id}`}>
              <i aria-hidden="true" />
              {`${chip.label} ${formatCount(chips.counts[chip.id])}`}
            </li>
          ))}
        </ul>
      </div>
      {chips.partial && (
        <p className={styles.cardNote}>Some campaigns’ figures haven’t loaded, so the states add up to less than the total.</p>
      )}
      {grid ?? (
        floor.length > 0 ? (
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
        )
      )}
    </section>
  );
}
