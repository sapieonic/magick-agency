import { Sentence, SentenceSelect } from '../../../../components/campaign-setup';
import type { CampaignConfigState } from '../../../../utils/agencyCampaignConfigForm';
import {
  attemptOptions,
  delayOptions,
  startingRuleOf,
  unansweredRuleOf,
  withUnansweredRule,
} from '../../../../utils/campaignSetup/unansweredRule';
import styles from './AgentsTimingStep.module.css';

type RetryPolicy = CampaignConfigState['retryPolicy'];

export interface UnansweredRuleBlockProps {
  retryPolicy: RetryPolicy;
  onChange: (next: RetryPolicy) => void;
  readOnly?: boolean;
  /**
   * Where the full table is, when it is out of sight (Agents & timing's Advanced): the rules that
   * differ offer "See them in Advanced settings". Left out where the table is right below.
   */
  onSeeDetails?: () => void;
}

/**
 * "If the customer doesn't pick up" (CS12): one sentence writing one rule to every customer-side
 * unanswered result (`unansweredRule`), or, when the results already differ, what they are and
 * "Use one rule for all". The body of Agents & timing's block, and the head of a campaign
 * template's Retries section (CS21), above the full table.
 */
export function UnansweredRuleBlock({ retryPolicy, onChange, readOnly = false, onSeeDetails }: UnansweredRuleBlockProps) {
  const rule = unansweredRuleOf(retryPolicy);
  return (
    <div className={styles.tinted}>
      {rule.kind === 'same' ? (
        <>
          <Sentence testId="unanswered-sentence">
            Make up to{' '}
            <SentenceSelect
              value={String(rule.maxAttempts)}
              options={attemptOptions(rule.maxAttempts)}
              onChange={(v) => onChange(withUnansweredRule(retryPolicy, { ...rule, maxAttempts: Number(v) }))}
              ariaLabel="Calls in all to a customer who doesn’t pick up"
              disabled={readOnly}
              testId="unanswered-attempts"
            />{' '}
            in all
            {rule.maxAttempts > 1 ? (
              <>
                ,{' '}
                <SentenceSelect
                  value={String(rule.delayMinutes)}
                  options={delayOptions(rule.delayMinutes)}
                  onChange={(v) => onChange(withUnansweredRule(retryPolicy, { ...rule, delayMinutes: Number(v) }))}
                  ariaLabel="Time between calls"
                  disabled={readOnly}
                  testId="unanswered-delay"
                />{' '}
                apart.
              </>
            ) : (
              '.'
            )}
          </Sentence>
          <p className={styles.hint}>
            {onSeeDetails
              ? 'If the line is busy, switched off or the call can’t connect, the same rule applies. A call our side drops has its own limit, under Advanced settings.'
              : 'If the line is busy, switched off or the call can’t connect, the same rule applies. A call our side drops has its own limit, in the table below.'}
          </p>
        </>
      ) : (
        <div data-testid="unanswered-mixed">
          <p className={styles.mixedSummary}>{`${rule.summary}.`}</p>
          <ul className={styles.mixedList}>
            {rule.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className={styles.actions}>
            {onSeeDetails ? (
              <button type="button" className={styles.linkButton} onClick={onSeeDetails} data-testid="unanswered-see-advanced">
                See them in Advanced settings
              </button>
            ) : null}
            {readOnly ? null : (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => onChange(withUnansweredRule(retryPolicy, startingRuleOf(retryPolicy)))}
                data-testid="unanswered-use-one"
              >
                Use one rule for all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
