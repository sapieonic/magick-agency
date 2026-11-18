import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock,
  Gauge,
  Hourglass,
  MicOff,
  PhoneMissed,
  PhoneOff,
  ShieldAlert,
  TrendingUp,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { formatDate, formatTime } from '@magick-agency/web-ui/format';
import { useHomeAcks } from '../../../hooks/useHomeAcks';
import { useTenant } from '../../../contexts/TenantContext';
import { homeNeeds, homeWaiting, type HomeAttentionItem } from '../../../utils/agency/home';
import { splitAcknowledged } from '../../../utils/agency/homeAcks';
import { attentionFor, groupCallingHours } from '../../../utils/agency/liveFloor';
import { formatCount, plural } from '../../../utils/format/number';
import { ComingSoonButton } from '../../../components/common/ComingSoon';
import styles from './LiveFloor.module.css';

/** A time on today's date, else the date and time. */
function when(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? formatTime(iso) : formatDate(iso);
}

/** The row's icon, by what it is about. */
function rowIcon(item: HomeAttentionItem): LucideIcon {
  const { kind } = item;
  if (kind.startsWith('stall:auto_paused')) return CirclePause;
  if (kind === 'stall:dnc_unavailable') return ShieldAlert;
  if (kind === 'stall:no_dialable_caller_ids') return PhoneOff;
  if (kind === 'stall:no_carrier_capacity' || kind === 'stall:concurrency_saturated') return Gauge;
  if (kind === 'stall:no_agents_available' || kind === 'no-agents' || kind === 'held-by-absent') return Users;
  if (kind === 'stall:outside_calling_hours' || kind === 'callbacks-overdue') return Clock;
  if (kind === 'stall:list_exhausted_retries_pending') return Hourglass;
  if (kind === 'abandonment') return TrendingUp;
  if (kind === 'recordings-missing') return MicOff;
  if (kind === 'missed') return PhoneMissed;
  if (kind === 'stall:elevated_failure_rate' || kind === 'carrier-failures' || kind === 'calling-hours-default') return TriangleAlert;
  return CircleAlert;
}

/**
 * Needs you now (B28a's list, LF9's order): Home's attention rows, restyled. Every rule is Home's
 * (`homeAttention`), so the sidebar badge counts this list: the dangers and warnings, never an
 * information row, never a row put aside with "Got it". Live floor changes three things, each a
 * pure rule: one row for every campaign on the default calling hours (`groupCallingHours`), the
 * order (`HOME_RANKS`), and on late callbacks whose owner is away, a "Give to free agents" that is
 * coming. With a campaign picked it shows that campaign's rows and says how many it leaves out.
 * Never an all-clear from a read it could not refresh.
 */
export function NeedsYouNow({
  items,
  campaignId,
  campaignName,
  stale,
  lastUpdated,
  onShowAll,
}: {
  items: readonly HomeAttentionItem[];
  campaignId: string | null;
  campaignName: string | null;
  stale: boolean;
  lastUpdated: string | null;
  onShowAll: () => void;
}) {
  const { tenantId, accountId } = useTenant();
  const { shown, elsewhere } = attentionFor(items, campaignId);
  // "Got it" (B28a): rows the reader put aside, until they get worse or tomorrow.
  const { acks, acknowledge } = useHomeAcks(tenantId, accountId);
  const { open, acknowledged } = splitAcknowledged(groupCallingHours(shown), acks);
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
      </div>

      {needs.length > 0 ? (
        <ul className={styles.attentionList} data-testid="home-attention">
          {needs.map((item) => (
            <AttentionRow key={item.id} item={item} now={now} onAcknowledge={item.ackable ? acknowledge : undefined} />
          ))}
        </ul>
      ) : stale ? (
        // Never an all-clear from a read Live floor could not refresh.
        <p className={styles.quiet} data-testid="home-attention-unknown">
          {`Nothing needed you at ${lastUpdated ?? 'the last refresh'}, the last time Live floor could check.`}
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
              <AttentionRow key={item.id} item={item} now={now} onAcknowledge={item.ackable ? acknowledge : undefined} />
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
}

/** One row; `onAcknowledge` offers "Got it" (left out on a row already put aside). */
function AttentionRow({ item, now, onAcknowledge }: {
  item: HomeAttentionItem;
  now: Date;
  onAcknowledge?: (item: HomeAttentionItem) => void;
}) {
  const Icon = rowIcon(item);
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
              <time dateTime={item.at}>{when(item.at, now)}</time>
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
        {item.handOff && (
          <ComingSoonButton
            className={`btn-secondary ${styles.smallButton}`}
            tooltip={`Give the ${plural(item.handOff.count, 'late callback')} whose agent is away to agents who are free now.`}
            testId={`home-handoff-${item.id}`}
          >
            Give to free agents
          </ComingSoonButton>
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
