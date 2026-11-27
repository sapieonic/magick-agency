import type { AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';
import { formatCount } from '../../../utils/format/number';
import {
  callbacksTile,
  callsLine,
  chooseLine,
  clockOrDash,
  mainFloor,
  mainLine,
} from '../../../utils/agency/team/teamCopy';
import styles from './Team.module.css';

/**
 * The five tiles (`docs/team-performance.md` §2 item 2), as one description list: Calls handled,
 * the main outcome, Average call, Time to choose outcome, Call-backs on time. Each figure is the
 * team's (sums over every row, TP2); the lines are the console's words.
 */
export function TeamTiles({ data, label, holdsToday }: { data: AgencyTeamPerformance; label: string; holdsToday: boolean }) {
  const { totals } = data;
  const callbacks = callbacksTile(totals.callbacks, holdsToday);
  const tiles: Array<{ id: string; title: string; value: string; of?: string | null; line: string }> = [
    { id: 'calls', title: 'Calls handled', value: formatCount(totals.calls_handled), line: callsLine(totals.agents) },
    {
      id: 'main',
      title: label,
      value: formatCount(totals.main.numerator),
      line: mainLine(totals, label, mainFloor(data.main_outcome.kind)),
    },
    { id: 'avg', title: 'Average call', value: clockOrDash(totals.avg_call_seconds), line: 'min:sec of talking' },
    { id: 'choose', title: 'Time to choose outcome', value: clockOrDash(totals.choose_seconds), line: chooseLine(totals.wrapup_allowed) },
    { id: 'callbacks', title: 'Call-backs on time', value: callbacks.value, of: callbacks.of, line: callbacks.line },
  ];
  return (
    <dl className={styles.tiles} data-testid="team-tiles">
      {tiles.map((t) => (
        <div key={t.id} className={styles.tile} data-testid={`team-tile-${t.id}`}>
          <dt className={styles.tileTitle}>{t.title}</dt>
          <dd className={styles.tileValue}>
            {t.value}
            {t.of ? <span className={styles.tileOf}> {t.of}</span> : null}
          </dd>
          <dd className={styles.tileLine}>{t.line}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The tiles' shape while the first answer loads. */
export function TeamTilesSkeleton() {
  return (
    <div className={styles.tiles} aria-hidden="true" data-testid="team-tiles-skeleton">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className={styles.tile}>
          <span className={`${styles.skeleton} ${styles.skeletonTitle}`} />
          <span className={`${styles.skeleton} ${styles.skeletonValue}`} />
          <span className={`${styles.skeleton} ${styles.skeletonLine}`} />
        </div>
      ))}
    </div>
  );
}
