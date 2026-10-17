import {
  callingWindowEcho,
  type CallingWindowState,
} from '../../../utils/agencyCampaignConfigForm';
import { ISO_WEEKDAY_SHORT } from '../../../utils/format/weekdays';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the four editors `CampaignBehaviourSection` assembles. Every rule lives
  in `utils/agencyCampaignConfigForm.ts`; this is the markup and the copy that is
  itself the feature. `errors` is the section's, so every field's error id and
  `aria-describedby` come from one place.
*/

const DAYS = ISO_WEEKDAY_SHORT.map((label, i) => ({ iso: i + 1, label }));

const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

interface CallingHoursFieldsProps {
  window: CallingWindowState;
  onChange: (next: CallingWindowState) => void;
  errors: ConfigFieldErrors;
  /** Injectable for tests; the echo is clock-derived. */
  now?: Date;
}

/** When the campaign may dial: the window, its timezone, the days, and the echo. */
export function CallingHoursFields({ window: state, onChange, errors, now }: CallingHoursFieldsProps) {
  const setWindow = (patch: Partial<CallingWindowState>) => onChange({ ...state, ...patch });

  const toggleDay = (iso: number) => {
    const days = state.days.includes(iso)
      ? state.days.filter((day) => day !== iso)
      : [...state.days, iso].sort((a, b) => a - b);
    setWindow({ days });
  };

  return (
    <>
      <div className={styles.row}>
        <div className="form-group">
          <label htmlFor="window-start">Start</label>
          <input
            id="window-start"
            type="time"
            value={state.start}
            onChange={(event) => setWindow({ start: event.target.value })}
            aria-describedby={errors.describedBy('calling_window_start')}
          />
          {errors.render('calling_window_start')}
        </div>
        <div className="form-group">
          <label htmlFor="window-end">End</label>
          <input
            id="window-end"
            type="time"
            value={state.end}
            onChange={(event) => setWindow({ end: event.target.value })}
            aria-describedby={errors.describedBy('calling_window_end')}
          />
          {errors.render('calling_window_end')}
        </div>
        <div className="form-group">
          <label htmlFor="window-timezone">Default timezone</label>
          <input
            id="window-timezone"
            value={state.timezone}
            placeholder="Asia/Kolkata"
            list="campaign-timezone-options"
            onChange={(event) => setWindow({ timezone: event.target.value })}
            aria-describedby={errors.describedBy('default_timezone')}
          />
          <datalist id="campaign-timezone-options">
            {COMMON_TIMEZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          {errors.render('default_timezone')}
        </div>
      </div>

      <fieldset className={styles.days} aria-describedby={errors.describedBy('calling_days')}>
        <legend className={styles.legend}>Calling days</legend>
        {DAYS.map((day) => (
          <label key={day.iso} className={styles.day}>
            <input
              type="checkbox"
              checked={state.days.includes(day.iso)}
              onChange={() => toggleDay(day.iso)}
            />
            {day.label}
          </label>
        ))}
        {errors.render('calling_days')}
      </fieldset>

      {/* The echo — an inverted range is invisible in a pair of time inputs. */}
      <p className={styles.echo} data-testid="calling-window-echo">
        {callingWindowEcho(state, now)}
      </p>

      {/*
        Concurrency is displayed, never offered. There is no `/proxy/account-settings`
        route and none is being added — concurrency is a commercial lever, and an
        account that can raise its own limit can raise its own carrier spend.
        Broadcasts (not agency campaigns) now have a narrow READ-ONLY projection,
        `GET /proxy/calls/concurrency-limits`, and a per-broadcast "Simultaneous
        calls" cap that can only LOWER concurrency below that limit — never raise
        it. Nothing here changes: the agency pacing engine
        has no per-campaign cap, and this stays a read-out.
      */}
      <p className={styles.concurrency} data-testid="concurrency-note">
        Simultaneous calls are capped by your account&apos;s limit, which is shared with your AI
        calls. Contact support to change it.
      </p>
    </>
  );
}
