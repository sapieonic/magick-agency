import { PhoneOutgoing } from 'lucide-react';
import type { WrapupRedialState } from '../../hooks/useWrapupRedial';
import styles from './WrapupRedial.module.css';

/**
 * Wrap-up redial: the Redial button beside the outcome pad, its remaining count,
 * and the refusal when the server declined.
 *
 * Rendered only while the wrap-up offers it (`redial_remaining` set): it appears
 * after the call has ended, so it never moves a control under the agent's cursor
 * during a live call. Between the pad and the notes, so the tab order stays pad →
 * redial → notes.
 *
 * `aria-disabled`, not `disabled`, for the reason the pad gives: the press itself
 * disables it (in flight), and a real `disabled` landing under the focused button
 * drops a keyboard agent to `<body>`.
 */
export function WrapupRedial({ redial }: { redial: WrapupRedialState }) {
  if (!redial.offered) return null;
  return (
    <div className={styles.redial} data-testid="wrapup-redial-row">
      <button
        type="button"
        className={styles.button}
        aria-disabled={!redial.enabled || undefined}
        aria-describedby="wrapup-redial-status"
        onClick={() => {
          if (redial.enabled) redial.redial();
        }}
        data-testid="wrapup-redial"
      >
        <PhoneOutgoing size={15} aria-hidden="true" />
        Redial
      </button>
      <span id="wrapup-redial-status" className={styles.status} data-testid="wrapup-redial-status">
        {redial.statusLine}
      </span>
      {redial.refusal ? (
        <p className={styles.refusal} role="alert" data-testid="wrapup-redial-refusal">
          {redial.refusal}
        </p>
      ) : null}
    </div>
  );
}
