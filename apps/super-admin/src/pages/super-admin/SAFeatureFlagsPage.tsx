import { useState, useEffect, useCallback, useMemo } from 'react';
import { Flag, Layers } from 'lucide-react';
import {
  getFeatureFlagCatalog,
  putFeatureFlagOverride,
  deleteFeatureFlagOverride,
} from '../../api/super-admin';
import type { FeatureFlagCatalogEntry } from '@magick-agency/contracts/api/platform/super-admin';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { PageHeader } from '../../components/common/PageHeader';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { ConfirmDialog } from '../../components/common';
import { BooleanFlagCell } from '../../components/super-admin/feature-flags/BooleanFlagCell';
import { OverrideReasonDialog } from '../../components/super-admin/feature-flags/OverrideReasonDialog';
import { NumberFlagDialog } from '../../components/super-admin/feature-flags/NumberFlagDialog';
import { NumericFlagCell } from '../../components/super-admin/feature-flags/NumericFlagCell';
import { BulkRolloutModal } from '../../components/super-admin/feature-flags/BulkRolloutModal';
import { FlagPolicyWarning } from '../../components/super-admin/feature-flags/FlagPolicyWarning';
import { humanize, asBool, canBulkRollOut, numericBoundsFor, toTriState, type TriState } from '../../components/super-admin/feature-flags/flagUtils';
import styles from './SAFeatureFlagsPage.module.css';

/**
 * The value a flag inherits when no global override is set.
 *
 * `env_default` is ALREADY the resolved inherit layer, not "the env var's
 * value": core's `resolveEnvDefault` returns the registry `default` when the
 * flag's env var is unset, and no flag has a null default — so the field is
 * populated for every registered flag and `entry.default` here is only a guard
 * against a payload that omits it.
 *
 * The corollary is the reason this file no longer says "env:" anywhere: the
 * catalog response cannot distinguish "env var set" from "env var unset", so
 * any UI claiming it does is guessing. See {@link globalInheritSub}.
 */
function inheritedDefault(entry: FeatureFlagCatalogEntry): unknown {
  return entry.env_default ?? entry.default;
}

/** Does the global default currently resolve to On (override if set, else inherited)? */
function globalEffectiveOn(entry: FeatureFlagCatalogEntry): boolean {
  const hasOverride = entry.global_override !== null && entry.global_override !== undefined;
  return asBool(hasOverride ? entry.global_override : inheritedDefault(entry));
}

/**
 * Sub-line under "Inherit" reporting the value the global default falls back to.
 *
 * Deliberately does NOT name the layer. This page's only input is the catalog,
 * whose `env_default` is env-if-set-else-registry collapsed into one field with
 * no flag saying which — so "Inherited (env: On)" was asserted for every flag on
 * the page, including ones whose env var is not configured at all. An operator
 * reaching for the pre-warm kill switch during a provider-quota incident was
 * told `AI_PREWARM_ENABLED` was set to `true` when it may never have been set.
 *
 * The per-tenant tab CAN attribute this, because core's /resolve reports a
 * per-flag `source` and only says `env` when the var is genuinely set and
 * non-empty (`resolveEnvOrRegistryDefault`). Restoring attribution here needs
 * the same signal on the catalog route — see the `env_set` follow-up.
 */
function globalInheritSub(entry: FeatureFlagCatalogEntry): string {
  return `Inherited (default: ${asBool(inheritedDefault(entry)) ? 'On' : 'Off'})`;
}

interface PendingEdit {
  entry: FeatureFlagCatalogEntry;
  value: boolean;
}

/** Awaiting a value + reason in the numeric-override dialog. */
interface PendingNumberEdit {
  entry: FeatureFlagCatalogEntry;
  currentValue: number | undefined;
}

/**
 * Platform-wide Feature Flags registry. The flag-first home: browse the whole
 * catalog, set each flag's GLOBAL default (audited, with optional expiry), and
 * roll a flag out across many tenants. Per-tenant overrides live on the tenant
 * detail page. UX: docs/reference/magick-comms-cusui/docs/superpowers/plans/feature-flags-ux-redesign.md.
 */
export default function SAFeatureFlagsPage() {
  const [catalog, setCatalog] = useState<FeatureFlagCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [type, setType] = useState('');
  const [exposedOnly, setExposedOnly] = useState(false);

  // Dialogs
  const [pending, setPending] = useState<PendingEdit | null>(null);
  const [pendingNumber, setPendingNumber] = useState<PendingNumberEdit | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<{ entry: FeatureFlagCatalogEntry; next: TriState } | null>(null);
  // Confirm gate before clearing a numeric global override that would change the effective value.
  const [confirmReset, setConfirmReset] = useState<{ entry: FeatureFlagCatalogEntry; currentValue: number | undefined; fallbackValue: number | undefined } | null>(null);
  const [bulkFlag, setBulkFlag] = useState<FeatureFlagCatalogEntry | null>(null);

  /**
   * Load the catalog. `showSpinner` only true on initial mount — post-write
   * refetches keep the last-known table visible (row-level `busyKey` already
   * communicates in-flight work) to avoid a full-table flash after every save.
   */
  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const res = await getFeatureFlagCatalog();
      setCatalog(res.flags);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load feature flags');
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  const reload = useCallback(() => load(true), [load]);
  const refetch = useCallback(() => load(false), [load]);

  useEffect(() => { reload(); }, [reload]);

  const owners = useMemo(
    () => [...new Set(catalog.map((f) => f.owner))].sort(),
    [catalog],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...catalog]
      .filter((f) => (owner ? f.owner === owner : true))
      .filter((f) => (type ? f.type === type : true))
      .filter((f) => (exposedOnly ? f.client_exposed : true))
      .filter((f) =>
        needle
          ? f.key.toLowerCase().includes(needle) ||
            f.description.toLowerCase().includes(needle) ||
            f.owner.toLowerCase().includes(needle)
          : true,
      )
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [catalog, q, owner, type, exposedOnly]);

  // Flags eligible for cross-tenant bulk rollout: boolean (the modal writes
  // true/false), tenant-scopable, and not barred by master's policy.
  const bulkable = useMemo(() => catalog.filter(canBulkRollOut), [catalog]);

  const commitGlobal = useCallback(async (key: string, value: unknown, reason: string, expiry: string) => {
    setBusyKey(key);
    try {
      await putFeatureFlagOverride(key, {
        scope_type: 'global',
        value,
        reason: reason.trim() || null,
        expires_at: expiry ? new Date(expiry).toISOString() : null,
      });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save global default');
    } finally {
      setBusyKey(null);
    }
  }, [refetch]);

  const resetGlobal = useCallback(async (key: string) => {
    setBusyKey(key);
    try {
      await deleteFeatureFlagOverride(key, { scope_type: 'global' });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset global default');
    } finally {
      setBusyKey(null);
    }
  }, [refetch]);

  /**
   * Numeric reset with a confirm gate iff clearing the global override would
   * change the effective platform-wide value (env fallback ≠ current override).
   * A no-op reset (override already matches the fallback) proceeds inline.
   */
  const requestNumericReset = useCallback((entry: FeatureFlagCatalogEntry) => {
    const currentValue = typeof entry.global_override === 'number' ? entry.global_override : undefined;
    const inherited = inheritedDefault(entry);
    const fallbackValue = typeof inherited === 'number' ? inherited : undefined;
    if (currentValue === undefined || currentValue === fallbackValue) {
      void resetGlobal(entry.key);
      return;
    }
    setConfirmReset({ entry, currentValue, fallbackValue });
  }, [resetGlobal]);

  /** Apply without further confirmation (post-confirm or non-destructive). */
  const applySelection = useCallback((entry: FeatureFlagCatalogEntry, next: TriState) => {
    if (next === 'inherit') {
      void resetGlobal(entry.key);
      return;
    }
    setPending({ entry, value: next === 'on' });
  }, [resetGlobal]);

  // Disabling a globally-on capability is destructive platform-wide → confirm first.
  const onSelect = useCallback((entry: FeatureFlagCatalogEntry, next: TriState) => {
    const disabling = (next === 'off' || next === 'inherit') && globalEffectiveOn(entry);
    if (disabling) {
      setConfirmDisable({ entry, next });
      return;
    }
    applySelection(entry, next);
  }, [applySelection]);

  return (
    <div>
      <PageHeader
        title="Feature Flags"
        subtitle="Platform-wide capability registry. Set each flag's global default or roll one out across tenants. Per-tenant overrides live on each tenant's page."
        badge={catalog.length || undefined}
        actions={
          <button
            className="btn-primary"
            disabled={bulkable.length === 0}
            onClick={() => setBulkFlag(bulkable[0] ?? null)}
          >
            <Layers size={16} /> Roll out…
          </button>
        }
      />

      <div className={styles.filters}>
        <input
          className={styles.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search flags by name, description, or owner…"
          aria-label="Search feature flags"
        />
        <select className={styles.select} value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner">
          <option value="">All owners</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select className={styles.select} value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          <option value="boolean">boolean</option>
          <option value="number">number</option>
          <option value="string">string</option>
          <option value="json">json</option>
        </select>
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={exposedOnly} onChange={(e) => setExposedOnly(e.target.checked)} />
          Client-exposed only
        </label>
      </div>

      {error && <ErrorAlert message={error} onRetry={reload} />}

      {!loading && catalog.length > 0 && (
        <div className={styles.resultCount}>
          Showing <strong>{filtered.length}</strong> of <strong>{catalog.length}</strong> flags
        </div>
      )}

      {loading ? (
        <LoadingSpinner size="lg" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Flag size={32} />}
          title={catalog.length === 0 ? 'No feature flags registered' : 'No flags match your filters'}
          description={catalog.length === 0
            ? 'Flags appear here once they are registered in the platform registry.'
            : 'Try clearing the search or filters.'}
        />
      ) : (
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                <th>Flag</th>
                <th>Global default</th>
                <th>Inherited default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => {
                const isBoolean = entry.type === 'boolean';
                const isNumber = entry.type === 'number';
                const tri = toTriState(entry.global_override);
                const canRollOut = canBulkRollOut(entry);
                // For numeric flags, prefer the persisted global override; fall
                // back to env/registry so a fresh install still shows a value.
                const hasGlobalOverride = entry.global_override !== null && entry.global_override !== undefined;
                const inheritedNum = inheritedDefault(entry);
                const numericEffective = typeof entry.global_override === 'number' ? entry.global_override
                  : typeof inheritedNum === 'number' ? inheritedNum
                  : undefined;
                // Attribution: an explicit global override wins. Below that the
                // catalog reports no provenance (see `inheritedDefault`), so we
                // pass no `source` and the cell says "inherited default" instead
                // of naming a layer we cannot actually observe.
                const numericSource = hasGlobalOverride ? 'global' as const : undefined;
                return (
                  <tr key={entry.key}>
                    <td>
                      <div className={styles.featName}>
                        {humanize(entry.key)}
                        <span className={styles.typeTag}>{entry.type}</span>
                        {entry.client_exposed && <span className={styles.exposedBadge}>client</span>}
                      </div>
                      <div className={styles.featTags}>
                        <span className={styles.ownerBadge}>{entry.owner}</span>
                        <span className={`${styles.featKey} ${styles.mono}`}>{entry.key}</span>
                      </div>
                      {entry.description && (
                        <div className={styles.featDesc}>{entry.description}</div>
                      )}
                      <FlagPolicyWarning flag={entry} />
                    </td>
                    <td>
                      {isBoolean ? (
                        <BooleanFlagCell
                          flag={entry}
                          value={tri}
                          effectiveOn={globalEffectiveOn(entry)}
                          scope="global"
                          ariaLabel={`${humanize(entry.key)} global default`}
                          inheritSub={globalInheritSub(entry)}
                          busy={busyKey === entry.key}
                          onSelect={(next) => onSelect(entry, next)}
                        />
                      ) : isNumber ? (
                        <NumericFlagCell
                          flag={entry}
                          currentValue={numericEffective}
                          source={numericSource}
                          hasOverride={hasGlobalOverride}
                          scope="global"
                          busy={busyKey === entry.key}
                          onEdit={() => setPendingNumber({ entry, currentValue: numericEffective })}
                          onReset={() => requestNumericReset(entry)}
                        />
                      ) : (
                        <span className={styles.defaultsCell}>
                          {String(entry.global_override ?? inheritedDefault(entry) ?? '—')}{' '}
                          <span className="muted">· Set via API</span>
                        </span>
                      )}
                    </td>
                    <td
                      className={styles.defaultsCell}
                      title="Value used when no global override is set. The catalog does not report whether this flag's environment variable is configured, so this is the env value if one is set and the registry default otherwise."
                    >
                      <strong>{String(inheritedDefault(entry) ?? '—')}</strong>
                    </td>
                    <td>
                      {canRollOut && (
                        <button
                          className={`btn-secondary ${styles.rolloutBtn}`}
                          onClick={() => setBulkFlag(entry)}
                        >
                          <Layers size={13} /> Roll out…
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Reason/expiry before committing a global default. */}
      {pending && (
        <OverrideReasonDialog
          title={`Set ${humanize(pending.entry.key)} → ${pending.value ? 'On' : 'Off'} (global default)`}
          busy={busyKey === pending.entry.key}
          onClose={() => setPending(null)}
          onSubmit={(reason, expiry) => {
            void commitGlobal(pending.entry.key, pending.value, reason, expiry);
            setPending(null);
          }}
        />
      )}

      {/* Value + reason dialog for numeric flags (global default). */}
      {pendingNumber && (() => {
        const bounds = numericBoundsFor(pendingNumber.entry.key);
        return (
          <NumberFlagDialog
            title={`Set ${humanize(pendingNumber.entry.key)} (global default)`}
            hint={bounds.hint}
            initialValue={pendingNumber.currentValue !== undefined ? String(pendingNumber.currentValue) : ''}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            busy={busyKey === pendingNumber.entry.key}
            onClose={() => setPendingNumber(null)}
            onSubmit={(value, reason, expiry) => {
              void commitGlobal(pendingNumber.entry.key, value, reason, expiry);
              setPendingNumber(null);
            }}
          />
        );
      })()}

      {/* Confirm before clearing a numeric global override that would change the effective platform-wide value. */}
      <ConfirmDialog
        open={confirmReset !== null}
        danger
        title={confirmReset ? `Reset ${humanize(confirmReset.entry.key)} globally?` : ''}
        confirmLabel="Reset"
        message={
          confirmReset
            ? `${humanize(confirmReset.entry.key)} is currently ${confirmReset.currentValue} platform-wide. `
              + `Resetting will revert it to `
              + (confirmReset.fallbackValue !== undefined ? `${confirmReset.fallbackValue} (the inherited default).` : 'the inherited default.')
            : ''
        }
        onCancel={() => setConfirmReset(null)}
        onConfirm={() => {
          if (!confirmReset) return;
          const { entry } = confirmReset;
          setConfirmReset(null);
          void resetGlobal(entry.key);
        }}
      />

      {/* Confirm before turning a globally-on capability off (platform-wide). */}
      <ConfirmDialog
        open={confirmDisable !== null}
        danger
        title={confirmDisable ? `Turn off ${humanize(confirmDisable.entry.key)} globally?` : ''}
        confirmLabel="Turn off"
        message={
          confirmDisable
            ? `${humanize(confirmDisable.entry.key)} is currently on by default for every tenant. Turning it off removes it platform-wide — tenants with an explicit On override keep it.`
            : ''
        }
        onCancel={() => setConfirmDisable(null)}
        onConfirm={() => {
          if (!confirmDisable) return;
          const { entry, next } = confirmDisable;
          setConfirmDisable(null);
          applySelection(entry, next);
        }}
      />

      {bulkFlag && (
        <BulkRolloutModal
          flags={catalog}
          initialFlag={bulkFlag}
          onClose={() => setBulkFlag(null)}
          onApplied={reload}
        />
      )}
    </div>
  );
}
