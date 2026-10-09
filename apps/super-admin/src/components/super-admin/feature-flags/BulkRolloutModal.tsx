import { useState } from 'react';
import { bulkFeatureFlagOverride } from '../../../api/super-admin';
import type { FeatureFlagCatalogEntry, BulkFlagOverrideResult } from '@magick-agency/contracts/api/platform/super-admin';
import { FlagDialog } from './FlagDialog';
import { canBulkRollOut, humanize } from './flagUtils';
import styles from './featureFlags.module.css';

interface Props {
  /** Candidate flags to choose from (filtered here by `canBulkRollOut`). */
  flags: FeatureFlagCatalogEntry[];
  /** The flag pre-selected when the modal opens. */
  initialFlag: FeatureFlagCatalogEntry;
  onClose: () => void;
  onApplied: () => void;
}

/**
 * Roll a single boolean flag out (or back) across many tenants in one audited
 * action. Flag-first by design: this lives on the global registry, not inside
 * one tenant. Each tenant write carries the shared reason server-side.
 */
export function BulkRolloutModal({ flags, initialFlag, onClose, onApplied }: Props) {
  // Only boolean + tenant-scopable flags can take a true/false bulk value, and
  // a flag the server's policy bars from bulk (transcript logging) is never offered.
  const candidates = flags.filter(canBulkRollOut);
  const [flagKey, setFlagKey] = useState(initialFlag.key);
  const [tenantIds, setTenantIds] = useState('');
  const [enable, setEnable] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [result, setResult] = useState<BulkFlagOverrideResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Never fall back to a flag the filter excluded: a barred `initialFlag` must
  // not become the submitted flag just because nothing else matched.
  const flag = candidates.find((f) => f.key === flagKey) ?? candidates[0] ?? initialFlag;
  const flagAllowed = candidates.includes(flag);

  // Live-parsed, de-duplicated tenant id list + counter.
  const tenantIdList = [...new Set(tenantIds.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
  const count = tenantIdList.length;
  const canSubmit = flagAllowed && count >= 1 && reason.trim().length > 0 && !busy && !applied;
  const verb = enable ? 'Enable' : 'Disable';

  // Any edit re-arms the submit button (prevents accidental double-apply).
  function dirty<T>(setter: (v: T) => void) {
    return (v: T) => { setApplied(false); setter(v); };
  }

  const apply = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bulkFeatureFlagOverride(flag.key, {
        tenant_ids: tenantIdList,
        value: enable,
        reason: reason.trim(),
      });
      setResult(res);
      setApplied(true);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk apply failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlagDialog title="Roll out across tenants" onClose={onClose} variant="modal">
      <label className={styles.fieldLabel} htmlFor="bulk-flag">Flag</label>
      <select
        id="bulk-flag"
        className={styles.input}
        value={flag.key}
        onChange={(e) => dirty(setFlagKey)(e.target.value)}
      >
        {candidates.map((f) => (
          <option key={f.key} value={f.key}>{humanize(f.key)}</option>
        ))}
      </select>

      {/* Action — segmented Enable / Disable (not a checkbox). */}
      <label className={styles.fieldLabel}>Action</label>
      <div className={styles.triState} role="radiogroup" aria-label="Bulk action">
        <button
          type="button" role="radio" aria-checked={enable}
          className={`${styles.seg} ${enable ? styles.segOn : ''}`}
          onClick={() => dirty(setEnable)(true)}
        >Enable (On)</button>
        <button
          type="button" role="radio" aria-checked={!enable}
          className={`${styles.seg} ${!enable ? styles.segOff : ''}`}
          onClick={() => dirty(setEnable)(false)}
        >Disable (Off)</button>
      </div>

      <label className={styles.fieldLabel} htmlFor="bulk-tenants">
        Tenant IDs <span className={styles.countChip}>{count} {count === 1 ? 'tenant' : 'tenants'}</span>
      </label>
      <textarea
        id="bulk-tenants" className={styles.input} rows={3} value={tenantIds}
        onChange={(e) => dirty(setTenantIds)(e.target.value)} placeholder="One per line, or comma-separated"
      />

      <label className={styles.fieldLabel} htmlFor="bulk-reason">Reason (required)</label>
      <input
        id="bulk-reason" className={styles.input} value={reason}
        onChange={(e) => dirty(setReason)(e.target.value)} placeholder="Why is this changing? (shown in the audit log)"
      />

      {/* Restated summary — the confirmation gate for the multi-tenant action. */}
      <p className={styles.confirmBody}>
        {count >= 1
          ? `This will set ${humanize(flag.key)} = ${enable ? 'On' : 'Off'} for ${count} ${count === 1 ? 'tenant' : 'tenants'}. Each change is audited.`
          : 'Add at least one tenant ID.'}
      </p>

      {error && <div className={styles.error}>{error}</div>}
      {result && (
        <div className={styles.okMsg}>
          Applied to {result.applied.length} {result.applied.length === 1 ? 'tenant' : 'tenants'}
          {result.failed.length > 0 && `, ${result.failed.length} failed`}.
          {result.failed.length > 0 && (
            <ul className={styles.failList}>
              {result.failed.map((f) => (
                <li key={f.tenant_id}><code>{f.tenant_id}</code> — {f.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className={styles.popoverActions}>
        <button className="btn-secondary" onClick={onClose}>Close</button>
        <button className="btn-primary" disabled={!canSubmit} onClick={apply}>
          {busy ? 'Applying…' : `${verb} for ${count} ${count === 1 ? 'tenant' : 'tenants'}`}
        </button>
      </div>
    </FlagDialog>
  );
}
