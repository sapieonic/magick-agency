import {
  IDLE_GUIDE_HEADING,
  IDLE_GUIDE_INTRO,
  IDLE_KEYS_NOW,
  IDLE_KEYS_ON_CALL,
  IDLE_PAUSED_HINT,
} from '../../utils/agencyStationIdle';
import styles from './AgentStation.module.css';

/**
 * The waiting middle column. Purely a reminder — no controls — so it cannot
 * enter the tab order and cannot move a live-call control when a reservation
 * lands. The keys listed are the ones the page actually binds; a key that is
 * only a comment would train muscle memory for a binding that does not exist.
 */
export function IdleGuide({ dialing }: { dialing: boolean }) {
  return (
    <div className={styles.idleGuide} data-testid="idle-guide">
      <p className={styles.idleGuideHeading}>{IDLE_GUIDE_HEADING}</p>
      <p className={styles.idleGuideIntro}>
        {dialing ? IDLE_GUIDE_INTRO : IDLE_PAUSED_HINT}
      </p>
      <p className={styles.idleKeyGroupLabel}>Right now</p>
      <ul className={styles.idleKeys}>
        {IDLE_KEYS_NOW.map((row) => (
          <li key={row.key} className={styles.idleKeyRow}>
            <span className={styles.idleKeyChip}>{row.key}</span>
            {row.does}
          </li>
        ))}
      </ul>
      <p className={styles.idleKeyGroupLabel}>On a call</p>
      <ul className={styles.idleKeys}>
        {IDLE_KEYS_ON_CALL.map((row) => (
          <li key={row.key} className={styles.idleKeyRow}>
            <span className={styles.idleKeyChip}>{row.key}</span>
            {row.does}
          </li>
        ))}
      </ul>
    </div>
  );
}
