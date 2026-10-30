import { useEffect, useRef } from 'react';
import type { JoinPending } from './joinPending';
import styles from './AgencyJoin.module.css';

/**
 * The Google account signed in with is not the address the invite was sent to.
 *
 * ── Why this stops the flow instead of proceeding ──────────────────────────
 * Because today, this exact case is how agency onboarding fails in silence. An
 * agent invited at `priya@acme.com` presses Continue with Google, the browser
 * hands over the personal account it is already signed into, and `POST
 * /auth/session` provisions a tenant for THAT address — leaving the agent as the
 * owner of an empty workspace, the real membership unclaimed, and neither of them
 * told anything at all. The claim endpoint means linking the two accounts is now
 * a legitimate answer rather than an accident, so the page does not refuse it. It
 * refuses to do it QUIETLY: the two addresses are shown side by side, the sentence
 * names what will happen, and nothing is claimed until somebody says yes.
 *
 * ── The decline is a sign-out, not a state reset ───────────────────────────
 * "Use a different account" drops the Firebase credential as well as this screen.
 * Without it the wrong Google account stays the browser's current user, and the
 * next popup re-selects it without asking — so the escape hatch would return them
 * to the same screen and read as a page that does not work.
 *
 * ── `required`: the same screen with nothing to confirm (decision B25) ─────
 * An invitation for `account_admin` or above can be claimed only by an account
 * at the invited address — the server refuses any other, because there a
 * forwarded mail would hand over a seat that can invite people and supervise
 * calls. So that mode drops "Use this account" altogether rather than offering a
 * button that can only fail, says which address the invitation needs and how to
 * get to it, and keeps one action: back to the options. The other account has
 * already been signed out by the time this renders (`useInviteClaim`'s
 * `requireInvitedAddress`); the button waits for that sign-out to finish. One
 * component with two modes rather than two components, because the two screens
 * must stay the same in every way but that one — the side-by-side addresses, the
 * focus on the heading, the place on the card.
 */
type AddressMismatchProps = {
  invitedAs: string;
  onDecline: () => void;
  pending: JoinPending;
} & (
  | {
      /** The visitor may still choose this account: the ordinary mismatch. */
      required?: false;
      signedInAs: string;
      onConfirm: () => void;
    }
  | {
      /** Only the invited address can claim this invitation. */
      required: true;
      /** Null when the page never learned it (the server refused the claim). */
      signedInAs: string | null;
      onConfirm?: never;
    }
);

export function AddressMismatch(props: AddressMismatchProps) {
  const { invitedAs, onDecline, pending } = props;
  const heading = useRef<HTMLHeadingElement>(null);

  /*
    Focus moves to the heading when this replaces the options, not to a button.
    The heading is where the question is; landing on "Continue" would put a screen
    reader user on an answer before they had been asked, and this is the one
    decision on the page that must not be made by reflex.
  */
  useEffect(() => { heading.current?.focus(); }, []);

  if (props.required) {
    return (
      <div className={styles.mismatch} data-testid="address-required">
        <h2 className={styles.mismatchTitle} tabIndex={-1} ref={heading}>
          Use the address this invitation was sent to
        </h2>
        <p className={styles.mismatchBody}>
          This invitation must be accepted with{' '}
          <strong className={styles.strong}>{invitedAs}</strong>.
          {props.signedInAs ? (
            <>
              {' '}You signed in as <strong className={styles.strong}>{props.signedInAs}</strong>,
              so we have signed you out of it.
            </>
          ) : (
            <> We have signed you out of the account you used.</>
          )}
        </p>
        <p className={styles.mismatchBody}>
          Continue with Google using that address, or create a password — the password
          form is already set to it.
        </p>
        <div className={styles.mismatchActions}>
          <button
            type="button"
            className="btn-primary"
            onClick={onDecline}
            disabled={pending !== null}
          >
            {pending === 'decline' ? 'Signing out…' : 'Try again with that address'}
          </button>
        </div>
      </div>
    );
  }

  const { signedInAs, onConfirm } = props;

  return (
    <div className={styles.mismatch}>
      <h2 className={styles.mismatchTitle} tabIndex={-1} ref={heading}>
        That is a different address
      </h2>
      <p className={styles.mismatchBody}>
        You signed in as <strong className={styles.strong}>{signedInAs}</strong>. This
        invitation was sent to <strong className={styles.strong}>{invitedAs}</strong>.
      </p>
      <p className={styles.mismatchBody}>
        You can use this Google account anyway — it will become how you sign in, and
        the invitation will still be claimed. Only do it if the account is yours.
      </p>
      <div className={styles.mismatchActions}>
        <button
          type="button"
          className="btn-primary"
          onClick={onConfirm}
          disabled={pending !== null}
        >
          {pending === 'confirm' ? 'Linking…' : 'Use this account'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onDecline}
          disabled={pending !== null}
        >
          {pending === 'decline' ? 'Signing out…' : 'Use a different account'}
        </button>
      </div>
    </div>
  );
}
