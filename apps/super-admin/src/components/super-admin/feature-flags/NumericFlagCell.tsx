import type { ReactNode } from 'react';
import type { FeatureFlagCatalogEntry, FlagResolutionSource, FlagScopeType } from '@magick-agency/contracts/api/platform/super-admin';
import { canEditAtScope } from './flagUtils';
import styles from './featureFlags.module.css';

interface Props {
  /** Catalog entry — used for scope-gating and default fallback. */
  flag: FeatureFlagCatalogEntry;
  /** Currently-effective value at the caller's scope. `undefined` renders as em-dash. */
  currentValue: number | undefined;
  /**
   * Which layer produced `currentValue` — drives the source chip copy. Omit
   * when the caller cannot attribute it: the chip then says "inherited default"
   * rather than naming a layer it does not actually know about.
   */
  source?: FlagResolutionSource;
  /** True iff an override exists at the caller's exact scope (drives the chip + Reset visibility). */
  hasOverride: boolean;
  /** Scope this cell is rendered at, used to (1) label the override chip and (2) gate the Edit button. */
  scope: FlagScopeType;
  /** Disable all controls while a write is in flight for this flag. */
  busy?: boolean;
  /** Opens the value-entry dialog. */
  onEdit: () => void;
  /** Only rendered when `hasOverride` is true; caller decides whether to confirm-gate. */
  onReset?: () => void;
  /**
   * Extra content rendered inline (e.g. an "env var: FOO_BAR" hint). Kept as a
   * prop rather than derived here because the server API doesn't currently
   * expose `envVar` on the catalog response.
   */
  extra?: ReactNode;
}

/**
 * Compact numeric-flag cell shared by the per-tenant Feature Flags tab and
 * the platform-wide Feature Flags registry. Renders the current effective
 * value, a source-attribution chip, an Edit button, and an optional Reset
 * button. Scope-gating: Edit is hidden when the flag's registry `scopes` don't
 * include the caller's scope — clicking would have server-422'd. Boolean
 * tri-state and string/JSON read-only fallback are unchanged.
 */
export function NumericFlagCell({
  flag,
  currentValue,
  source,
  hasOverride,
  scope,
  busy,
  onEdit,
  onReset,
  extra,
}: Props) {
  const editable = canEditAtScope(flag, scope);
  const overrideLabel =
    scope === 'account' ? 'account override'
    : scope === 'tenant' ? 'tenant override'
    : 'global override';

  const sourceLabel = hasOverride
    ? overrideLabel
    : source === 'env' ? 'env default'
      : source === 'global' ? 'global default'
        : source === 'tenant' ? 'from tenant override' // fired only on account scope
          : source === 'default' ? 'registry default'
            // No `source` at all: the caller could not attribute the value (the
            // catalog response reports no provenance). Say that, rather than
            // guessing "registry" or "env" — see the comment on the global
            // registry page's inherited-default column.
            : 'inherited default';

  return (
    <div className={styles.numCell}>
      <span className={styles.numValue}>
        {currentValue !== undefined ? currentValue : '—'}
      </span>
      <span className={styles.numSource} title={`Source: ${source ?? 'inherited'}`}>
        {sourceLabel}
      </span>
      {editable ? (
        <button
          type="button"
          className={`btn-secondary ${styles.numBtn}`}
          disabled={busy}
          onClick={onEdit}
        >
          Edit
        </button>
      ) : (
        <span className={styles.numScopeHint} title={`Editable scopes: ${flag.scopes.join(', ')}`}>
          not editable at this scope
        </span>
      )}
      {hasOverride && onReset && (
        <button
          type="button"
          className={`btn-secondary ${styles.numBtn}`}
          disabled={busy}
          onClick={onReset}
        >
          Reset
        </button>
      )}
      {extra}
    </div>
  );
}
