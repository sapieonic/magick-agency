import { Plus, Trash2 } from 'lucide-react';
import { ISO_WEEKDAY_SHORT } from '../../../utils/format/weekdays';
import {
  isOvernight,
  weekdayHours,
  WEEKDAY_CLOSES,
  WEEKDAY_OPENS,
  type InboundRouteDraft,
} from '../../../utils/inbound/routeForm';
import { AGENCY_INBOUND_ROUTE_LIMITS as L, type AgencyInboundRouteWarning } from '../../../types/inbound';
import styles from '../../../components/agency/inbound/Inbound.module.css';
import { RouteWarnings, type RouteSectionProps } from './fields';

/** Where the hours are read: the route's time zone, named, so a route set up from elsewhere is noticed. */
export function hoursZoneCopy(timezone: string): string {
  const zone = timezone.trim();
  return zone ? `Times are in ${zone}, the route’s time zone.` : 'Times are in the route’s time zone, set above.';
}

/**
 * The route's weekly opening hours (overnight stretches included), in its time zone, named in the
 * card; with no hours the route is closed at all times, which its warning says.
 */
export function OpeningHoursCard({ draft, update, errors, warnings }: RouteSectionProps & { warnings: AgencyInboundRouteWarning[] }) {
  const setHours = (index: number, patch: Partial<InboundRouteDraft['hours'][number]>) =>
    update({ hours: draft.hours.map((h, i) => (i === index ? { ...h, ...patch } : h)) });
  return (
    <section className="card" aria-labelledby="ib-hours" data-testid="inbound-route-hours">
      <h2 className={styles.cardTitle} id="ib-hours">Opening hours</h2>
      <p className={styles.cardLead}>
        <strong data-testid="inbound-route-hours-zone">{hoursZoneCopy(draft.timezone)}</strong> A closing time earlier than the
        opening time runs past midnight into the next day; a closing time of 00:00 means midnight. With no hours, the
        route is closed at all times.
      </p>
      {errors.render('weekly_hours')}
      <RouteWarnings warnings={warnings} />
      <ul className={styles.rows}>
        {draft.hours.map((row, index) => {
          const at = `weekly_hours[${index}]`;
          return (
            <li key={index} className={styles.editRow} data-testid={`inbound-hours-${index}`}>
              <div className={styles.small}>
                <label htmlFor={`${at}-day`}>Day</label>
                <select id={`${at}-day`} value={row.day} onChange={(e) => setHours(index, { day: Number(e.target.value) })}>
                  {ISO_WEEKDAY_SHORT.map((label, i) => (
                    <option key={label} value={i + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.small}>
                <label htmlFor={`${at}-start`}>Opens</label>
                <input
                  id={`${at}-start`}
                  type="time"
                  value={row.start}
                  onChange={(e) => setHours(index, { start: e.target.value })}
                  aria-describedby={errors.describedBy(`${at}.start`)}
                />
                {errors.render(`${at}.start`)}
              </div>
              <div className={styles.small}>
                <label htmlFor={`${at}-end`}>Closes</label>
                <input
                  id={`${at}-end`}
                  type="time"
                  value={row.end}
                  onChange={(e) => setHours(index, { end: e.target.value })}
                  aria-describedby={[errors.describedBy(`${at}.end`), isOvernight(row) ? `${at}-overnight` : undefined].filter(Boolean).join(' ') || undefined}
                />
                {errors.render(`${at}.end`)}
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => update({ hours: draft.hours.filter((_, i) => i !== index) })}
                aria-label={`Remove ${ISO_WEEKDAY_SHORT[row.day - 1] ?? ''} ${row.start}–${row.end}`}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
              {isOvernight(row) ? (
                <p className={styles.rowNote} id={`${at}-overnight`}>
                  Overnight: closes at {row.end} on {ISO_WEEKDAY_SHORT[row.day % 7]}.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className={styles.buttonRow}>
        <button
          type="button"
          className={`btn-secondary ${styles.iconLabel}`}
          onClick={() => update({ hours: [...draft.hours, { day: 1, start: WEEKDAY_OPENS, end: WEEKDAY_CLOSES }] })}
          disabled={draft.hours.length >= L.WEEKLY_HOURS_MAX}
          data-testid="inbound-add-hours"
        >
          <Plus size={14} aria-hidden="true" /> Add hours
        </button>
        {draft.hours.length === 0 ? (
          <button type="button" className="btn-secondary" onClick={() => update({ hours: weekdayHours() })} data-testid="inbound-weekday-hours">
            Monday to Friday, {WEEKDAY_OPENS}–{WEEKDAY_CLOSES}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** Whole days the route is closed, whatever its hours say. */
export function HolidaysCard({ draft, update, errors }: RouteSectionProps) {
  const setHoliday = (index: number, patch: Partial<InboundRouteDraft['holidays'][number]>) =>
    update({ holidays: draft.holidays.map((h, i) => (i === index ? { ...h, ...patch } : h)) });
  return (
    <section className="card" aria-labelledby="ib-holidays" data-testid="inbound-route-holidays">
      <h2 className={styles.cardTitle} id="ib-holidays">Holidays</h2>
      <p className={styles.cardLead}>Closed all day on these dates (up to {L.HOLIDAY_SPAN_DAYS_MAX} days each), whatever the hours say.</p>
      {errors.render('holidays')}
      <ul className={styles.rows}>
        {draft.holidays.map((row, index) => {
          const at = `holidays[${index}]`;
          return (
            <li key={index} className={styles.editRow}>
              <div className={styles.small}>
                <label htmlFor={`${at}-from`}>First day</label>
                <input id={`${at}-from`} type="date" value={row.from} onChange={(e) => setHoliday(index, { from: e.target.value, ...(row.to ? {} : { to: e.target.value }) })} aria-describedby={errors.describedBy(`${at}.from`)} />
                {errors.render(`${at}.from`)}
              </div>
              <div className={styles.small}>
                <label htmlFor={`${at}-to`}>Last day</label>
                <input id={`${at}-to`} type="date" value={row.to} onChange={(e) => setHoliday(index, { to: e.target.value })} aria-describedby={errors.describedBy(`${at}.to`)} />
                {errors.render(`${at}.to`)}
              </div>
              <div className={styles.small}>
                <label htmlFor={`${at}-label`}>Label (optional)</label>
                <input id={`${at}-label`} value={row.label} maxLength={L.HOLIDAY_LABEL_MAX} placeholder="Christmas Day" onChange={(e) => setHoliday(index, { label: e.target.value })} aria-describedby={errors.describedBy(`${at}.label`)} />
                {errors.render(`${at}.label`)}
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => update({ holidays: draft.holidays.filter((_, i) => i !== index) })}
                aria-label={`Remove holiday ${row.label || row.from || index + 1}`}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={`btn-secondary ${styles.iconLabel}`}
        onClick={() => update({ holidays: [...draft.holidays, { from: '', to: '', label: '' }] })}
        disabled={draft.holidays.length >= L.HOLIDAYS_MAX}
        data-testid="inbound-add-holiday"
      >
        <Plus size={14} aria-hidden="true" /> Add holiday
      </button>
    </section>
  );
}
