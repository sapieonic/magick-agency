import { useEffect, useId, useMemo, useState } from 'react';
import { BellRing, Headphones, LogIn, MessageCircle, Smartphone, TriangleAlert } from 'lucide-react';
import { formatTime } from '@magick-agency/web-ui/format';
import type { AgencyFloorAgent } from '@magick-agency/contracts/api/agency/floor';
import { AgentFloorDrawer } from '../../../components/agency/AgentFloorDrawer';
import { ComingSoonButton } from '../../../components/common/ComingSoon';
import { useListen } from '../../../components/listen/ListenProvider';
import { AGENCY_FLOOR_RISK_NOTE, AGENCY_FLOOR_TICK_MS, INBOUND_CALL_FLOOR_LABEL, isWarningRisk } from '../../../utils/agencyAgentFloor';
import { formatDuration } from '../../../utils/agencyClock';
import { initialsFor } from '../../../utils/initials';
import { listenToLabel, notListenableCopy } from '../../../utils/listen/listenCopy';
import { SOFTPHONE_BREAK_REASON_LABEL } from '../../../types/softphone';
import {
  FLOOR_CARD_LABELS,
  callsTodayText,
  cardsFor,
  floorBadges,
  floorNowLine,
  liveCallOf,
  offersMakeAvailable,
  rankFloorCards,
  stripeTone,
  type FloorCard,
  type FloorChipFilter,
} from '../../../utils/agency/liveFloorAgents';
import styles from './LiveFloor.module.css';

/** The shared second: every card's clock repaints together, once a second. */
function useFloorNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGENCY_FLOOR_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The account's agents as cards (Phase 2, from the floor read), ranked as the campaign floor ranks
 * (`rankFloorCards`): who needs a look first, then by state. `filter` is the chips' choice.
 *
 * A card's actions: Listen when the call can be listened to (the Live calls list's own start, so
 * the shell's listening bar takes over; a disabled Listen with the list's reason when it cannot;
 * none for a reader who cannot listen at all), Make available on a stuck wrap-up (the campaign
 * floor's drawer, with its confirmation), and Talk to agent, Join call and Send reminder, which are
 * coming (Phase 3 and 4) and shown as such.
 */
export function AgentGrid({
  rows,
  filter,
  clockOffsetMs,
  onChanged,
}: {
  rows: readonly AgencyFloorAgent[];
  filter: FloorChipFilter;
  clockOffsetMs: number;
  onChanged: () => void;
}) {
  const now = useFloorNow();
  const cards = useMemo(() => cardsFor(rankFloorCards(rows, now), filter), [rows, now, filter]);
  const [forcing, setForcing] = useState<FloorCard | null>(null);

  if (cards.length === 0) {
    return (
      <p className={styles.quiet} data-testid="home-agent-grid-empty">
        {rows.length === 0 ? 'No agents are on the floor or assigned to an active campaign.' : 'No agent is in this state right now.'}
      </p>
    );
  }
  return (
    <>
      <ul className={styles.agentGrid} data-testid="home-agent-grid">
        {cards.map((card) => (
          <AgentCard key={card.row.agent_user_id} card={card} clockOffsetMs={clockOffsetMs} onMakeAvailable={() => setForcing(card)} />
        ))}
      </ul>
      {forcing && (
        <AgentFloorDrawer
          // The analytics event's campaign; a soft-phone session has none.
          campaignId={forcing.row.campaign_id ?? ''}
          agent={forcing.agent}
          now={now}
          canSupervise
          sort="risk"
          onClose={() => setForcing(null)}
          onForced={() => {
            setForcing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function AgentCard({ card, clockOffsetMs, onMakeAvailable }: {
  card: FloorCard;
  clockOffsetMs: number;
  onMakeAvailable: () => void;
}) {
  const { row, displayName, risk, state } = card;
  const listen = useListen();
  const badges = floorBadges(row);
  const reasonId = useId();
  const live = state !== 'offline';
  const call = liveCallOf(row);
  const warning = isWarningRisk(risk) ? AGENCY_FLOOR_RISK_NOTE[risk] : null;
  const notListenable = listen?.canListen && call && !call.listenable && call.not_listenable_reason
    ? notListenableCopy(call.not_listenable_reason)
    : null;

  return (
    <li className={styles.agentCard} data-stripe={stripeTone(card)} data-testid={`home-agent-${row.agent_user_id}`}>
      <div className={styles.agentWho}>
        <span className={styles.avatar} data-state={state} aria-hidden="true">{initialsFor(displayName)}</span>
        <div className={styles.agentName}>
          <b>{displayName}</b>
          <span className={styles.stateTag} data-state={state}>{FLOOR_CARD_LABELS[state]}</span>
          {badges.mobile && (
            <span className={styles.agentBadge} title="On the mobile app">
              <Smartphone size={12} aria-hidden="true" />
              <span className="sr-only">Mobile app</span>
            </span>
          )}
          {badges.inbound && <span className={styles.agentBadge}>{INBOUND_CALL_FLOOR_LABEL}</span>}
          {badges.softphone && <span className={styles.agentBadge}>{SOFTPHONE_BREAK_REASON_LABEL}</span>}
          {badges.connectionLost && <span className={`${styles.agentBadge} ${styles.agentBadgeLost}`}>Connection lost</span>}
        </div>
      </div>

      <div className={styles.agentNow}>
        <span>{floorNowLine(row, formatTime)}</span>
        <span className={styles.agentClock} data-over={isWarningRisk(risk) && risk !== 'disconnected' ? 'true' : undefined}>
          {card.elapsedMs === null ? '—' : formatDuration(card.elapsedMs)}
        </span>
      </div>

      {warning && (
        <p className={styles.agentRisk} data-testid={`home-agent-risk-${row.agent_user_id}`}>
          <TriangleAlert size={12} aria-hidden="true" />
          {warning}
        </p>
      )}
      {notListenable && <p id={reasonId} className={styles.agentReason}>{notListenable}</p>}

      <div className={styles.agentFoot}>
        <span>{callsTodayText(row.calls_today)}</span>
        <span className={styles.agentActions}>
          {listen?.canListen && call && (call.listenable ? (
            <button
              type="button"
              className={`btn-secondary ${styles.iconButton}`}
              onClick={() => listen.listen(call, clockOffsetMs)}
              aria-label={listenToLabel(displayName)}
              title={listenToLabel(displayName)}
            >
              <Headphones size={15} aria-hidden="true" />
            </button>
          ) : notListenable ? (
            <button
              type="button"
              className={`btn-secondary ${styles.iconButton}`}
              disabled
              aria-label={listenToLabel(displayName)}
              aria-describedby={reasonId}
            >
              <Headphones size={15} aria-hidden="true" />
            </button>
          ) : null)}
          {live && (
            <ComingSoonButton compact className={`btn-secondary ${styles.iconButton}`} label={`Talk to ${displayName}`} tooltip={`Send ${displayName} a message they see on their screen.`}>
              <MessageCircle size={15} aria-hidden="true" />
            </ComingSoonButton>
          )}
          {row.call && (
            <ComingSoonButton compact className={`btn-secondary ${styles.iconButton}`} label={`Join ${displayName}’s call`} tooltip="Speak on the call, to the customer and the agent.">
              <LogIn size={15} aria-hidden="true" />
            </ComingSoonButton>
          )}
          {risk === 'long_break' && (
            <ComingSoonButton compact className={`btn-secondary ${styles.iconButton}`} label={`Send ${displayName} a reminder`} tooltip={`Remind ${displayName} that their break is over.`}>
              <BellRing size={15} aria-hidden="true" />
            </ComingSoonButton>
          )}
          {offersMakeAvailable(card) && (
            <button type="button" className={`btn-danger ${styles.smallButton}`} onClick={onMakeAvailable} aria-label={`Make ${displayName} available`}>
              Make available
            </button>
          )}
        </span>
      </div>
    </li>
  );
}
