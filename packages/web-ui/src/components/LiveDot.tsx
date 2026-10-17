import styles from './LiveDot.module.css';

interface LiveDotProps {
  /**
   * Whether the thing this sits beside is actually in flight right now.
   *
   * Required, and deliberately not defaulted: every hand-rolled copy this
   * replaced animated unconditionally, so a dot kept pulsing on a job that had
   * finished. A pulse on something that is not progressing is a lie told every
   * two seconds, and the only way to stop writing it is to make each call site
   * answer the question.
   */
  live: boolean;
  /** Diameter in px. Call sites run 6–8 depending on the type beside them. */
  size?: number;
  /**
   * Any CSS colour, including `currentColor`. Ember is the default and should
   * stay the common case — pass this only where the colour already carries state
   * the dot must not overwrite, e.g. a call pill that is amber while ringing and
   * red on failure.
   */
  color?: string;
  /** Extra positioning from the surrounding layout. */
  className?: string;
}

/**
 * "Something is happening right now", as one dot.
 *
 * Decorative by construction: `aria-hidden`, no label of its own. The meaning
 * belongs to whatever it sits next to — a status badge, a heading, a KPI title
 * — and a dot that announced itself would be a second, wordier copy of that.
 */
export function LiveDot({ live, size = 8, color, className }: LiveDotProps) {
  const classes = [styles.liveDot, live ? styles.pulsing : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      // `color` drives both the dot and its halo; omitting it leaves the
      // module's ember default in force rather than resolving it here.
      style={{ width: size, height: size, ...(color ? { color } : null) }}
      aria-hidden="true"
    />
  );
}

export default LiveDot;
