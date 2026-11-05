import { useId, useState } from 'react';
import { AbandonmentMeter } from '../../../components/agency/AbandonmentMeter';
import {
  ABANDONMENT_CEILING_MAX_PCT,
  ABANDONMENT_CEILING_MIN_PCT,
  ABANDONMENT_CEILING_REFERENCE_PCT,
  ABANDONMENT_CEILING_STEP_PCT,
  DEFAULT_ABANDONMENT_CEILING_PCT,
  ceilingAboveReference,
  ceilingFieldError,
  ceilingPctText,
} from '../../../utils/agency/abandonmentCeiling';
import { FieldError } from '../../../components/common/FieldError';
import { pct } from '../../../utils/format/number';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the editors `CampaignBehaviourSection` assembles: the abandonment ceiling
  (`abandonment_ceiling_pct`), the rolling 24-hour abandonment rate above which the
  campaign pauses itself. Bounds, rounding and copy live in
  `utils/agency/abandonmentCeiling.ts`; the error is `validateConfig`'s, keyed as
  the server keys its `details`, and arrives through the section's `errors`.

  Two controls on one value. The meter's line is the slider (drag it, or focus it
  and use the arrow keys); the number box beside it is for the supervisor who
  already knows the figure. The line is the same meter Insights later draws the
  measured rate against, on the same scale.
*/

const FIELD = 'abandonment_ceiling_pct';

interface AbandonmentCeilingFieldsProps {
  /** `abandonmentCeilingPct`: `NaN` while the box is empty, so the validator names it. */
  ceilingPct: number;
  /** `abandonmentCeilingStoredPct`, for the validator's rule (`abandonmentCeiling.ts`, "The range"). */
  storedPct: number | null;
  onChange: (next: number) => void;
  errors: ConfigFieldErrors;
  /**
   * A user who cannot write campaigns: the meter is a picture (no slider, no
   * pointer handlers) and the box is disabled. The value is still stated in the
   * lead sentence and the box.
   */
  readOnly?: boolean;
}

/** The value the box shows for a value set elsewhere (a drag, a load): `3`, `4.5`. */
function draftOf(value: number): string {
  return Number.isFinite(value) ? String(value) : '';
}

/** What the box's text means as a value: empty is "no value", not 0. */
function valueOf(draft: string): number {
  return draft.trim() === '' ? Number.NaN : Number(draft);
}

export function AbandonmentCeilingFields({
  ceilingPct,
  storedPct,
  onChange,
  errors,
  readOnly = false,
}: AbandonmentCeilingFieldsProps) {
  const inputId = useId();
  const leadId = useId();
  const warningId = useId();
  const errorId = useId();

  /*
    The box keeps its own text. Rendering `value={ceilingPct}` straight would
    rewrite what the supervisor is half-way through typing (`3.` reads back as
    `3`, an emptied box as `0`), so the text is local and only re-seeded when the
    value changes from somewhere else: a drag, a key on the slider, a load. A
    change that already matches the text (the echo of the supervisor's own
    typing) leaves it alone. Adjusted during render, React's pattern for state
    derived from a changed prop, so the box never paints one frame stale.
  */
  const [draft, setDraft] = useState(() => draftOf(ceilingPct));
  const [seen, setSeen] = useState(ceilingPct);
  if (!Object.is(seen, ceilingPct)) {
    setSeen(ceilingPct);
    if (!Object.is(valueOf(draft), ceilingPct)) setDraft(draftOf(ceilingPct));
  }

  /*
    The section's error is about the value it was given for. It arrives after a
    save attempt (the server's refusal, or `validateConfig`'s on a blocked submit)
    and the page keeps it until the next save, so once the supervisor moves the
    line it would describe a number no longer on screen: "Must be above 0" beside a
    perfectly good 4%. So the value the error arrived with is remembered (the same
    during-render adjustment as the draft, keyed on the message, which the pages
    clear at the start of every save), and once the value differs the field falls
    back to its own live check.
  */
  const sectionMessage = errors.message(FIELD);
  const [arrival, setArrival] = useState({ message: sectionMessage, value: ceilingPct });
  // A setState during render discards this render and runs it again with the new
  // state before anything commits, so `arrival` below is always current.
  if (arrival.message !== sectionMessage) setArrival({ message: sectionMessage, value: ceilingPct });
  const sectionCurrent = sectionMessage !== null && Object.is(arrival.value, ceilingPct);

  /*
    Save is disabled while this value is out of range, so a supervisor who typed 15
    would read "Fix the highlighted fields" with nothing highlighted if the field
    waited for a save attempt. So it names its own problem as soon as the value has
    one, and defers to the section's message while that one is about the value on
    screen.
  */
  const shown = sectionCurrent ? sectionMessage : ceilingFieldError(ceilingPct, storedPct);
  const errorIds = shown !== null ? errorId : undefined;
  const warn = ceilingAboveReference(ceilingPct);
  const warningIds = warn ? warningId : undefined;
  // The slider and the box describe one value alike: what it does (the lead), the
  // amber note when it shows, and the error when there is one.
  const describedBy = [leadId, warningIds, errorIds].filter(Boolean).join(' ');

  const limit = Number.isFinite(ceilingPct) ? ceilingPctText(ceilingPct) : 'the limit you set';

  return (
    <>
      <h3 className={styles.subhead}>Abandonment limit</h3>
      <div className="form-group">
        <p className={styles.sectionLead} id={leadId} data-testid="abandonment-ceiling-lead">
          {`The campaign pauses itself when more than ${limit} of the calls answered in the last 24 hours were abandoned: answered with no agent free to take them.`}
        </p>
        <div className={styles.ceilingRow}>
          <div className={styles.ceilingMeter}>
            <AbandonmentMeter
              ceilingPct={ceilingPct}
              editable={readOnly ? undefined : { onChange, label: 'Abandonment limit', describedBy }}
            />
          </div>
          <div className={styles.ceilingInput}>
            <label htmlFor={inputId}>Pause above (%)</label>
            <input
              id={inputId}
              type="number"
              inputMode="decimal"
              min={ABANDONMENT_CEILING_MIN_PCT}
              max={ABANDONMENT_CEILING_MAX_PCT}
              step={ABANDONMENT_CEILING_STEP_PCT}
              value={draft}
              disabled={readOnly}
              onChange={(event) => {
                setDraft(event.target.value);
                onChange(valueOf(event.target.value));
              }}
              aria-describedby={describedBy}
              aria-invalid={errorIds !== undefined ? true : undefined}
              data-testid="abandonment-ceiling-input"
            />
          </div>
        </div>
        <FieldError id={errorId} message={shown} className="error-text" />
        {/*
          A consequence, not an error: the save goes through. Whether a campaign
          falls under a dropped-call rule is the account's call, not the form's.
        */}
        {warn ? (
          <p className={styles.ceilingWarning} id={warningId} data-testid="abandonment-ceiling-warning">
            {`Above ${pct(ABANDONMENT_CEILING_REFERENCE_PCT)}, the limit most dropped-call rules set. Check the rules that apply to these calls before raising it.`}
          </p>
        ) : null}
        <p className={styles.hint} data-testid="abandonment-ceiling-hint">
          {`The default is ${pct(DEFAULT_ABANDONMENT_CEILING_PCT)}. On a live campaign a change takes effect at the next check and is recorded in the campaign’s activity.`}
        </p>
      </div>
    </>
  );
}
