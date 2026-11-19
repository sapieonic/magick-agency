import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AgencyFloorAgent } from '@magick-agency/contracts/api/agency/floor';
import { BellRing, Headphones, LogIn, MessageCircle, Smartphone, TriangleAlert } from 'lucide-react';
import { formatTime } from '@magick-agency/web-ui/format';
import { AgentFloorDrawer } from '../../../components/agency/AgentFloorDrawer';
import { ComingSoonButton } from '../../../components/common/ComingSoon';
import { useListen, type ListenContextValue } from '../../../components/listen/ListenProvider';
import { useNow, usePageVisible } from '../../../hooks/useNow';
import { AGENCY_FLOOR_RISK_NOTE, AGENCY_FLOOR_TICK_MS, INBOUND_CALL_FLOOR_LABEL, isWarningRisk, type AgencyFloorRisk } from '../../../utils/agencyAgentFloor';
import { elapsedSince, formatDuration } from '../../../utils/agencyClock';
import { initialsFor } from '../../../utils/initials';
import { listenToLabel, notListenableCopy } from '../../../utils/listen/listenCopy';
import { SOFTPHONE_BREAK_REASON_LABEL } from '../../../types/softphone';
import {
  FLOOR_CARD_LABELS,
  CONVERSATIONS_TODAY_NOTE,
  callsTodayText,
  cardsInState,
  floorBadges,
  floorNowLine,
  floorTimerAnchor,
  liveCallOf,
  offersMakeAvailable,
  sameFloorRow,
  stripeTone,
  type FloorCard,
  type FloorCardState,
  type FloorChipFilter,
  type FloorLiveCall,
} from '../../../utils/agency/liveFloorAgents';
import styles from './LiveFloor.module.css';

/**
 * The account's agents as cards (Phase 2, from the floor read), in the page's one ranking
 * (`rankFloorCards`, on the page's 5 s risk clock, the server's): who needs a look first, then by
 * state. `cards` are the shown campaign's; `filter` is the chips' choice.
 *
 * A card's actions: Listen when the call can be listened to (the Live calls list's own start, so
 * the shell's listening bar takes over; a disabled Listen with the list's reason when it cannot;
 * none for a reader who cannot listen at all), Make available on a stuck wrap-up (the campaign
 * floor's drawer, with its confirmation), and Talk to agent, Join call and Send reminder, which are
 * coming (Phase 3 and 4) and shown as such.
 *
 * The drawer holds the agent's session id, never a copy of the card: it reads the agent from every
 * new floor, as the campaign floor's does, and closes once the session is gone or no longer offers
 * Make available (an outcome saved, a break taken), so nobody forces a return the agent already made.
 *
 * Each poll answers new rows and each 5 s risk tick new cards, so a card is drawn from fields, not
 * from its `FloorCard`: its row (the last one kept while the next read says the same,
 * `sameFloorRow`), risk, state and name. A card whose agent shows nothing new skips its render;
 * the read's clock offset, a few ms off on every poll, reaches only the clocks and Listen through
 * {@link FloorClockOffset}, never the cards' props.
 */
export function AgentGrid({
  cards,
  filter,
  clockOffsetMs,
  onChanged,
}: {
  cards: readonly FloorCard[];
  filter: FloorChipFilter;
  clockOffsetMs: number;
  onChanged: () => void;
}) {
  const shown = useMemo(() => cardsInState(cards, filter), [cards, filter]);
  // The row each card was last drawn from, by agent: kept while the next read says the same.
  const keptRows = useRef<ReadonlyMap<string, AgencyFloorAgent>>(new Map());
  const rows = useMemo(() => {
    const next = new Map<string, AgencyFloorAgent>();
    for (const { row } of cards) {
      const kept = keptRows.current.get(row.agent_user_id);
      next.set(row.agent_user_id, kept && sameFloorRow(kept, row) ? kept : row);
    }
    return next;
  }, [cards]);
  useEffect(() => {
    keptRows.current = rows;
  }, [rows]);
  const [forcingId, setForcingId] = useState<string | null>(null);
  const makeAvailable = useCallback((sessionId: string | null) => setForcingId(sessionId), []);
  // From this floor, every time: the card at the click is a snapshot the next poll may contradict.
  const found = forcingId === null ? undefined : cards.find((card) => card.row.session_id === forcingId);
  const forcing = found && offersMakeAvailable(found) ? found : null;
  useEffect(() => {
    if (forcingId !== null && forcing === null) setForcingId(null);
  }, [forcingId, forcing]);

  if (shown.length === 0) {
    return (
      <p className={styles.quiet} data-testid="home-agent-grid-empty">
        {cards.length === 0 ? 'No agents are on the floor or assigned to an active campaign.' : 'No agent is in this state right now.'}
      </p>
    );
  }
  return (
    <>
      <FloorClockOffset.Provider value={clockOffsetMs}>
        <ul className={styles.agentGrid} data-testid="home-agent-grid">
          {shown.map((card) => (
            <AgentCard
              key={card.row.agent_user_id}
              row={rows.get(card.row.agent_user_id) ?? card.row}
              risk={card.risk}
              state={card.state}
              displayName={card.displayName}
              onMakeAvailable={makeAvailable}
            />
          ))}
        </ul>
      </FloorClockOffset.Provider>
      {forcing && (
        <ForcingDrawer
          key={forcing.agent.session_id}
          card={forcing}
          clockOffsetMs={clockOffsetMs}
          onClose={() => setForcingId(null)}
          onForced={() => {
            setForcingId(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** The campaign floor's drawer, on its own second (the server's) while it is open. */
function ForcingDrawer({ card, clockOffsetMs, onClose, onForced }: {
  card: FloorCard;
  clockOffsetMs: number;
  onClose: () => void;
  onForced: () => void;
}) {
  const now = useNow(AGENCY_FLOOR_TICK_MS) + clockOffsetMs;
  return (
    <AgentFloorDrawer
      // The analytics event's campaign; a soft-phone session has none.
      campaignId={card.row.campaign_id ?? ''}
      agent={card.agent}
      now={now}
      canSupervise
      sort="risk"
      callsLabel="Conversations today"
      onClose={onClose}
      onForced={onForced}
    />
  );
}

/** The floor read's clock offset (the server's clock minus the viewer's), for the cards' clocks and Listen. */
const FloorClockOffset = createContext(0);

/**
 * Time in the state, or on the call, from the server's anchor: the only thing on the floor's
 * one-second clock, so a tick repaints these digits and nothing else, and none while the tab is
 * hidden (it reads the time again on the way back).
 */
const Elapsed = memo(function Elapsed({ anchor }: { anchor: string | null }) {
  const offset = useContext(FloorClockOffset);
  const now = useNow(AGENCY_FLOOR_TICK_MS, usePageVisible());
  const elapsedMs = elapsedSince(anchor, 0, now + offset);
  return <>{elapsedMs === null ? '—' : formatDuration(elapsedMs)}</>;
});

/** Listen on a card: started on the server's clock as the read last gave it, at the click. */
function ListenButton({ call, displayName, onListen }: {
  call: FloorLiveCall;
  displayName: string;
  onListen: ListenContextValue['listen'];
}) {
  const offset = useContext(FloorClockOffset);
  return (
    <button
      type="button"
      className={`btn-secondary ${styles.iconButton}`}
      onClick={() => onListen(call, offset)}
      aria-label={listenToLabel(displayName)}
      title={listenToLabel(displayName)}
    >
      <Headphones size={15} aria-hidden="true" />
    </button>
  );
}

/**
 * One agent's card, from primitives and the kept row ({@link AgentGrid}), so the memo holds: an
 * equal read on the same risk renders no card.
 */
const AgentCard = memo(function AgentCard({ row, risk, state, displayName, onMakeAvailable }: {
  row: AgencyFloorAgent;
  risk: AgencyFloorRisk;
  state: FloorCardState;
  displayName: string;
  /** Opens Make available's drawer for a session: one setter for every card, so a card re-renders only when it changes. */
  onMakeAvailable: (sessionId: string | null) => void;
}) {
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
    <li className={styles.agentCard} data-stripe={stripeTone({ risk, state })} data-testid={`home-agent-${row.agent_user_id}`}>
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
          <Elapsed anchor={floorTimerAnchor(row)} />
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
        <span title={CONVERSATIONS_TODAY_NOTE}>{callsTodayText(row.calls_today)}</span>
        <span className={styles.agentActions}>
          {listen?.canListen && call && (call.listenable ? (
            <ListenButton call={call} displayName={displayName} onListen={listen.listen} />
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
          {offersMakeAvailable({ row, risk }) && (
            <button type="button" className={`btn-danger ${styles.smallButton}`} onClick={() => onMakeAvailable(row.session_id)} aria-label={`Make ${displayName} available`}>
              Make available
            </button>
          )}
        </span>
      </div>
    </li>
  );
});
