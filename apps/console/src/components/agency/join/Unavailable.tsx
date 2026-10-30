import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { InviteUnavailableStatus } from '../../../types/invite';
import { JoinCardHeader } from './JoinCardHeader';
import { JOIN_DOORS, type JoinDoor } from './joinDoor';
import styles from './AgencyJoin.module.css';

/**
 * The invite cannot be used, and each reason gets its own words and its own way
 * out — see `UNAVAILABLE_COPY` for why there are five screens and not one
 * "invalid link". The words and the sign-in page are the door's: an agent is sent
 * to the agency door and told their station will open, anybody else to `/login`
 * and told their workspace will.
 */
export function Unavailable({ status, door }: { status: InviteUnavailableStatus; door: JoinDoor }) {
  const { unavailable, signInPath } = JOIN_DOORS[door];
  const copy = unavailable[status];
  const heading = useRef<HTMLHeadingElement>(null);

  /*
    Focus moves to the heading, for the reason {@link AddressMismatch} does the
    same: this screen routinely REPLACES the card mid-claim — a supervisor
    revoked the invitation while the form was open, or a second tab won the race
    — so the button somebody just pressed disappears, focus falls to `<body>`,
    and a screen-reader user is told nothing at all about a page that changed
    completely under them. The heading is where the outcome is; it is also the
    top of the only content there is, so doing it on a cold load costs nothing.
  */
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <div className={styles.card}>
      <JoinCardHeader door={door} />
      <h1 className={styles.outcomeTitle} tabIndex={-1} ref={heading}>{copy.title}</h1>
      <p className={styles.outcomeBody}>{copy.body}</p>
      {copy.action === 'sign_in' && (
        <Link to={signInPath} className="btn-primary" style={{ width: '100%' }}>
          Go to sign in
        </Link>
      )}
    </div>
  );
}
