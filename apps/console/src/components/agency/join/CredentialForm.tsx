import { useEffect, useRef, type FormEvent } from 'react';
import { brand } from '../../../brand';
import { STRENGTH_LABELS, type PasswordAssessment } from '../../../utils/agencyInviteJoinCopy';
import type { AgencyInvite } from '../../../types/invite';
import type { JoinPending } from './joinPending';
import styles from './AgencyJoin.module.css';

/**
 * The email + password half, revealed under the Google button.
 *
 * ── The address field is read-only, and that is the design ─────────────────
 * It is pre-filled from the invite and cannot be edited. The invited address is
 * the one value on this page that must not drift, and an editable field here would
 * reintroduce — one keystroke at a time — the very mismatch the token was minted
 * to make survivable. `readOnly` rather than `disabled` on purpose: a disabled
 * input is skipped by keyboard navigation and read as unavailable, when what is
 * true is the opposite — it is the most important value on the screen and it is
 * settled.
 */
export function CredentialForm({
  invite,
  password,
  onPasswordChange,
  assessment,
  existing,
  pending,
  onSubmit,
}: {
  invite: AgencyInvite;
  password: string;
  onPasswordChange: (value: string) => void;
  assessment: PasswordAssessment;
  existing: boolean;
  pending: JoinPending;
  onSubmit: (e: FormEvent) => void;
}) {
  const field = useRef<HTMLInputElement>(null);

  /*
    Focus lands in the password box the moment this reveals, and again when the
    form flips to "you already have a password" — both are moments where the page
    changed under somebody and the next thing to do is type. Without it a keyboard
    user has to tab back past the Google button to reach the only field that just
    appeared.
  */
  useEffect(() => { field.current?.focus(); }, [existing]);

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="join-email">Your address</label>
        <input
          id="join-email"
          type="email"
          value={invite.email}
          readOnly
          aria-describedby="join-email-note"
          className={styles.readOnlyInput}
        />
        <p id="join-email-note" className={styles.fieldNote}>
          This is the address the invitation was sent to, so it cannot be changed here.
        </p>
      </div>

      <div className={styles.field}>
        <label htmlFor="join-password">
          {existing ? 'Your password' : 'Choose a password'}
        </label>
        <input
          id="join-password"
          ref={field}
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          autoComplete={existing ? 'current-password' : 'new-password'}
          aria-describedby="join-password-note"
          required
        />
        {existing ? (
          <p id="join-password-note" className={styles.fieldNote}>
            This address already has a password on {brand.name}. Enter it and we will
            add this workspace to it.
          </p>
        ) : (
          <div id="join-password-note" className={styles.strength}>
            {/*
              A meter and a sentence, updated as they type. The whole reason this
              exists is that the alternative — Firebase answering `auth/weak-password`
              after a round trip — tells somebody their password is wrong without
              ever telling them what would be right.
            */}
            <div className={styles.strengthTrack} aria-hidden="true">
              <span
                className={styles.strengthFill}
                data-score={assessment.score}
                style={{ width: `${(assessment.score / 4) * 100}%` }}
              />
            </div>
            <p className={styles.strengthText}>
              {password.length > 0 && (
                <span className={styles.strengthLabel} data-score={assessment.score}>
                  {STRENGTH_LABELS[assessment.score]}
                </span>
              )}
              {assessment.blocker && password.length > 0 ? assessment.blocker : assessment.hint}
            </p>
          </div>
        )}
      </div>

      <button
        type="submit"
        className="btn-primary"
        disabled={pending !== null}
        style={{ width: '100%' }}
      >
        {pending === 'create' || pending === 'sign_in'
          ? 'Joining…'
          : existing
            ? 'Sign in and join'
            : 'Create my sign-in'}
      </button>
    </form>
  );
}
