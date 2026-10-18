import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the four editors `CampaignBehaviourSection` assembles. Every rule lives
  in `utils/agencyCampaignConfigForm.ts`; this is the markup and the copy that is
  itself the feature. `errors` is the section's, so every field's error id and
  `aria-describedby` come from one place.
*/

interface WrapupFieldsProps {
  wrapupSeconds: number;
  autoReturn: boolean;
  onChange: (patch: { wrapupSeconds?: number; autoReturn?: boolean }) => void;
  errors: ConfigFieldErrors;
}

/** The wrap-up allowance, and whether the countdown returns an agent to the pool by itself. */
export function WrapupFields({ wrapupSeconds, autoReturn, onChange, errors }: WrapupFieldsProps) {
  return (
    <>
      <h3 className={styles.subhead}>Wrap-up</h3>
      <div className="form-group">
        <label htmlFor="wrapup-seconds">Wrap-up seconds (0 = none)</label>
        <input
          id="wrapup-seconds"
          type="number"
          min={0}
          max={600}
          value={wrapupSeconds}
          onChange={(event) => onChange({ wrapupSeconds: Number(event.target.value) })}
          aria-describedby={errors.describedBy('wrapup_seconds')}
        />
        {errors.render('wrapup_seconds')}
        <p className={styles.hint}>
          {wrapupSeconds === 0
            ? 'Agents go straight back to available after a call.'
            : `Agents get ${wrapupSeconds}s to finish their write-up before the next call.`}
        </p>
      </div>

      {/*
        The other half of wrap-up, and the half that decides how an agent's
        shift feels: with it on, the countdown puts them back in the pool by
        itself; with it off, they sit in wrap-up until they say they are done.
        The API has long supported it and nothing here ever sent
        it, so every campaign ran on the column default.
      */}
      <div className="form-group">
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={autoReturn}
            onChange={(event) => onChange({ autoReturn: event.target.checked })}
          />
          Send agents back to the pool automatically when wrap-up ends
        </label>
        <p className={styles.hint} data-testid="auto-return-hint">
          {/*
            Named separately for `wrapupSeconds === 0` because the API only starts
            a countdown when there is BOTH a window and this flag
            (`wrapup-manager.ts`): with no window there is nothing to count
            down, so the checkbox is stored but inert until a window exists.
            Greying it out would lose that stored choice.
          */}
          {wrapupSeconds === 0
            ? 'With no wrap-up window there is no countdown, so this only takes effect once you set one above.'
            : autoReturn
              ? `After ${wrapupSeconds}s an agent becomes available again on their own — they can be handed a new call without touching anything.`
              : 'An agent stays in wrap-up until they mark themselves ready, however long that takes. Nothing hands them a new call in the meantime.'}
        </p>
      </div>
    </>
  );
}
