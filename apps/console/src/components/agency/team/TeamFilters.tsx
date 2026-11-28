import { useId } from 'react';
import { CalendarDays, Megaphone } from 'lucide-react';
import { TEAM_WINDOW_PRESETS, type TeamWindowPreset } from '../../../utils/agency/team/teamUrl';
import styles from './Team.module.css';

/**
 * Team performance's two filters (`docs/team-performance.md` §2 item 1): When (Compare's presets,
 * with two dates for Custom) and Campaign ("All campaigns" first), and the line that says
 * everything below follows them. Native selects: a keyboard and a screen reader get them for free.
 */
export interface TeamFiltersProps {
  /** Null while the list loads. */
  campaigns: ReadonlyArray<{ id: string; name: string }> | null;
  /** Null: All campaigns. */
  campaignId: string | null;
  /** What a campaign the URL holds that the list leaves out is called. */
  heldName: string;
  onCampaign: (campaignId: string | null) => void;
  when: TeamWindowPreset;
  from: string | null;
  to: string | null;
  /** Today in the page's zone: the latest day a date picker offers. */
  today: string;
  onWindow: (preset: TeamWindowPreset) => void;
  onDates: (dates: { from: string | null } | { to: string | null }) => void;
  /** Why a custom window can't be read yet; shown only for a custom window. */
  dateError: string | null;
  /** What the figures on screen cover: "Today, up to 2:15 PM"; null before the first answer. */
  summary: string | null;
}

const ALL = '';

export function TeamFilters(props: TeamFiltersProps) {
  const { campaigns, campaignId, heldName, onCampaign, when, from, to, today, onWindow, onDates, dateError, summary } = props;
  const ids = useId();
  const listed = campaignId === null || (campaigns?.some((c) => c.id === campaignId) ?? false);
  return (
    <div className={styles.filterBlock}>
      <div className={styles.filters}>
        <div className={styles.selectWrap}>
          <CalendarDays size={15} aria-hidden="true" className={styles.selectIcon} />
          <label className="sr-only" htmlFor={`${ids}-when`}>
            When
          </label>
          <select
            id={`${ids}-when`}
            className={styles.select}
            value={when}
            onChange={(e) => onWindow(e.target.value as TeamWindowPreset)}
            data-testid="team-when"
          >
            {TEAM_WINDOW_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {when === 'custom' ? (
          <div className={styles.dates}>
            <label className={styles.dateField}>
              <span className={styles.dateLabel}>From</span>
              <input type="date" value={from ?? ''} max={today} onChange={(e) => onDates({ from: e.target.value || null })} data-testid="team-from" />
            </label>
            <label className={styles.dateField}>
              <span className={styles.dateLabel}>To</span>
              <input type="date" value={to ?? ''} max={today} onChange={(e) => onDates({ to: e.target.value || null })} data-testid="team-to" />
            </label>
          </div>
        ) : null}
        <div className={styles.selectWrap}>
          <Megaphone size={15} aria-hidden="true" className={styles.selectIcon} />
          <label className="sr-only" htmlFor={`${ids}-campaign`}>
            Campaign
          </label>
          <select
            id={`${ids}-campaign`}
            className={`${styles.select} ${styles.campaignSelect}`}
            value={campaignId ?? ALL}
            onChange={(e) => onCampaign(e.target.value === ALL ? null : e.target.value)}
            data-testid="team-campaign"
          >
            <option value={ALL}>All campaigns</option>
            {campaignId !== null && campaigns !== null && !listed ? <option value={campaignId}>{heldName}</option> : null}
            {campaignId !== null && campaigns === null ? <option value={campaignId}>Loading campaigns…</option> : null}
            {(campaigns ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <p className={styles.filterHint}>Everything below follows these two filters.</p>
      </div>
      {summary ? (
        <p className={styles.summary} data-testid="team-summary">
          {summary}
        </p>
      ) : null}
      {dateError && when === 'custom' ? (
        <p className={styles.inlineError} role="alert">
          {dateError}
        </p>
      ) : null}
    </div>
  );
}
