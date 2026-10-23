import styles from './AppVersion.module.css';

interface AppVersionProps {
  /** The app's own release version, from its package.json at build time (`__APP_VERSION__`). */
  version: string;
  /**
   * `footer` (default): the block at the foot of a column-flex sidebar, pinned to its bottom.
   * `inline`: the label alone, for a row of chrome with no sidebar (the agent nav, the
   * station header); it takes the row's free space on its left, so it sits at the row's end.
   */
  variant?: 'footer' | 'inline';
  /** The icon-rail form of a collapsed sidebar: centred, no side padding (`footer` only). */
  compact?: boolean;
  /** Extra class for the footer, for the host sidebar's own spacing rules. */
  className?: string;
}

/**
 * The release version, shown on every navigating surface of both apps so a report from the
 * field (a screenshot, a support call) names the build it came from: the foot of every
 * sidebar, and inline on the agent surfaces that have no sidebar. Each app has its own
 * version (docs/operations.md "Releases and versioning", B24), so the app passes it in.
 */
export function AppVersion({ version, variant = 'footer', compact = false, className }: AppVersionProps) {
  const label = (
    <span className={styles.label} title={`Version ${version}`} data-testid="app-version">
      v{version}
    </span>
  );
  if (variant === 'inline') {
    return <span className={[styles.inline, className ?? ''].filter(Boolean).join(' ')}>{label}</span>;
  }
  const classes = [styles.footer, compact ? styles.compact : '', className ?? ''].filter(Boolean).join(' ');
  return <div className={classes}>{label}</div>;
}
