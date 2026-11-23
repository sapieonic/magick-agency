import { useState } from 'react';
import { PillGroup } from '../../../../components/campaign-setup';
import type { CallingWindowState } from '../../../../utils/agencyCampaignConfigForm';
import {
  HOURS_PRESETS,
  DAY_PILLS,
  dayPillValues,
  daysFromPills,
  presetOfWindow,
  withPreset,
  type HoursChoice,
} from '../../../../utils/campaignSetup/hoursPresets';
import { CUSTOM_HOURS_FIELDS } from '../../../../utils/campaignSetup/agentsTiming';
import type { ConfigFieldErrors } from '../configFieldErrors';
import { CallingHoursFields } from '../CallingHoursFields';
import styles from './AgentsTimingStep.module.css';

export interface CallingHoursBlockProps {
  window: CallingWindowState;
  onChange: (next: CallingWindowState) => void;
  /** The step's field errors: a finding on the custom window's fields opens Custom. */
  errors: ConfigFieldErrors;
  readOnly?: boolean;
  /** Injectable for tests; the custom window's echo is clock-derived. */
  now?: Date;
}

/**
 * "When to call" (CS11): the hour presets or Custom (start, end, time zone), then the day pills.
 * The body of Agents & timing's block, and of a campaign template's Calling hours section
 * (CS21): it edits the calling window and nothing else.
 */
export function CallingHoursBlock({ window, onChange, errors, readOnly = false, now }: CallingHoursBlockProps) {
  const [customChosen, setCustomChosen] = useState(false);
  const hoursFinding = CUSTOM_HOURS_FIELDS.some((field) => errors.message(field) !== null);
  const hoursChoice: HoursChoice = customChosen || hoursFinding ? 'custom' : presetOfWindow(window);
  const hoursOptions = [
    ...HOURS_PRESETS.map((p) => ({ value: p.id as HoursChoice, label: p.label })),
    { value: 'custom' as HoursChoice, label: 'Custom' },
  ];

  return (
    <>
      <PillGroup
        legend="Calling hours"
        hideLegend
        options={hoursOptions}
        value={hoursChoice}
        onChange={(choice) => {
          if (choice === 'custom') {
            setCustomChosen(true);
            return;
          }
          setCustomChosen(false);
          onChange(withPreset(window, choice));
        }}
        disabled={readOnly}
        testId="hours-presets"
      />
      {hoursChoice === 'custom' ? (
        <div className={styles.custom} data-testid="custom-hours">
          <CallingHoursFields window={window} onChange={onChange} errors={errors} now={now} days={false} />
        </div>
      ) : (
        <p className={styles.hint} data-testid="hours-zone">
          {`In each customer’s own time zone; ${window.timezone} when it is not known.`}
        </p>
      )}
      <PillGroup
        multiple
        legend="Calling days"
        size="sm"
        options={DAY_PILLS}
        value={dayPillValues(window.days)}
        onChange={(values) => onChange({ ...window, days: daysFromPills(values) })}
        disabled={readOnly}
        describedBy={errors.describedBy('calling_days')}
        testId="calling-days"
      />
      {errors.render('calling_days')}
    </>
  );
}
