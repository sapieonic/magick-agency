import { brand } from '../../../brand';
import styles from './AgencyJoin.module.css';

/**
 * The top of every card this page renders — the invitation, its skeleton and
 * the outcome screens: the product's wordmark and what it is. Four copies of
 * the same two lines before this; one now, so the card cannot read differently
 * depending on which outcome arrived.
 */
export function JoinCardHeader() {
  return (
    <>
      <div className={styles.wordmark}>{brand.name}</div>
      <p className={styles.eyebrow}>Agency Dialer</p>
    </>
  );
}
