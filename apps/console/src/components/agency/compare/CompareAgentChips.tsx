import { useState } from 'react';
import { COMPARE_PAGE_MAX_AGENTS, type AgencyCompareCohortAgent } from '@magick-agency/contracts/api/agency/compare';
import { pickedAgents } from '../../../utils/agency/compare/compareUrl';
import { plural } from '../../../utils/format/number';
import { agentColour } from './CompareCharts';
import styles from './Compare.module.css';

/**
 * Pick up to three agents (`docs/compare-agents.md` §2 item 2, CP1): a chip per agent of the
 * campaign's cohort, most calls first. An agent under the floor carries "few calls"; one whose
 * membership has ended is still in the cohort (CP8) and says so. A picked chip wears its
 * person's colour, which stays with them while others come and go.
 */

/** Past this many agents the chips get a filter box. */
const FILTER_FROM = 12;

export function cohortAgentName(agent: Pick<AgencyCompareCohortAgent, 'name' | 'agent_user_id'>): string {
  return agent.name?.trim() || `Agent ${agent.agent_user_id.slice(0, 6)}`;
}

export function pickHint(count: number): string {
  if (count >= COMPARE_PAGE_MAX_AGENTS) {
    return `${COMPARE_PAGE_MAX_AGENTS} agents is the most that stays readable, also for colour-blind viewers. Remove one to add another.`;
  }
  if (count === 0) return `Pick up to ${COMPARE_PAGE_MAX_AGENTS} agents to put side by side against the rest of the campaign’s agents.`;
  const left = COMPARE_PAGE_MAX_AGENTS - count;
  return `Pick ${left} more, or compare ${count === 1 ? 'one' : 'these two'} against the team.`;
}

export interface CompareAgentChipsProps {
  agents: readonly AgencyCompareCohortAgent[];
  slots: ReadonlyArray<string | null>;
  onToggle: (agentId: string) => void;
}

export function CompareAgentChips({ agents, slots, onToggle }: CompareAgentChipsProps) {
  const [filter, setFilter] = useState('');
  // Only the picks in this window's cohort count: one from a link who did not dial here holds no chip.
  const inCohort = new Set(agents.map((a) => a.agent_user_id));
  const picked = pickedAgents(slots).filter((id) => inCohort.has(id));
  const full = picked.length >= COMPARE_PAGE_MAX_AGENTS;
  const needle = filter.trim().toLowerCase();
  const shown = agents.filter((a) => slots.includes(a.agent_user_id) || !needle || cohortAgentName(a).toLowerCase().includes(needle));

  if (agents.length === 0) {
    return <p className={styles.hint}>No agent took calls on this campaign in this window. Choose a longer window or another campaign.</p>;
  }

  return (
    <>
      {agents.length > FILTER_FROM ? (
        <input
          type="search"
          className={styles.agentFilter}
          placeholder="Find an agent"
          aria-label="Find an agent"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : null}
      <div className={styles.chips} role="group" aria-label="Agents">
        {shown.map((agent) => {
          const slot = slots.indexOf(agent.agent_user_id);
          const on = slot >= 0;
          const blocked = !on && full;
          const marks = [!agent.reportable ? 'few calls' : null, !agent.active ? 'no longer active' : null].filter(Boolean);
          return (
            <button
              key={agent.agent_user_id}
              type="button"
              className={styles.chip}
              aria-pressed={on}
              aria-disabled={blocked || undefined}
              data-testid="compare-agent-chip"
              title={`${cohortAgentName(agent)}: ${plural(agent.calls, 'call')} on this campaign in this window`}
              onClick={() => {
                if (blocked) return;
                onToggle(agent.agent_user_id);
              }}
            >
              {on ? <span className={styles.dot} style={{ background: agentColour(slot) }} aria-hidden="true" /> : null}
              <span className={styles.chipName}>{cohortAgentName(agent)}</span>
              {marks.length > 0 ? <span className={styles.chipMark}>{`· ${marks.join(' · ')}`}</span> : null}
            </button>
          );
        })}
      </div>
      <p className={styles.hint} aria-live="polite">
        {pickHint(picked.length)}
      </p>
    </>
  );
}
