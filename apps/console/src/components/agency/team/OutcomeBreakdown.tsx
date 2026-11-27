import { useId } from 'react';
import { CircleCheck } from 'lucide-react';
import { TileIcon } from '@magick-agency/web-ui/components/TileIcon';
import type { AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';
import { formatCount } from '../../../utils/format/number';
import { ONE_COLOUR_NOTE, outcomesFootnote, outcomesTitle, rollupLine } from '../../../utils/agency/team/teamCopy';
import { mainOutcomeBarCount, outcomeBars } from '../../../utils/agency/team/teamCharts';
import type { TeamWindowPreset } from '../../../utils/agency/team/teamUrl';
import styles from './Team.module.css';

/**
 * What happened on the calls (`docs/team-performance.md` TP13): dialler conversations by the
 * outcome chosen, from the Insights rollup, most first, the eighth and on folded into "Other
 * outcomes". A list a screen reader reads as words and numbers; the bars beside them are drawn
 * for the eye only, all in one colour. The footnote that the main outcome's bar and its tile
 * count differently is shown only when they do.
 */
export function OutcomeBreakdown({ data, label, preset }: { data: AgencyTeamPerformance; label: string; preset: TeamWindowPreset }) {
  const titleId = useId();
  const bars = outcomeBars(data.outcomes);
  const total = data.outcomes.reduce((sum, o) => sum + o.conversations, 0);
  const footnote = bars.length > 0
    ? outcomesFootnote(label, mainOutcomeBarCount(data.outcomes, data.main_outcome.codes), data.totals.main.numerator, {
        kind: data.main_outcome.kind,
        otherCalls: data.totals.other_conversations,
      })
    : null;
  return (
    <section className={styles.card} aria-labelledby={titleId} data-testid="team-outcomes">
      <div className={styles.cardHead}>
        <CircleCheck size={16} aria-hidden="true" className={styles.cardIcon} />
        <h2 className={styles.cardTitle} id={titleId}>
          {outcomesTitle(preset, total)}
        </h2>
      </div>
      <p className={styles.cardLine}>{capitalise(rollupLine(data.rollup_as_of))}</p>
      {bars.length === 0 ? (
        <p className={styles.emptyNote}>No dialler calls with an outcome in this period yet.</p>
      ) : (
        <>
          <ul className={styles.outcomes}>
            {bars.map((b) => (
              <li key={b.key} className={styles.outcome} data-testid="team-outcome">
                <span className={styles.outcomeName}>
                  <span className={styles.outcomeIcon} aria-hidden="true">
                    <TileIcon icon={b.icon} size={15} />
                  </span>
                  <span>{b.label}</span>
                </span>
                <span className={styles.outcomeBarCell}>
                  <span className={styles.outcomeBar} style={{ width: `calc((100% - 52px) * ${b.share / 100})` }} aria-hidden="true" />
                  <span className={styles.outcomeCount}>{formatCount(b.conversations)}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.foot}>{ONE_COLOUR_NOTE}</p>
          {footnote ? (
            <p className={styles.foot} data-testid="team-outcomes-footnote">
              {footnote}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
