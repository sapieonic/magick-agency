import { useId } from 'react';
import { CircleCheck } from 'lucide-react';
import type { AgencyDispositionEntry } from '../../../../types/agency-campaign';
import { OutcomeTileGrid } from '../../../../components/agency/station/OutcomeTileGrid';
import { STATION_COPY } from '../../../../utils/agency/stationCopy';
import styles from './PurposeButtonsStep.module.css';

/**
 * "What the agent will see" (CS4): the station's What happened? screen for these buttons, live as
 * they are edited. The tiles are the station's own (`OutcomeTileGrid`), drawn as a picture rather
 * than controls, so the preview cannot drift from the real screen: the same order, pictures, sizes
 * and More tile.
 */
export function AgentButtonsPreview({ dispositions }: { dispositions: readonly AgencyDispositionEntry[] }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} data-testid="agent-buttons-preview">
      <h3 className={styles.previewTitle} id={titleId}>What the agent will see</h3>
      <div className={styles.previewScreen}>
        <div className={styles.previewScale}>
          <div className={styles.previewBand} aria-hidden="true">
            <span className={styles.previewBandIcon}><CircleCheck size={30} /></span>
            <span>
              <span className={styles.previewBandTitle}>{STATION_COPY.happenedTitle}</span>
              <span className={styles.previewBandSub}>{STATION_COPY.happenedSubtitle}</span>
            </span>
          </div>
          <div className={styles.previewTiles}>
            {dispositions.length > 0 ? (
              <OutcomeTileGrid catalog={dispositions} label="Buttons agents will see" testId="preview-tiles" />
            ) : (
              <p className={styles.previewEmpty}>No buttons yet.</p>
            )}
          </div>
        </div>
      </div>
      <p className={styles.previewNote}>The order is the number key agents can press.</p>
    </section>
  );
}
