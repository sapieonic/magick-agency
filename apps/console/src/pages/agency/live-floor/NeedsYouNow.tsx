import { memo, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock,
  Coffee,
  Gauge,
  Headphones,
  Hourglass,
  LifeBuoy,
  MessageCircle,
  MicOff,
  PhoneMissed,
  PhoneOff,
  ShieldAlert,
  TrendingUp,
  TriangleAlert,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import { useHomeAcks } from '../../../hooks/useHomeAcks';
import { useTenant } from '../../../contexts/TenantContext';
import { useListen } from '../../../components/listen/ListenProvider';
import { HELP_KIND_PREFIX, homeNeeds, homeWaiting, type HomeAttentionItem } from '../../../utils/agency/home';
import type { MessageTarget } from '../../../utils/agency/floorAssist';
import { listenToLabel } from '../../../utils/listen/listenCopy';
import { attentionFor } from '../../../utils/agency/liveFloor';
import { formatTimeOrDate } from '../../../utils/format/date';
import { formatCount, plural } from '../../../utils/format/number';
import styles from './LiveFloor.module.css';

/** Whether Needs you now could check breaks over the limit (the floor read): see `breaks`. */
export type BreaksChecked = 'checked' | 'checking' | 'unchecked';

/**
 * Floor assist on the rows (LF4, LF5, LF28, LF29), present only while its flag is on: Talk to agent
 * and Send reminder (`agency.supervise`, the page's gate), Need help's Listen on the floor's clock,
 * and the chime's toggle.
 */
export interface NeedsYouNowAssist {
  onMessage: (target: MessageTarget) => void;
  /**
   * The floor read's latest clock offset, for Listen (as the cards start it). Read at the click, so
   * a poll that only moves the offset never re-renders the list.
   */
  clockOffsetMs: () => number;
  chime: { on: boolean; toggle: () => void };
}

/** "Give to free agents" on late callbacks (LF7, LF30): the campaigns it is offered on, and the opener. */
export interface NeedsYouNowHandOff {
  offered: ReadonlySet<string>;
  onGive: (campaign: { id: string; name: string }) => void;
}

/** The row's icon, by what it is about. */
function rowIcon(item: HomeAttentionItem): LucideIcon {
  const { kind } = item;
  if (kind.startsWith(HELP_KIND_PREFIX)) return LifeBuoy;
  if (kind.startsWith('stall:auto_paused')) return CirclePause;
  if (kind === 'stall:dnc_unavailable') return ShieldAlert;
  if (kind === 'stall:no_dialable_caller_ids') return PhoneOff;
  if (kind === 'stall:no_carrier_capacity' || kind === 'stall:concurrency_saturated') return Gauge;
  if (kind === 'stall:no_agents_available' || kind === 'no-agents' || kind === 'held-by-absent') return Users;
  if (kind === 'stall:outside_calling_hours' || kind === 'callbacks-overdue') return Clock;
  if (kind.startsWith('break-overrun')) return Coffee;
  if (kind === 'stall:list_exhausted_retries_pending') return Hourglass;
  if (kind === 'abandonment') return TrendingUp;
  if (kind === 'recordings-missing') return MicOff;
  if (kind === 'missed') return PhoneMissed;
  if (kind === 'stall:elevated_failure_rate' || kind === 'carrier-failures' || kind === 'calling-hours-default') return TriangleAlert;
  return CircleAlert;
}

/** The chime toggle's name, the same on and off: its `aria-pressed` says which (LF31). */
export const HELP_CHIME_LABEL = 'Need help sound';

/**
 * Needs you now (B28a's list, LF9's order): Home's attention rows, restyled. Every rule is Home's
 * (`homeAttention`), so the sidebar badge counts this list: the dangers and warnings, never an
 * information row, never a row put aside with "Got it". Live floor changes three things, each a
 * pure rule: one row for every campaign on the default calling hours (`groupCallingHours`), the
 * order (`HOME_RANKS`), and the floor's own rows (Need help, breaks over their limit) with their
 * actions: Listen, Talk to agent and Send reminder while floor assist is on (`assist`), and on late
 * callbacks whose owner is away, "Give to free agents" where it is offered (`handOff`). With a
 * campaign picked it shows that campaign's rows and says how many it leaves out
 * (not counting rows put aside). Never an all-clear from a read it could not refresh, nor while the
 * floor, where breaks over the limit come from, is unread (`breaks`).
 */
export const NeedsYouNow = memo(function NeedsYouNow({
  items,
  campaignId,
  campaignName,
  stale,
  lastUpdated,
  breaks = 'checked',
  onShowAll,
  assist = null,
  handOff = null,
}: {
  items: readonly HomeAttentionItem[];
  campaignId: string | null;
  campaignName: string | null;
  stale: boolean;
  lastUpdated: string | null;
  /**
   * Whether breaks over the limit were checked: the floor read answered and is fresh (`checked`),
   * is still on its way (`checking`), or failed, was refused or is stale (`unchecked`). Short of
   * `checked` the list can say nothing else needs the reader, never that nothing does.
   */
  breaks?: BreaksChecked;
  onShowAll: () => void;
  /** Floor assist's actions and chime; null while its flag is off (nothing shows). */
  assist?: NeedsYouNowAssist | null;
  /** Give to free agents; null while contact assignment is off. */
  handOff?: NeedsYouNowHandOff | null;
}) {
  const { tenantId, accountId } = useTenant();
  // "Got it" (B28a): rows the reader put aside, until they get worse or tomorrow.
  const { acks, acknowledge } = useHomeAcks(tenantId, accountId);
  const { open, acknowledged, elsewhere } = attentionFor(items, campaignId, acks);
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const needs = homeNeeds(open);
  const waiting = homeWaiting(open);
  const now = new Date();

  return (
    <section className={`${styles.card} ${styles.attentionCard}`} aria-labelledby="home-attention-heading">
      <div className={styles.cardHead}>
        <h2 id="home-attention-heading" className={styles.cardTitle}>
          <Bell size={18} aria-hidden="true" />
          Needs you now
          {needs.length > 0 && (
            <span className={styles.count} data-testid="home-attention-count">
              <span aria-hidden="true">{formatCount(needs.length)}</span>
              <span className="sr-only">{`, ${formatCount(needs.length)}`}</span>
            </span>
          )}
        </h2>
        <p className={styles.cardNote}>Each item clears itself once it’s fixed. “Got it” hides one until it gets worse, or until tomorrow</p>
        {assist && (
          <button
            type="button"
            className={`btn-secondary ${styles.smallButton}`}
            aria-pressed={assist.chime.on}
            onClick={assist.chime.toggle}
            title="Play a sound when an agent presses Need help. Kept for this browser."
            data-testid="home-help-chime"
          >
            {assist.chime.on ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
            {/* The name stays "Need help sound" whatever the state: `aria-pressed` says on or off,
                and a name that changed too would say it twice ("…sound off, not pressed"). */}
            {HELP_CHIME_LABEL}
            <span aria-hidden="true">{assist.chime.on ? ' on' : ' off'}</span>
          </button>
        )}
      </div>

      {needs.length > 0 ? (
        <ul className={styles.attentionList} data-testid="home-attention">
          {needs.map((item) => (
            <AttentionRow key={item.id} item={item} now={now} onAcknowledge={item.ackable ? acknowledge : undefined} assist={assist} handOff={handOff} />
          ))}
        </ul>
      ) : stale ? (
        // Never an all-clear from a read Live floor could not refresh.
        <p className={styles.quiet} data-testid="home-attention-unknown">
          {`Nothing needed you at ${lastUpdated ?? 'the last refresh'}, the last time Live floor could check.`}
        </p>
      ) : breaks !== 'checked' ? (
        // Nor from a floor it has not read: an agent may be on a break past the limit.
        <p className={styles.quiet} data-testid="home-attention-breaks-unknown">
          {`${homeNeeds(acknowledged).length > 0
            ? 'Nothing new on your campaigns needs you'
            : campaignName ? `Nothing on ${campaignName} needs you` : 'Nothing on your campaigns needs you'}${
            breaks === 'checking' ? '. Agents’ breaks are still being checked.' : ', but agents’ breaks couldn’t be checked.'}`}
        </p>
      ) : (
        <p className={styles.allClear} data-testid="home-attention-empty">
          <CircleCheck size={18} aria-hidden="true" />
          {homeNeeds(acknowledged).length > 0
            ? 'Nothing new needs you right now'
            : campaignName ? `Nothing needs you on ${campaignName} right now` : 'Nothing needs you right now'}
        </p>
      )}

      {elsewhere > 0 && (
        <p className={styles.elsewhere} data-testid="home-attention-elsewhere">
          <span>{`${plural(elsewhere, 'more thing')} on other campaigns or the account.`}</span>
          <button type="button" className={styles.linkButton} onClick={onShowAll}>Show all campaigns</button>
        </p>
      )}

      {waiting.length > 0 && (
        <div className={styles.waiting} data-testid="home-waiting">
          <h3 className={styles.waitingTitle}>For your information</h3>
          <ul className={styles.attentionList}>
            {waiting.map((item) => (
              <AttentionRow key={item.id} item={item} now={now} onAcknowledge={item.ackable ? acknowledge : undefined} assist={assist} handOff={handOff} />
            ))}
          </ul>
        </div>
      )}

      {acknowledged.length > 0 && (
        <div className={styles.waiting} data-testid="home-acknowledged">
          <button
            type="button"
            className={styles.linkButton}
            aria-expanded={showAcknowledged}
            onClick={() => setShowAcknowledged((shownNow) => !shownNow)}
          >
            {`${formatCount(acknowledged.length)} acknowledged · ${showAcknowledged ? 'Hide' : 'Show'}`}
          </button>
          {showAcknowledged && (
            <ul className={styles.attentionList} data-testid="home-acknowledged-list">
              {acknowledged.map((item) => (
                <AttentionRow key={item.id} item={item} now={now} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
});

/** One row; `onAcknowledge` offers "Got it" (left out on a row already put aside). */
function AttentionRow({ item, now, onAcknowledge, assist = null, handOff = null }: {
  item: HomeAttentionItem;
  now: Date;
  onAcknowledge?: (item: HomeAttentionItem) => void;
  assist?: NeedsYouNowAssist | null;
  handOff?: NeedsYouNowHandOff | null;
}) {
  const Icon = rowIcon(item);
  const listen = useListen();
  const { agent } = item;
  const call = agent?.call ?? null;
  const canListen = Boolean(listen?.canListen && call?.listenable);
  const giveTo = item.handOff && item.campaign && handOff?.offered.has(item.campaign.id) ? item.campaign : null;
  const [reviewing, setReviewing] = useState(false);
  const reviewId = useId();
  return (
    <li className={styles.attentionRow} data-tone={item.tone} data-testid={`home-attention-${item.id}`}>
      <span className={styles.rowIcon} aria-hidden="true">
        <Icon size={18} />
      </span>
      <div className={styles.attentionText}>
        <span className={styles.attentionTitle}>
          {item.title}
          {item.stale && <span className={styles.staleTag}>Not refreshed</span>}
        </span>
        <span className={styles.attentionDetail}>
          {item.campaign && <span className={styles.campaignName}>{item.campaign.name}</span>}
          {item.campaign && <span aria-hidden="true">{' · '}</span>}
          {item.at && (
            <>
              <time dateTime={item.at}>{formatTimeOrDate(item.at, now)}</time>
              <span aria-hidden="true">{' · '}</span>
            </>
          )}
          {item.detail}
        </span>
        {item.review && (
          <ul id={reviewId} className={styles.reviewList} hidden={!reviewing} data-testid={`home-review-${item.id}`}>
            {item.review.map((c) => (
              <li key={c.id}>
                <Link to={c.to}>{c.name}</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.rowActions}>
        {onAcknowledge && (
          <button
            type="button"
            className={`btn-secondary ${styles.smallButton}`}
            onClick={() => onAcknowledge(item)}
            aria-label={`Got it: ${item.campaign ? `${item.campaign.name}, ` : ''}${item.title}`}
            title="Hide this until it gets worse, or until tomorrow"
          >
            <Check size={14} aria-hidden="true" />
            Got it
          </button>
        )}
        {agent && call && canListen && listen && (
          <button
            type="button"
            className={`btn-secondary ${styles.smallButton}`}
            onClick={() => listen.listen(call, assist?.clockOffsetMs() ?? 0)}
            aria-label={listenToLabel(agent.name)}
          >
            <Headphones size={14} aria-hidden="true" />
            Listen
          </button>
        )}
        {agent && assist && (
          <button
            type="button"
            className={`btn-secondary ${styles.smallButton}`}
            onClick={() => assist.onMessage({ sessionId: agent.sessionId, name: agent.name, ...(agent.reminder !== undefined ? { reminder: agent.reminder } : {}) })}
            aria-label={agent.reminder !== undefined ? `Send ${agent.name} a reminder` : `Talk to ${agent.name}`}
          >
            {agent.reminder !== undefined ? <BellRing size={14} aria-hidden="true" /> : <MessageCircle size={14} aria-hidden="true" />}
            {agent.reminder !== undefined ? 'Send reminder' : 'Talk'}
          </button>
        )}
        {giveTo && handOff && (
          <button
            type="button"
            className={`btn-secondary ${styles.smallButton}`}
            onClick={() => handOff.onGive(giveTo)}
            aria-label={`Give ${giveTo.name}’s late callbacks to free agents`}
          >
            <UserPlus size={14} aria-hidden="true" />
            Give to free agents
          </button>
        )}
        {item.review ? (
          <button
            type="button"
            className={`btn-secondary ${styles.smallButton}`}
            aria-expanded={reviewing}
            aria-controls={reviewId}
            onClick={() => setReviewing((open) => !open)}
          >
            {item.action}
            <ChevronDown size={15} aria-hidden="true" className={reviewing ? styles.flipped : undefined} />
          </button>
        ) : (
          <Link to={item.to} className={`btn-secondary ${styles.smallButton}`}>
            {item.action}
            <ChevronRight size={15} aria-hidden="true" />
          </Link>
        )}
      </div>
    </li>
  );
}
