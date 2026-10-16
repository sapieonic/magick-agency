import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { AGENCY_LOGIN_PATH } from '../../../utils/returnPath';
import { UNAVAILABLE_COPY } from '../../../utils/agencyInviteJoinCopy';
import type { InviteUnavailableStatus } from '../../../types/invite';
import { JoinCardHeader } from './JoinCardHeader';
import styles from './AgencyJoin.module.css';

/**
 * The invite cannot be used, and each reason gets its own words and its own way
 * out — see `UNAVAILABLE_COPY` for why there are five screens and not one
 * "invalid link".
 */
export function Unavailable({ status }: { status: InviteUnavailableStatus }) {
  const copy = UNAVAILABLE_COPY[status];
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
      <JoinCardHeader />
      <h1 className={styles.outcomeTitle} tabIndex={-1} ref={heading}>{copy.title}</h1>
      <p className={styles.outcomeBody}>{copy.body}</p>
      {copy.action === 'sign_in' && (
        <Link to={AGENCY_LOGIN_PATH} className="btn-primary" style={{ width: '100%' }}>
          Go to sign in
        </Link>
      )}
    </div>
  );
}
