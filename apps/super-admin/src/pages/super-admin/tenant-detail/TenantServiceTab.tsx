import { useState, useEffect, useRef } from 'react';
import { Gauge, PhoneOff, Save, SlidersHorizontal } from 'lucide-react';
import {
  updateAccountConcurrency, getAccountConcurrency, listTelephonyProviders, updateProviderConcurrency,
} from '../../../api/super-admin';
import type {
  AccountConcurrencyDetail, TenantAccountWithConcurrency,
} from '@magick-agency/contracts/api/platform/super-admin';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { telephonyProviderAlias } from '@magick-agency/web-ui/telephonyProviders';
import { AccountSettingsPanel } from './AccountSettingsPanel';
import styles from '../SATenantDetailPage.module.css';

/** The legacy flat totals, by account id, that the inputs start from. */
function legacyEdits(accounts: TenantAccountWithConcurrency[]): Record<string, number> {
  const edits: Record<string, number> = {};
  accounts.forEach(a => { if (a.max_concurrent_calls !== null) edits[a.id] = a.max_concurrent_calls; });
  return edits;
}

/**
 * The Service tab: per-account settings, the per-account concurrency table
 * (legacy flat totals and provider breakdowns) and the provider allocation
 * editor. The page owns loading the accounts (the Flags and Members tabs use
 * them too); this tab seeds its legacy-total edits from them and asks the page
 * to reload after a save.
 */
export function TenantServiceTab({ tenantId, accounts, accountsLoading, onReloadAccounts }: {
  tenantId: string;
  accounts: TenantAccountWithConcurrency[];
  accountsLoading: boolean;
  onReloadAccounts: () => Promise<void>;
}) {
  const [concurrencyEdits, setConcurrencyEdits] = useState<Record<string, number>>(() => legacyEdits(accounts));
  const [savingConcurrency, setSavingConcurrency] = useState<Record<string, boolean>>({});
  const [concurrencyMsg, setConcurrencyMsg] = useState<Record<string, string>>({});
  const [concurrencyTarget, setConcurrencyTarget] = useState<TenantAccountWithConcurrency | null>(null);
  const [concurrencyDetail, setConcurrencyDetail] = useState<AccountConcurrencyDetail | null>(null);
  const [providerConcurrencyEdits, setProviderConcurrencyEdits] = useState<Record<string, number>>({});
  const [concurrencyDetailLoading, setConcurrencyDetailLoading] = useState(false);
  const [savingProviderConcurrency, setSavingProviderConcurrency] = useState(false);
  const [providerConcurrencyError, setProviderConcurrencyError] = useState<string | null>(null);
  const [concurrencyChangeReason, setConcurrencyChangeReason] = useState('');
  const [concurrencyImpactConfirmed, setConcurrencyImpactConfirmed] = useState(false);
  const [forceMigrationAvailable, setForceMigrationAvailable] = useState(false);
  const concurrencyRequestSequence = useRef(0);
  // One clear-timer per account's "Saved" note: a second save replaces the
  // first's timer, and unmounting clears them all.
  const savedNoteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const timers = savedNoteTimers.current;
    return () => { Object.values(timers).forEach(clearTimeout); };
  }, []);

  // Re-seed the legacy-total inputs on every (re)load of the accounts, during
  // render rather than in an effect, so no edit can land between the new
  // accounts and the seeding (React's "adjust state on a prop change").
  const [seededFrom, setSeededFrom] = useState(accounts);
  if (seededFrom !== accounts) {
    setSeededFrom(accounts);
    setConcurrencyEdits(legacyEdits(accounts));
  }

  const accountOptions = accounts.map(a => ({ id: a.id, name: a.name }));

  const handleSaveConcurrency = async (accountId: string) => {
    const value = concurrencyEdits[accountId];
    if (value === undefined || value < 1 || value > 1000) return;
    setSavingConcurrency(prev => ({ ...prev, [accountId]: true }));
    setConcurrencyMsg(prev => ({ ...prev, [accountId]: '' }));
    try {
      await updateAccountConcurrency(tenantId, accountId, value);
      setConcurrencyMsg(prev => ({ ...prev, [accountId]: 'Saved' }));
      clearTimeout(savedNoteTimers.current[accountId]);
      savedNoteTimers.current[accountId] = setTimeout(() => {
        delete savedNoteTimers.current[accountId];
        setConcurrencyMsg(prev => ({ ...prev, [accountId]: '' }));
      }, 2000);
    } catch (err) {
      setConcurrencyMsg(prev => ({ ...prev, [accountId]: err instanceof Error ? err.message : 'Failed' }));
    } finally {
      setSavingConcurrency(prev => ({ ...prev, [accountId]: false }));
    }
  };

  const handleOpenProviderConcurrency = async (account: TenantAccountWithConcurrency) => {
    if (!tenantId) return;
    const requestSequence = ++concurrencyRequestSequence.current;
    setConcurrencyTarget(account);
    setConcurrencyDetail(null);
    setProviderConcurrencyError(null);
    setConcurrencyChangeReason('');
    setConcurrencyImpactConfirmed(false);
    setForceMigrationAvailable(false);
    setConcurrencyDetailLoading(true);
    try {
      const [detail, catalog] = await Promise.all([
        getAccountConcurrency(tenantId, account.id),
        listTelephonyProviders(),
      ]);
      if (requestSequence !== concurrencyRequestSequence.current) return;
      setConcurrencyDetail(detail);
      // The catalog comes from `GET /telephony-providers` (the concurrency
      // detail has no `providers`). Seeding: every active provider at 0,
      // then the allocation's own rows on top (an inactive provider with an
      // allocation, e.g. the snapshot `switchToLegacy` keeps, still shows).
      const edits: Record<string, number> = {};
      catalog.filter(p => p.status === 'active').forEach(p => { edits[p.name] = 0; });
      detail.allocation.providers.forEach(row => { edits[row.provider] = row.max_concurrent_calls; });
      setProviderConcurrencyEdits(edits);
    } catch (err) {
      if (requestSequence !== concurrencyRequestSequence.current) return;
      setProviderConcurrencyError(err instanceof Error ? err.message : 'Failed to load provider allocations');
    } finally {
      if (requestSequence === concurrencyRequestSequence.current) setConcurrencyDetailLoading(false);
    }
  };

  const handleSaveProviderConcurrency = async (forceMigration = false) => {
    if (!tenantId || !concurrencyTarget || !concurrencyDetail) return;
    const providers = Object.entries(providerConcurrencyEdits)
      .map(([provider, max_concurrent_calls]) => ({ provider, max_concurrent_calls }));
    const total = providers.reduce((sum, row) => sum + row.max_concurrent_calls, 0);
    if (total < 1) {
      setProviderConcurrencyError('Allocate at least one concurrency slot to a provider.');
      return;
    }
    if (total > 1000) {
      setProviderConcurrencyError('Total concurrency cannot exceed 1,000.');
      return;
    }
    if (concurrencyChangeReason.trim().length < 3) {
      setProviderConcurrencyError('Enter a reason for this commercial allocation change.');
      return;
    }
    if (!concurrencyImpactConfirmed) {
      setProviderConcurrencyError('Review and confirm the active/queued call impact before saving.');
      return;
    }

    setSavingProviderConcurrency(true);
    setProviderConcurrencyError(null);
    try {
      await updateProviderConcurrency(tenantId, concurrencyTarget.id, {
        mode: 'provider_breakdown',
        version: concurrencyDetail.allocation.version,
        providers,
        change_reason: concurrencyChangeReason.trim(),
        ...(forceMigration ? { force_migration: true } : {}),
      });
      setConcurrencyMsg(prev => ({ ...prev, [concurrencyTarget.id]: 'Saved' }));
      setConcurrencyTarget(null);
      setConcurrencyDetail(null);
      setForceMigrationAvailable(false);
      await onReloadAccounts();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save provider allocations';
      const statusCode = typeof err === 'object' && err !== null && 'statusCode' in err
        ? (err as { statusCode?: unknown }).statusCode
        : undefined;
      const details = typeof err === 'object' && err !== null && 'details' in err
        ? (err as { details?: unknown }).details
        : undefined;
      const activeCalls = typeof details === 'object' && details !== null && 'active_calls' in details
        ? Number((details as { active_calls?: unknown }).active_calls)
        : null;
      if (statusCode === 409 && Number.isFinite(activeCalls)) {
        setForceMigrationAvailable(true);
        setProviderConcurrencyError(
          `${message}. ${activeCalls} call(s) are active. Drain them, or use the explicit force migration action after confirming the impact.`,
        );
      } else {
        setProviderConcurrencyError(statusCode === 409
          ? `${message} Reloading the latest allocation; review your changes before retrying.`
          : message);
      }
      if (statusCode === 409 && !Number.isFinite(activeCalls) && concurrencyTarget) {
        await handleOpenProviderConcurrency(concurrencyTarget);
      }
    } finally {
      setSavingProviderConcurrency(false);
    }
  };

  const handleRollbackProviderConcurrency = async () => {
    if (!tenantId || !concurrencyTarget || !concurrencyDetail) return;
    if (concurrencyChangeReason.trim().length < 3 || !concurrencyImpactConfirmed) {
      setProviderConcurrencyError('Enter a reason and confirm the impact before rollback.');
      return;
    }
    setSavingProviderConcurrency(true);
    setProviderConcurrencyError(null);
    try {
      await updateProviderConcurrency(tenantId, concurrencyTarget.id, {
        mode: 'legacy_total',
        version: concurrencyDetail.allocation.version,
        max_concurrent_calls: concurrencyDetail.allocation.total_concurrency,
        change_reason: concurrencyChangeReason.trim(),
      });
      setConcurrencyTarget(null);
      setConcurrencyDetail(null);
      await onReloadAccounts();
    } catch (err) {
      setProviderConcurrencyError(err instanceof Error ? err.message : 'Failed to switch to legacy mode');
    } finally {
      setSavingProviderConcurrency(false);
    }
  };

  return (
    <>
      <AccountSettingsPanel tenantId={tenantId} accounts={accountOptions} />

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2><Gauge size={18} /> Account Concurrency</h2>
        </div>
        <p className={styles.hint}>
          Allocate concurrency by provider. The account total is the sum of provider allocations,
          while legacy accounts retain their existing flat limit until migrated.
        </p>
        {accountsLoading ? (
            <LoadingSpinner size="sm" />
          ) : accounts.length === 0 ? (
            <EmptyState icon={<PhoneOff size={28} />} title="No accounts" />
          ) : (
            <div className={styles.table}>
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Slug</th>
                    <th>Allocation</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(acc => (
                    <tr key={acc.id}>
                      <td>{acc.name}</td>
                      <td><span className={styles.mono}>{acc.slug}</span></td>
                      <td>
                        {acc.concurrency?.mode === 'provider_breakdown' ? (
                          <div className={styles.providerSummary}>
                            {acc.concurrency.providers.map(row => (
                              <span key={row.provider}>
                                {telephonyProviderAlias(row.provider)}: {row.max_concurrent_calls}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className={styles.legacyLabel}>Legacy total</span>
                        )}
                      </td>
                      <td><strong>{acc.max_concurrent_calls ?? 'Unavailable'}</strong></td>
                      <td>
                        <div className={styles.concurrencyActions}>
                          {acc.concurrency?.mode !== 'provider_breakdown' && (
                            <>
                              <input
                                type="number"
                                min={1}
                                max={1000}
                                className={styles.concurrencyInput}
                                value={concurrencyEdits[acc.id] ?? acc.max_concurrent_calls ?? ''}
                                onChange={(e) => {
                                  const v = Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1));
                                  setConcurrencyEdits(prev => ({ ...prev, [acc.id]: v }));
                                  setConcurrencyMsg(prev => ({ ...prev, [acc.id]: '' }));
                                }}
                                aria-label={`Legacy max concurrent calls for ${acc.name}`}
                              />
                              <button
                                className="btn-secondary"
                                disabled={
                                  savingConcurrency[acc.id] ||
                                  acc.max_concurrent_calls === null ||
                                  concurrencyEdits[acc.id] === acc.max_concurrent_calls
                                }
                                onClick={() => handleSaveConcurrency(acc.id)}
                              >
                                <Save size={12} />
                                {savingConcurrency[acc.id] ? '...' : 'Save legacy total'}
                              </button>
                            </>
                          )}
                          <button
                            className="btn-secondary"
                            onClick={() => handleOpenProviderConcurrency(acc)}
                          >
                            <SlidersHorizontal size={12} />
                            Manage providers
                          </button>
                          {concurrencyMsg[acc.id] && (
                            <span
                              className={
                                concurrencyMsg[acc.id] === 'Saved' ? styles.msgSuccess : styles.msgError
                              }
                            >
                              {concurrencyMsg[acc.id]}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <Modal
        open={!!concurrencyTarget}
        onClose={() => {
          concurrencyRequestSequence.current += 1;
          setConcurrencyTarget(null);
          setConcurrencyDetail(null);
          setProviderConcurrencyError(null);
          setForceMigrationAvailable(false);
        }}
        title={`Provider concurrency${concurrencyTarget ? ` — ${concurrencyTarget.name}` : ''}`}
        subtitle="Each call consumes capacity only from the provider behind its selected telephone number."
        size="lg"
        footer={
          <>
            {concurrencyDetail?.allocation.mode === 'provider_breakdown' && (
              <button
                type="button"
                className="btn-secondary"
                disabled={savingProviderConcurrency || !concurrencyImpactConfirmed || concurrencyChangeReason.trim().length < 3}
                onClick={handleRollbackProviderConcurrency}
              >
                Switch to legacy mode
              </button>
            )}
            {forceMigrationAvailable && concurrencyDetail?.allocation.mode === 'legacy_total' && (
              <button
                type="button"
                className="btn-secondary"
                disabled={
                  savingProviderConcurrency ||
                  concurrencyChangeReason.trim().length < 3 ||
                  !concurrencyImpactConfirmed
                }
                onClick={() => handleSaveProviderConcurrency(true)}
              >
                Force migration with active calls
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setConcurrencyTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={
                savingProviderConcurrency ||
                concurrencyDetailLoading ||
                !concurrencyDetail ||
                Object.values(providerConcurrencyEdits).reduce((sum, value) => sum + value, 0) < 1 ||
                Object.values(providerConcurrencyEdits).reduce((sum, value) => sum + value, 0) > 1000 ||
                concurrencyChangeReason.trim().length < 3 ||
                !concurrencyImpactConfirmed
              }
              onClick={() => handleSaveProviderConcurrency(false)}
            >
              {savingProviderConcurrency ? 'Saving...' : 'Save provider allocation'}
            </button>
          </>
        }
      >
        {concurrencyDetailLoading ? (
          <LoadingSpinner size="sm" />
        ) : concurrencyDetail ? (
          <div className={styles.providerAllocationEditor}>
            <div className={styles.concurrencyTotal}>
              <span>Total user concurrency</span>
              <strong>
                {Object.values(providerConcurrencyEdits).reduce((sum, value) => sum + value, 0)}
              </strong>
            </div>
            {concurrencyDetail.allocation.mode === 'legacy_total' && (
              <div className={styles.warningBox}>
                This account currently uses a legacy total of {concurrencyDetail.allocation.total_concurrency}.
                Saving will migrate it to provider-level enforcement.
                Migration is blocked until all currently active calls have drained.
              </div>
            )}
            {concurrencyDetail.utilization?.status === 'unavailable' && (
              <div className={styles.warningBox} role="status">
                Live utilization is unavailable. Capacity is shown as unknown and saving should be deferred until telemetry recovers.
              </div>
            )}
            <div className={styles.table}>
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Allocated</th>
                    <th>In use</th>
                    <th>Available</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(providerConcurrencyEdits).map(name => {
                    const utilization = concurrencyDetail.utilization?.providers.find(
                      row => row.provider === name,
                    );
                    return (
                      <tr key={name}>
                        <td>
                          <strong>{telephonyProviderAlias(name)}</strong>
                          <div className={styles.providerMeta}>{name}</div>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            max={1000}
                            className={styles.concurrencyInput}
                            value={providerConcurrencyEdits[name] ?? 0}
                            onChange={event => {
                              const value = Math.max(0, Math.min(1000, Number.parseInt(event.target.value, 10) || 0));
                              setProviderConcurrencyEdits(current => ({ ...current, [name]: value }));
                              setProviderConcurrencyError(null);
                            }}
                            aria-label={`Concurrency allocated to ${telephonyProviderAlias(name)}`}
                          />
                        </td>
                        <td>{utilization?.in_use === null || utilization === undefined ? 'Unknown' : utilization.in_use}</td>
                        <td>
                          {utilization?.in_use === null || utilization === undefined
                            ? 'Unknown'
                            : Math.max(0, (providerConcurrencyEdits[name] ?? 0) - utilization.in_use)}
                          {utilization?.draining && <div className={styles.providerWarning}>Draining</div>}
                          {(utilization?.over_limit ?? 0) > 0 && (
                            <div className={styles.providerWarning}>Over limit by {utilization?.over_limit}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.field}>
              <label htmlFor="concurrency-change-reason">Change reason</label>
              <textarea
                id="concurrency-change-reason"
                value={concurrencyChangeReason}
                onChange={event => setConcurrencyChangeReason(event.target.value)}
                placeholder="Contract, procurement, or approved operational reason"
                rows={2}
              />
            </div>
            <label className={styles.confirmRow}>
              <input
                type="checkbox"
                checked={concurrencyImpactConfirmed}
                onChange={event => setConcurrencyImpactConfirmed(event.target.checked)}
              />
              I reviewed active usage, provider readiness, and the impact on queued campaigns.
            </label>
            {providerConcurrencyError && (
              <div className={styles.error}><ErrorText message={providerConcurrencyError} /></div>
            )}
          </div>
        ) : providerConcurrencyError ? (
          <div className={styles.error}><ErrorText message={providerConcurrencyError} /></div>
        ) : null}
      </Modal>
    </>
  );
}
