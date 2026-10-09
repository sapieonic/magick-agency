import { useState, useEffect, useCallback, useMemo } from 'react';
import { Flag, RotateCcw } from 'lucide-react';
import {
  getFeatureFlagCatalog,
  resolveFeatureFlags,
  putFeatureFlagOverride,
  deleteFeatureFlagOverride,
} from '../../api/super-admin';
import type {
  FeatureFlagCatalogEntry,
  FeatureFlagOverride,
  FeatureFlagResolveResponse,
  FlagScopeType,
} from '@magick-agency/contracts/api/platform/super-admin';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { BooleanFlagCell } from './feature-flags/BooleanFlagCell';
import { OverrideReasonDialog } from './feature-flags/OverrideReasonDialog';
import { NumberFlagDialog } from './feature-flags/NumberFlagDialog';
import { NumericFlagCell } from './feature-flags/NumericFlagCell';
import { ConfirmDialog } from './feature-flags/ConfirmDialog';
import { FlagPolicyWarning } from './feature-flags/FlagPolicyWarning';
import { humanize, isGuardedWhenOn, numericBoundsFor, relativeExpiry, toTriState, type TriState } from './feature-flags/flagUtils';
import styles from './TenantFeatureFlags.module.css';

interface AccountOption {
  id: string;
  name: string;
}

interface Props {
  tenantId: string;
  accounts: AccountOption[];
}

type Scope = { type: 'tenant' } | { type: 'account'; accountId: string };

/** A pending explicit On/Off write awaiting a reason in the dialog. */
interface PendingEdit {
  flagKey: string;
  value: boolean;
  /** The flag's policy warning, when this write turns a guarded flag ON. */
  warning?: string;
}

/** A pending numeric write awaiting a value + reason in the dialog. */
interface PendingNumberEdit {
  flag: FeatureFlagCatalogEntry;
  /** Prefilled from the current effective value. */
  currentValue: number | undefined;
}

/**
 * Super-admin Feature Flags tab for a tenant. Scope selector (tenant /
 * per-account) drives a flag-row table; each boolean flag exposes a tri-state
 * Inherit/On/Off control. Reads core's resolve contract through master's
 * super-admin lane; writes thread the admin id as updated_by server-side.
 * Platform-wide defaults and cross-tenant rollout live on the global Feature
 * Flags registry, not here. UX: docs/reference/magick-comms-cusui/docs/superpowers/plans/feature-flags-ux-redesign.md.
 */
export function TenantFeatureFlags({ tenantId, accounts }: Props) {
  const [catalog, setCatalog] = useState<FeatureFlagCatalogEntry[]>([]);
  const [resolved, setResolved] = useState<FeatureFlagResolveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>({ type: 'tenant' });
  const [pending, setPending] = useState<PendingEdit | null>(null);
  const [pendingNumber, setPendingNumber] = useState<PendingNumberEdit | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Confirm gate before disabling a currently-enabled capability.
  const [confirmDisable, setConfirmDisable] = useState<{ flag: FeatureFlagCatalogEntry; next: TriState } | null>(null);
  // Confirm gate before clearing a numeric override that would change the effective value.
  const [confirmReset, setConfirmReset] = useState<{ flag: FeatureFlagCatalogEntry; currentValue: number | undefined; fallbackValue: number | undefined } | null>(null);
  // Confirm gate before an Inherit/reset that would turn a guarded flag ON.
  const [confirmInheritOn, setConfirmInheritOn] = useState<FeatureFlagCatalogEntry | null>(null);

  const accountId = scope.type === 'account' ? scope.accountId : undefined;

  /**
   * Fetches catalog + resolved values. `showSpinner` should only be true on
   * the initial mount / scope change — subsequent post-write refetches keep
   * the last-known state visible to avoid a whole-table flash after every
   * save (the row-level `busyKey` already communicates in-flight work).
   */
  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const [cat, res] = await Promise.all([getFeatureFlagCatalog(), resolveFeatureFlags(tenantId, accountId)]);
      setCatalog(cat.flags);
      setResolved(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feature flags');
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [tenantId, accountId]);

  const reload = useCallback(() => load(true), [load]);
  const refetch = useCallback(() => load(false), [load]);

  useEffect(() => { reload(); }, [reload]);

  /** The override row (if any) for a flag at exactly the active scope. */
  const overrideAtScope = useCallback(
    (flagKey: string): FeatureFlagOverride | undefined =>
      resolved?.overrides.find(
        (o) =>
          o.flag_key === flagKey &&
          o.scope_type === scope.type &&
          (scope.type !== 'account' || o.account_id === accountId),
      ),
    [resolved, scope, accountId],
  );

  const triStateFor = useCallback(
    (flagKey: string): TriState => toTriState(overrideAtScope(flagKey)?.value),
    [overrideAtScope],
  );

  /**
   * Sub-line describing where the inherited value comes from, driven by core's
   * per-flag `source` — precise attribution of env vs global vs tenant vs
   * registry default.
   */
  const inheritSubline = useCallback(
    (flag: FeatureFlagCatalogEntry): string => {
      const effective = resolved?.effective?.[flag.key];
      const on = effective === true;
      if (!on) return 'Inherited (default: Off)';
      // effective is On — attribute which layer made it so.
      switch (resolved?.source?.[flag.key]) {
        case 'global': return 'Inherited (default: On — set globally)';
        case 'env': return 'Inherited (default: On — from env)';
        case 'tenant': return 'Inherited (default: On — from tenant)';
        default: return 'Inherited (default: On)';
      }
    },
    [resolved],
  );

  const buildScopeBody = useCallback(() => {
    return scope.type === 'account'
      ? { scope_type: 'account' as FlagScopeType, tenant_id: tenantId, account_id: accountId }
      : { scope_type: 'tenant' as FlagScopeType, tenant_id: tenantId };
  }, [scope, tenantId, accountId]);

  const commitSet = useCallback(async (flagKey: string, value: unknown, why: string, expiry: string) => {
    setBusyKey(flagKey);
    try {
      await putFeatureFlagOverride(flagKey, {
        ...buildScopeBody(),
        value,
        reason: why.trim() || null,
        expires_at: expiry ? new Date(expiry).toISOString() : null,
      });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save override');
    } finally {
      setBusyKey(null);
    }
  }, [buildScopeBody, refetch]);

  const resetToInherited = useCallback(async (flagKey: string) => {
    setBusyKey(flagKey);
    try {
      await deleteFeatureFlagOverride(flagKey, buildScopeBody());
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset override');
    } finally {
      setBusyKey(null);
    }
  }, [buildScopeBody, refetch]);

  /** Is the capability currently resolved ON for the active scope? */
  const effectivelyOn = useCallback(
    (flagKey: string): boolean => resolved?.effective?.[flagKey] === true,
    [resolved],
  );

  /**
   * Would deleting this scope's override turn a guarded flag ON? Only at
   * account scope, with an explicit OFF override to delete (an On override
   * reset under an On tenant changes nothing), and the tenant row (or the
   * inherited default) On. This is an ENABLE in effect — e.g. clearing the
   * Off that excludes one account from a test tenant's transcript logging — yet
   * it is a DELETE, which carries no reason and skips the enable path's
   * warning, so it gets its own confirm.
   */
  const inheritWouldTurnOn = useCallback((flag: FeatureFlagCatalogEntry): boolean => {
    if (scope.type !== 'account' || !isGuardedWhenOn(flag)) return false;
    // Only an Off → On transition is guarded. Resetting an explicit On keeps it on.
    const ov = overrideAtScope(flag.key);
    if (!ov || ov.value === true) return false;
    const tenantRow = resolved?.overrides.find((o) => o.flag_key === flag.key && o.scope_type === 'tenant');
    return tenantRow ? tenantRow.value === true : resolved?.defaults?.[flag.key] === true;
  }, [scope, overrideAtScope, resolved]);

  /** Reset to inherited, through the turn-it-on confirm when that is what a reset does. */
  const requestInherit = useCallback((flag: FeatureFlagCatalogEntry) => {
    if (inheritWouldTurnOn(flag)) {
      setConfirmInheritOn(flag);
      return;
    }
    void resetToInherited(flag.key);
  }, [inheritWouldTurnOn, resetToInherited]);

  /** Apply the selection without further confirmation (post-confirm or non-destructive). */
  const applySelection = useCallback((flag: FeatureFlagCatalogEntry, next: TriState) => {
    if (next === 'inherit') {
      requestInherit(flag);
      return;
    }
    const value = next === 'on';
    setPending({ flagKey: flag.key, value, warning: value ? flag.policy?.warning : undefined });
  }, [requestInherit]);

  // Enabling + reset-when-already-off stay inline. Disabling a *currently-enabled*
  // capability (explicit Off, or Inherit that would drop it) routes through a
  // confirm dialog first. Enabling never confirms. A flag whose ON state is the
  // guarded one (transcript logging) skips it: off is its safe direction, and
  // the confirm's "hides it from them" copy would be wrong for it.
  const onSelect = useCallback((flag: FeatureFlagCatalogEntry, next: TriState) => {
    const disabling = (next === 'off' || next === 'inherit') && effectivelyOn(flag.key) && !isGuardedWhenOn(flag);
    if (disabling) {
      setConfirmDisable({ flag, next });
      return;
    }
    applySelection(flag, next);
  }, [effectivelyOn, applySelection]);

  /**
   * Route a numeric override reset through a confirm gate iff clearing it will
   * actually change the effective value seen at this scope (e.g. current is a
   * tenant override of 5000 but the inherited/env default is 3000). A no-op
   * reset (override matches the fallback) proceeds inline.
   */
  const requestNumericReset = useCallback((flag: FeatureFlagCatalogEntry) => {
    const effective = resolved?.effective?.[flag.key];
    const currentValue = typeof effective === 'number' ? effective : undefined;
    // The value the caller would land on if we deleted the scope's override.
    // For tenant scope: env/registry default. For account scope: still the
    // tenant/env/global fallback via the same resolve chain — we don't have
    // that in-memory without re-resolving, so this is a heuristic: use the
    // registry default. The confirm still surfaces value-change intent.
    const defaults = resolved?.defaults?.[flag.key];
    const fallbackValue = typeof defaults === 'number' ? defaults
      : typeof flag.default === 'number' ? flag.default
      : undefined;
    if (currentValue === undefined || currentValue === fallbackValue) {
      void resetToInherited(flag.key);
      return;
    }
    setConfirmReset({ flag, currentValue, fallbackValue });
  }, [resolved, resetToInherited]);

  const sortedFlags = useMemo(
    () => [...catalog].sort((a, b) => a.key.localeCompare(b.key)),
    [catalog],
  );

  /** Human label for the active scope (used in confirm copy). */
  const scopeLabel = scope.type === 'account'
    ? (accounts.find((a) => a.id === accountId)?.name ?? 'this account')
    : 'this tenant';

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2><Flag size={18} /> Feature Flags</h2>
      </div>
      <p className={styles.helper}>
        Roll capabilities out to this tenant. “Inherited” follows the platform default until you set an explicit override.
      </p>

      {/* Scope selector */}
      <div className={styles.scopeRow} role="radiogroup" aria-label="Override scope">
        <button
          type="button"
          role="radio"
          aria-checked={scope.type === 'tenant'}
          className={`${styles.scopeCard} ${scope.type === 'tenant' ? styles.scopeCardActive : ''}`}
          onClick={() => setScope({ type: 'tenant' })}
        >
          <span className={styles.scopeTitle}>Tenant</span>
          <span className={styles.scopeSub}>Applies to every account in this tenant.</span>
        </button>
        <div className={`${styles.scopeCard} ${scope.type === 'account' ? styles.scopeCardActive : ''}`}>
          <span className={styles.scopeTitle}>Account</span>
          <span className={styles.scopeSub}>Override just one account, on top of the tenant setting.</span>
          <select
            className={styles.scopeSelect}
            value={scope.type === 'account' ? scope.accountId : ''}
            onChange={(e) => {
              const v = e.target.value;
              setScope(v ? { type: 'account', accountId: v } : { type: 'tenant' });
            }}
          >
            <option value="">Select account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <span className={styles.globalChip} title="Set platform-wide defaults in the Feature Flags tab">
          Global defaults — managed in the Feature Flags tab
        </span>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <LoadingSpinner size="sm" />
      ) : (
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>State</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedFlags.map((flag) => {
                const tri = triStateFor(flag.key);
                const ov = overrideAtScope(flag.key);
                const isBoolean = flag.type === 'boolean';
                const isNumber = flag.type === 'number';
                // For numeric flags, prefer the effective (resolved) value; fall
                // back to the registry default so a fresh tenant still shows a
                // sensible number instead of the empty string.
                const effective = resolved?.effective?.[flag.key];
                const numericEffective = typeof effective === 'number' ? effective
                  : typeof flag.default === 'number' ? flag.default
                  : undefined;
                const numericSource = resolved?.source?.[flag.key];
                return (
                  <tr key={flag.key}>
                    <td>
                      <div className={styles.featName}>
                        {humanize(flag.key)}
                        <span className={styles.typeTag}>{flag.type}</span>
                      </div>
                      <div className={styles.featMeta}>
                        <span className={styles.ownerBadge}>{flag.owner}</span> · {flag.description}
                      </div>
                      <FlagPolicyWarning flag={flag} />
                    </td>
                    <td>
                      {isBoolean ? (
                        <BooleanFlagCell
                          flag={flag}
                          value={tri}
                          effectiveOn={effectivelyOn(flag.key)}
                          scope={scope.type}
                          ariaLabel={`${humanize(flag.key)} availability`}
                          inheritSub={inheritSubline(flag)}
                          busy={busyKey === flag.key}
                          onSelect={(next) => onSelect(flag, next)}
                        />
                      ) : isNumber ? (
                        <NumericFlagCell
                          flag={flag}
                          currentValue={numericEffective}
                          source={numericSource}
                          hasOverride={!!ov}
                          scope={scope.type}
                          busy={busyKey === flag.key}
                          onEdit={() => setPendingNumber({ flag, currentValue: numericEffective })}
                          onReset={() => requestNumericReset(flag)}
                        />
                      ) : (
                        <span className={styles.featMeta}>
                          {String(resolved?.effective?.[flag.key] ?? flag.default)}
                          {' '}· Set via API
                        </span>
                      )}
                    </td>
                    <td className={styles.featMeta}>
                      {ov?.expires_at ? relativeExpiry(ov.expires_at) : '—'}
                    </td>
                    <td>
                      {ov && !isNumber && (
                        <button
                          className={styles.resetBtn}
                          title="Reset to inherited"
                          disabled={busyKey === flag.key}
                          onClick={() => requestInherit(flag)}
                        >
                          <RotateCcw size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {sortedFlags.length === 0 && (
                <tr><td colSpan={4} className={styles.emptyRow}>No feature flags registered</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Reason/expiry dialog before committing an explicit On/Off */}
      {pending && (
        <OverrideReasonDialog
          title={`Set ${humanize(pending.flagKey)} → ${pending.value ? 'On' : 'Off'}`}
          warning={pending.warning}
          busy={busyKey === pending.flagKey}
          onClose={() => setPending(null)}
          onSubmit={(reason, expiry) => {
            void commitSet(pending.flagKey, pending.value, reason, expiry);
            setPending(null);
          }}
        />
      )}

      {/* Value + reason dialog for numeric flags (e.g. prewarm_ring_delay_ms). */}
      {pendingNumber && (() => {
        const bounds = numericBoundsFor(pendingNumber.flag.key);
        return (
          <NumberFlagDialog
            title={`Set ${humanize(pendingNumber.flag.key)}`}
            hint={bounds.hint}
            initialValue={pendingNumber.currentValue !== undefined ? String(pendingNumber.currentValue) : ''}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            busy={busyKey === pendingNumber.flag.key}
            onClose={() => setPendingNumber(null)}
            onSubmit={(value, reason, expiry) => {
              void commitSet(pendingNumber.flag.key, value, reason, expiry);
              setPendingNumber(null);
            }}
          />
        );
      })()}

      {/* Confirm before disabling a currently-enabled capability. */}
      {confirmDisable && (
        <ConfirmDialog
          title={`Turn off ${humanize(confirmDisable.flag.key)}?`}
          confirmLabel="Turn off"
          body={`${humanize(confirmDisable.flag.key)} is currently available to ${scopeLabel}. Turning it off hides it from them.`}
          onClose={() => setConfirmDisable(null)}
          onConfirm={() => {
            const { flag, next } = confirmDisable;
            setConfirmDisable(null);
            applySelection(flag, next);
          }}
        />
      )}

      {/* Confirm before an Inherit/reset that would turn a guarded flag ON. */}
      {confirmInheritOn && (
        <ConfirmDialog
          title={`Turn on ${humanize(confirmInheritOn.key)} for ${scopeLabel}?`}
          confirmLabel="Reset and turn on"
          body={
            `Resetting ${scopeLabel} to Inherit turns ${humanize(confirmInheritOn.key)} ON for it, because the tenant setting is On. `
            + (confirmInheritOn.policy?.warning ?? '')
          }
          onClose={() => setConfirmInheritOn(null)}
          onConfirm={() => {
            const flag = confirmInheritOn;
            setConfirmInheritOn(null);
            void resetToInherited(flag.key);
          }}
        />
      )}

      {/* Confirm before clearing a numeric override that would change the effective value. */}
      {confirmReset && (
        <ConfirmDialog
          title={`Reset ${humanize(confirmReset.flag.key)}?`}
          confirmLabel="Reset"
          body={
            `${humanize(confirmReset.flag.key)} is currently ${confirmReset.currentValue} for ${scopeLabel}. `
            + `Resetting will revert it to `
            + (confirmReset.fallbackValue !== undefined ? `${confirmReset.fallbackValue} (the inherited default).` : 'the inherited default.')
          }
          onClose={() => setConfirmReset(null)}
          onConfirm={() => {
            const { flag } = confirmReset;
            setConfirmReset(null);
            void resetToInherited(flag.key);
          }}
        />
      )}
    </div>
  );
}
