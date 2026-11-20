import type { CSSProperties } from 'react';
import { VISUAL_CUE_SPECS } from '../../utils/agencyCues';
import type { CueFlash } from '../../hooks/useAgencyCues';
import styles from './StateRail.module.css';

/**
 * The cue's visual channel (connect, disconnect, a call coming), for an agent who cannot hear it:
 * a band that pulses `VISUAL_CUE_SPECS[cue].pulses` times over its duration, driven by the custom
 * properties set here (`StateRail.module.css` holds the keyframes the soft phone's and the inbound
 * rail share). The caller keys it on cue and subject, which is what restarts the animation.
 */
export function CueFlashBand({ flash }: { flash: CueFlash }) {
  const spec = VISUAL_CUE_SPECS[flash.cue];
  return (
    <span
      className={styles.cueFlash}
      data-testid="cue-flash"
      data-cue-flash={flash.cue}
      data-cue-pulses={spec.pulses}
      data-cue-travel={spec.travel}
      style={
        {
          '--cue-pulses': spec.pulses,
          '--cue-duration': `${spec.durationMs}ms`,
          // One pulse's worth of the total, so N pulses fill the same window the hook holds it for.
          '--cue-pulse-duration': `${Math.round(spec.durationMs / spec.pulses)}ms`,
        } as CSSProperties
      }
      aria-hidden="true"
    />
  );
}
