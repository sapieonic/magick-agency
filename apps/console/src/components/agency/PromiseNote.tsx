import type { AgencyContactPromise, AgencyPromiseState } from '@magick-agency/contracts/agency';
import { PROMISE_STATE_HINTS, formatPromise, promiseStateLabel } from '../../utils/format/promise';
import styles from './PromiseNote.module.css';

/**
 * A promise to pay (PT1), where a call's outcome is shown (the attempt tables, the call page,
 * the customer's timeline, the agent's prior attempts): "Promised 18 Nov 2026 · 12,500".
 * Renders nothing when the call recorded none.
 */
export function PromiseNote({
  date,
  amount,
  testId,
}: {
  date: string | null | undefined;
  amount?: string | null;
  testId?: string;
}) {
  if (!date) return null;
  return (
    <span className={styles.note} data-testid={testId}>
      {formatPromise({ date, amount: amount ?? null })}
    </span>
  );
}

/**
 * Where a contact's latest promise stands (PT7): a small tag, coloured by how much it asks for
 * attention, with what it means on hover. Colour is never the only channel: the word is shown.
 */
export function PromiseStateTag({ state, testId }: { state: AgencyPromiseState; testId?: string }) {
  return (
    <span className={styles.state} data-state={state} title={PROMISE_STATE_HINTS[state]} data-testid={testId}>
      {promiseStateLabel(state)}
    </span>
  );
}

/** A contact's latest promise with its state: the agent's panel and the contact's page. */
export function ContactPromiseLine({ promise, testId }: { promise: AgencyContactPromise | null | undefined; testId?: string }) {
  if (!promise) return null;
  return (
    <span className={styles.line} data-testid={testId}>
      <span className={styles.text}>{formatPromise(promise)}</span>
      <PromiseStateTag state={promise.state} />
    </span>
  );
}
