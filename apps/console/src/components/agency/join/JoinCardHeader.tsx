import { brand } from '../../../brand';
import { JOIN_DOORS, type JoinDoor } from './joinDoor';
import styles from './AgencyJoin.module.css';

/**
 * The top of every card this page renders — the invitation, its skeleton and
 * the outcome screens: the product's wordmark and what it is. Four copies of
 * the same two lines before this; one now, so the card cannot read differently
 * depending on which outcome arrived.
 *
 * `door` is required rather than defaulted to the agency's eyebrow: a default
 * would let the workspace page render "Agency Dialer" over an operator's
 * invitation by forgetting one prop, which is how it would first have shipped.
 */
export function JoinCardHeader({ door }: { door: JoinDoor }) {
  return (
    <>
      <div className={styles.wordmark}>{brand.name}</div>
      <p className={styles.eyebrow}>{JOIN_DOORS[door].eyebrow}</p>
    </>
  );
}
