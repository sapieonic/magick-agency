import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { LIVE_FLOOR_TITLE, liveFloorClock, msToNextMinute } from '../../../utils/agency/liveFloor';
import type { HomeCampaignRef } from '../../../utils/agency/home';
import styles from './LiveFloor.module.css';

/**
 * The date and time, ticking on the minute. Its own state, so the tick repaints this line alone,
 * and a fixed width in tabular figures (the CSS), so the header never moves when it does.
 */
export function LiveFloorClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msToNextMinute(now));
    return () => clearTimeout(timer);
  }, [now]);
  const { date, time } = liveFloorClock(now);
  return (
    <time className={styles.when} dateTime={now.toISOString()} data-testid="live-floor-clock">
      <span>{date}</span>
      <span aria-hidden="true">·</span>
      <span className={styles.clock}>{time}</span>
    </time>
  );
}

/**
 * The page's title, the clock, the campaign filter and New campaign. The filter narrows everything
 * below it to one campaign (client side, over the board's campaigns); the page keeps the choice in
 * the URL.
 */
export function LiveFloorHeader({
  accountName,
  campaigns,
  selectedId,
  onSelect,
  canCreate,
  showFilter,
}: {
  accountName: string | undefined;
  campaigns: readonly HomeCampaignRef[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  canCreate: boolean;
  showFilter: boolean;
}) {
  const filterId = useId();
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        {accountName && <p className={styles.eyebrow}>{accountName}</p>}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{LIVE_FLOOR_TITLE}</h1>
          <LiveFloorClock />
        </div>
      </div>
      <div className={styles.headerActions}>
        {showFilter && (
          <>
            <label htmlFor={filterId} className="sr-only">Show campaign</label>
            <select
              id={filterId}
              className={styles.filter}
              value={selectedId ?? ''}
              onChange={(e) => onSelect(e.target.value || null)}
              data-testid="live-floor-filter"
            >
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </>
        )}
        {canCreate && (
          <Link to="/agency/campaigns/new" className={`btn-primary ${styles.headerAction}`}>
            <Plus size={16} aria-hidden="true" />
            New campaign
          </Link>
        )}
      </div>
    </header>
  );
}
