import type { ReactNode } from 'react';
import type { FeatureFlagCatalogEntry, FlagScopeType } from '@magick-agency/contracts/api/platform/super-admin';
import { TriStateControl } from './TriStateControl';
import { canEditAtScope, type TriState } from './flagUtils';
import styles from './featureFlags.module.css';

interface Props {
  /** Catalog entry — used for scope-gating. */
  flag: FeatureFlagCatalogEntry;
  /** Tri-state derived from the override (if any) at the caller's exact scope. */
  value: TriState;
  /** Effective boolean at the caller's scope; shown read-only when not editable here. */
  effectiveOn: boolean;
  /** Scope this cell is rendered at — gates the control. */
  scope: FlagScopeType;
  /** Accessible label for the radiogroup (e.g. the flag name). */
  ariaLabel: string;
  /** Sub-line under "Inherit" attributing the inherited default's source. */
  inheritSub?: ReactNode;
  /** Disable the control while a write is in flight for this flag. */
  busy?: boolean;
  onSelect: (next: TriState) => void;
}

/**
 * Boolean-flag cell shared by the per-tenant Feature Flags tab and the
 * platform-wide Feature Flags registry — the boolean sibling of
 * {@link NumericFlagCell}, and scope-gated the same way.
 *
 * When the flag's registry `scopes` don't include the caller's scope the
 * tri-state is replaced by a read-only state + hint, because every write it
 * could produce would 422 at the server's scope check. That matters most for
 * `prewarm_enabled`, the one boolean declared `scopes: ['tenant']`: the global
 * registry offered a fleet-wide On/Off for the pre-warm kill switch that could
 * never save, which is the worst possible affordance to hand an operator
 * mid-incident.
 */
export function BooleanFlagCell({
  flag,
  value,
  effectiveOn,
  scope,
  ariaLabel,
  inheritSub,
  busy,
  onSelect,
}: Props) {
  if (!canEditAtScope(flag, scope)) {
    return (
      <div className={styles.numCell}>
        <span className={styles.numValue}>{effectiveOn ? 'On' : 'Off'}</span>
        <span className={styles.numScopeHint} title={`Editable scopes: ${flag.scopes.join(', ')}`}>
          not editable at this scope
        </span>
      </div>
    );
  }

  return (
    <TriStateControl
      value={value}
      ariaLabel={ariaLabel}
      inheritSub={inheritSub}
      disabled={busy}
      onSelect={onSelect}
    />
  );
}
