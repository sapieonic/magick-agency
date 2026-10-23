import styles from './AppVersion.module.css';

interface AppVersionProps {
  /** The app's own release version, from its package.json at build time (`__APP_VERSION__`). */
  version: string;
  /** The icon-rail form of a collapsed sidebar: centred, no side padding. */
  compact?: boolean;
  /** Extra class for the footer, for the host sidebar's own spacing rules. */
  className?: string;
}

/**
 * The release version at the foot of a sidebar, shown in every state of every shell, so a
 * report from the field (a screenshot, a support call) names the build it came from. Each
 * app has its own version (docs/operations.md "Releases and versioning", B24), so the app
 * passes it in; the footer pushes itself to the bottom of a column-flex sidebar.
 */
export function AppVersion({ version, compact = false, className }: AppVersionProps) {
  const classes = [styles.footer, compact ? styles.compact : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <span className={styles.label} title={`Version ${version}`} data-testid="app-version">
        v{version}
      </span>
    </div>
  );
}
