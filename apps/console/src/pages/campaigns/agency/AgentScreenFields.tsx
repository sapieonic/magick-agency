import { useId } from 'react';
import type { AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import { AGENCY_DAILY_TARGET_CALLS_MAX, AGENCY_DAILY_TARGET_CALLS_MIN } from '../../../types/agency-campaign';
import { PHONE_DISPLAY_LABELS, PHONE_DISPLAY_SAMPLE, phoneAsShown } from '../../../utils/agency/stationSettings';
import { formatCount } from '../../../utils/format/number';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './StationSettings.module.css';

/**
 * Campaign Settings › What agents see: the day's target for each agent (AS6, `daily_target_calls`,
 * connected calls, 1–2,000, empty for none) and how the station shows the customer's number (AS9,
 * `phone_display`: Full number or Hidden number, `PHONE_DISPLAY_LABELS`, the activity log's words too,
 * with a preview of each). Errors come keyed by the server's field
 * names (`daily_target_calls`, `phone_display`), the page's live finding first.
 */
export function AgentScreenFields({
  dailyTarget,
  phoneDisplay,
  onChange,
  errors,
  readOnly = false,
}: {
  dailyTarget: string;
  phoneDisplay: AgencyPhoneDisplay;
  onChange: (patch: { dailyTarget?: string; phoneDisplay?: AgencyPhoneDisplay }) => void;
  errors: ConfigFieldErrors;
  readOnly?: boolean;
}) {
  const id = useId();
  const options: Array<{ value: AgencyPhoneDisplay; title: string; blurb: string }> = [
    { value: 'full', title: PHONE_DISPLAY_LABELS.full, blurb: 'Agents see the whole number.' },
    { value: 'masked', title: PHONE_DISPLAY_LABELS.masked, blurb: 'Agents see only the first two and last three digits.' },
  ];
  return (
    <div className={styles.stack}>
      <div className="form-group">
        <label htmlFor={`${id}-target`}>Daily target</label>
        <div className={styles.inline}>
          <input
            id={`${id}-target`}
            className={styles.numberInput}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="No target"
            value={dailyTarget}
            disabled={readOnly}
            onChange={(event) => onChange({ dailyTarget: event.target.value })}
            aria-invalid={errors.message('daily_target_calls') ? true : undefined}
            aria-describedby={[`${id}-target-hint`, errors.describedBy('daily_target_calls')].filter(Boolean).join(' ')}
            data-testid="daily-target"
          />
          <span className={styles.unit} aria-hidden="true">calls a day</span>
        </div>
        <p id={`${id}-target-hint`} className={styles.hint}>
          {`Calls where the customer spoke, for each agent, each day. Agents see how close they are on their screen. From ${formatCount(AGENCY_DAILY_TARGET_CALLS_MIN)} to ${formatCount(AGENCY_DAILY_TARGET_CALLS_MAX)}; leave it empty for no target.`}
        </p>
        {errors.render('daily_target_calls')}
      </div>

      <fieldset className={styles.fieldset} aria-describedby={errors.describedBy('phone_display')}>
        <legend className={styles.legend}>Customer’s number on the agent’s screen</legend>
        <div className={styles.choices}>
          {options.map((option) => (
            <label key={option.value} className={styles.choice} data-on={phoneDisplay === option.value ? '' : undefined}>
              <input
                type="radio"
                name={`${id}-phone-display`}
                value={option.value}
                checked={phoneDisplay === option.value}
                disabled={readOnly}
                onChange={() => onChange({ phoneDisplay: option.value })}
                data-testid={`phone-display-${option.value}`}
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>{option.title}</span>
                <span className={styles.preview} data-testid={`phone-display-preview-${option.value}`}>
                  {phoneAsShown(PHONE_DISPLAY_SAMPLE, option.value)}
                </span>
                <span className={styles.choiceBlurb}>{option.blurb}</span>
              </span>
            </label>
          ))}
        </div>
        <p className={styles.hint}>
          Hiding the number changes only what the screen shows. The soft phone and customer history still have the number.
        </p>
        {errors.render('phone_display')}
      </fieldset>
    </div>
  );
}
