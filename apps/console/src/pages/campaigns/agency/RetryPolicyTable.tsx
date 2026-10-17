import {
  FIXED_ZERO_COPY,
  FIXED_ZERO_OUTCOMES,
  OUR_FAULT_RETRY_COPY,
  OUR_FAULT_RETRY_DEFAULT,
  OUR_FAULT_RETRY_OUTCOMES,
  OUR_FAULT_ZERO_WARNING,
  OUTCOME_LABELS,
  RETRY_OUTCOMES,
  VOICEMAIL_RETRY_COPY,
  retryPreview,
} from '../../../utils/agencyCampaignConfigForm';
import type { AgencyRetryOutcome, AgencyRetryPolicy } from '../../../types/agency-campaign';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the four editors `CampaignBehaviourSection` assembles. Every rule lives
  in `utils/agencyCampaignConfigForm.ts`; this is the markup and the copy that is
  itself the feature. `errors` is the section's, so every field's error id and
  `aria-describedby` come from one place.
*/

interface RetryPolicyTableProps {
  retryPolicy: AgencyRetryPolicy;
  onChange: (next: AgencyRetryPolicy) => void;
  errors: ConfigFieldErrors;
}

/**
 * The outcome retry policy: one row per outcome the dialer can retry, the two
 * fixed at zero shown rather than hidden, the plain-English previews and the
 * voicemail and our-fault callouts.
 */
export function RetryPolicyTable({ retryPolicy, onChange, errors }: RetryPolicyTableProps) {
  const setRetry = (outcome: AgencyRetryOutcome, patch: { delay?: number; max?: number }) => {
    /*
      The seed supplies whichever half the operator did NOT type, so it has to be
      a value that is safe to have been chosen for them.

      For an our-fault row, `max_attempts: 0` is not: the API reads
      `min(configured, OUR_FAULT_REDIAL_BOUND)` and retires the contact once
      `ourFaultAttemptsUsed >= effectiveBound`, so a zero it never saw typed
      meant one agent-side drop before connect permanently retired that contact.
      Typing a number into the *delay* box was enough to do it. Seeding from
      the API's own default keeps an untouched field at the API's behaviour, which is
      what an operator editing the other field is entitled to assume.
    */
    const seed = OUR_FAULT_RETRY_OUTCOMES.includes(outcome)
      ? OUR_FAULT_RETRY_DEFAULT
      : { max_attempts: 0 };
    const existing = retryPolicy[outcome] ?? seed;
    const next = {
      ...existing,
      ...(patch.max !== undefined ? { max_attempts: patch.max } : {}),
      ...(patch.delay !== undefined ? { delay_minutes: patch.delay } : {}),
    };
    onChange({ ...retryPolicy, [outcome]: next });
  };

  return (
    <>
      <h3 className={styles.subhead}>Retries</h3>
      <table className={styles.retryTable}>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col">Delay (minutes)</th>
            <th scope="col">Max attempts</th>
          </tr>
        </thead>
        <tbody>
          {RETRY_OUTCOMES.map((outcome) => {
            const fixed = FIXED_ZERO_OUTCOMES.includes(outcome);
            const ourFault = OUR_FAULT_RETRY_OUTCOMES.includes(outcome);
            const rule = retryPolicy[outcome];
            return (
              <tr key={outcome} data-our-fault={ourFault || undefined}>
                <th scope="row">{OUTCOME_LABELS[outcome]}</th>
                {fixed ? (
                  <td colSpan={2} className={styles.fixed} data-testid={`fixed-${outcome}`}>
                    Fixed at 0 — {FIXED_ZERO_COPY[outcome as keyof typeof FIXED_ZERO_COPY]}
                  </td>
                ) : (
                  <>
                    <td>
                      <input
                        type="number"
                        min={0}
                        aria-label={`${OUTCOME_LABELS[outcome]} delay in minutes`}
                        aria-describedby={errors.describedBy(`retry_policy.${outcome}.delay_minutes`)}
                        value={rule?.delay_minutes ?? ''}
                        onChange={(event) =>
                          setRetry(outcome, { delay: Number(event.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        aria-label={`${OUTCOME_LABELS[outcome]} max attempts`}
                        aria-describedby={errors.describedBy(`retry_policy.${outcome}.max_attempts`)}
                        value={rule?.max_attempts ?? ''}
                        onChange={(event) => setRetry(outcome, { max: Number(event.target.value) })}
                      />
                      {errors.render(`retry_policy.${outcome}.max_attempts`)}
                      {errors.render(`retry_policy.${outcome}.delay_minutes`)}
                      {/*
                        Not a validation error — 0 is a legitimate choice. It
                        is a consequence the word "0" does not convey beside a
                        field labelled "attempts": the API retires the contact
                        outright rather than merely skipping a redial.
                      */}
                      {ourFault && rule?.max_attempts === 0 && (
                        <p className={styles.zeroWarning} data-testid={`our-fault-zero-${outcome}`}>
                          {OUR_FAULT_ZERO_WARNING}
                        </p>
                      )}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      <ul className={styles.previews} data-testid="retry-previews">
        {RETRY_OUTCOMES.filter((outcome) => !FIXED_ZERO_OUTCOMES.includes(outcome)).map(
          (outcome) => (
            <li key={outcome}>{retryPreview(outcome, retryPolicy[outcome])}</li>
          ),
        )}
      </ul>

      <p className={styles.callout} data-testid="voicemail-retry-callout">
        {VOICEMAIL_RETRY_COPY}
      </p>

      {/*
        `agent_disconnected` and `canceled` (pilot
        2026-09-08): OUR
        fault, not the customer's. One callout for both rows — the rule it
        states is identical for each, and two paragraphs under one table would
        be read as one anyway.

        The earlier wording of this callout said the platform bound "cannot be
        raised from here" and called it "smaller". Both were misleading. The API
        takes `min(configured, OUR_FAULT_REDIAL_BOUND)`, so the row cannot
        raise it — true — but it CAN lower it, which is the half that bites;
        and the two are equal at 3, not smaller. An operator reading the old
        text would reasonably conclude this row could not affect the bound at
        all, and then set it to 0.
      */}
      <p className={styles.callout} data-testid="our-fault-retry-callout">
        {OUR_FAULT_RETRY_COPY}
      </p>
    </>
  );
}
