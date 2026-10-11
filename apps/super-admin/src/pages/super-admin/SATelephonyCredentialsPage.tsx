import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Plus, RefreshCw, ShieldCheck, Pencil, Ban, RotateCcw, Trash2 } from 'lucide-react';
import type {
  TelephonyCredential,
  TelephonyCredentialProvider,
  TelephonyCredentialUsage,
} from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import {
  createTelephonyCredential,
  getTelephonyCredential,
  listTelephonyCredentialProviders,
  listTelephonyCredentials,
  renameTelephonyCredential,
  rotateTelephonyCredentialSecret,
  verifyTelephonyCredential,
  disableTelephonyCredential,
  enableTelephonyCredential,
  revokeTelephonyCredential,
} from '../../api/super-admin';
import {
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatCard,
  StatusBadge,
} from '../../components/common';
import { TenantPicker } from '../../components/super-admin/TenantPicker';
import { useSuperAdminTenants } from '../../hooks/useSuperAdminTenants';
import { saStatusColor, saStatusLabel } from '../../utils/saStatus';
import styles from './SATelephonyCredentialsPage.module.css';

/**
 * Per-tenant carrier credentials (bring-your-own-carrier; decisions B18–B22).
 *
 * The secret is write-only: the forms send it, nothing ever shows it again — the
 * table shows a four-character hint. Every save is verified with the carrier first,
 * so a credential here is one the carrier accepted at the time.
 */

type FieldValues = Record<string, string>;
type CredentialAction = 'verify' | 'disable' | 'enable' | 'revoke';

const ACTIONS: Record<CredentialAction, (id: string) => Promise<TelephonyCredential>> = {
  verify: verifyTelephonyCredential,
  disable: disableTelephonyCredential,
  enable: enableTelephonyCredential,
  revoke: revokeTelephonyCredential,
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN') : '—');

export default function SATelephonyCredentialsPage() {
  const { tenants, loading: tenantsLoading } = useSuperAdminTenants();
  const tenantName = useMemo(() => new Map(tenants.map((t) => [t.id, t.name])), [tenants]);

  const [credentials, setCredentials] = useState<TelephonyCredential[]>([]);
  const [providers, setProviders] = useState<TelephonyCredentialProvider[]>([]);
  const [storeAvailable, setStoreAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterTenant, setFilterTenant] = useState('');
  const [showRevoked, setShowRevoked] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [usage, setUsage] = useState<TelephonyCredentialUsage | null>(null);

  // Create
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<{ tenant_id: string; provider: string; label: string; fields: FieldValues }>(
    { tenant_id: '', provider: '', label: '', fields: {} },
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Rotate / rename
  const [rotateTarget, setRotateTarget] = useState<TelephonyCredential | null>(null);
  const [rotateFields, setRotateFields] = useState<FieldValues>({});
  const [renameTarget, setRenameTarget] = useState<TelephonyCredential | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  // Status actions
  const [confirm, setConfirm] = useState<{ cred: TelephonyCredential; action: CredentialAction } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [creds, provs] = await Promise.all([
        listTelephonyCredentials({ tenant_id: filterTenant || undefined, include_revoked: showRevoked }),
        listTelephonyCredentialProviders(),
      ]);
      setCredentials(creds);
      setProviders(provs.providers);
      setStoreAvailable(provs.store_available);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load telephony credentials');
    } finally {
      setLoading(false);
    }
  }, [filterTenant, showRevoked]);

  useEffect(() => { void load(); }, [load]);

  const providerOf = (name: string) => providers.find((p) => p.provider === name);

  const stats = useMemo(() => {
    const out = { active: 0, attention: 0 };
    for (const c of credentials) {
      if (c.status === 'active') out.active++;
      if (c.status === 'invalid' || c.status === 'disabled') out.attention++;
    }
    return out;
  }, [credentials]);

  const replaceRow = (row: TelephonyCredential) =>
    setCredentials((prev) => prev.map((c) => (c.id === row.id ? row : c)));

  // The row whose usage the latest request is for: a slow answer for a row the admin has
  // since collapsed or left must not land under another row.
  const usageFor = useRef<string | null>(null);
  const toggleExpand = async (id: string) => {
    if (expandedId === id) { usageFor.current = null; setExpandedId(null); return; }
    usageFor.current = id;
    setExpandedId(id);
    setUsage(null);
    try {
      const { usage: u } = await getTelephonyCredential(id);
      if (usageFor.current === id) setUsage(u);
    } catch {
      if (usageFor.current === id) setUsage(null);
    }
  };

  const openCreate = () => {
    const first = providers[0]?.provider ?? '';
    setCreateForm({ tenant_id: filterTenant, provider: first, label: '', fields: {} });
    setCreateError(null);
    setShowCreate(true);
  };

  // Closing without saving drops what was typed, so a secret never lingers in state.
  const closeCreate = () => {
    setShowCreate(false);
    setCreateForm({ tenant_id: '', provider: '', label: '', fields: {} });
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setCreateError(null);
    try {
      await createTelephonyCredential({
        tenant_id: createForm.tenant_id,
        provider: createForm.provider,
        label: createForm.label,
        fields: createForm.fields,
      });
      // Drop the typed secret from memory as soon as it is sent.
      setCreateForm({ tenant_id: '', provider: '', label: '', fields: {} });
      setShowCreate(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to save credential');
    } finally {
      setSaving(false);
    }
  };

  const handleRotate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rotateTarget) return;
    setSaving(true);
    setModalError(null);
    try {
      replaceRow(await rotateTelephonyCredentialSecret(rotateTarget.id, {
        fields: rotateFields, expected_version: rotateTarget.secret_version,
      }));
      setRotateFields({});
      setRotateTarget(null);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to rotate secret');
    } finally {
      setSaving(false);
    }
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget) return;
    setSaving(true);
    setModalError(null);
    try {
      replaceRow(await renameTelephonyCredential(renameTarget.id, { label: renameLabel }));
      setRenameTarget(null);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : 'Failed to rename credential');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (cred: TelephonyCredential, action: CredentialAction) => {
    setBusyId(cred.id);
    setError(null);
    try {
      const row = await ACTIONS[action](cred.id);
      if (action === 'revoke' && !showRevoked) setCredentials((prev) => prev.filter((c) => c.id !== row.id));
      else replaceRow(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} credential`);
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const createProvider = providerOf(createForm.provider);
  const rotateProvider = rotateTarget ? providerOf(rotateTarget.provider) : undefined;

  if (loading && credentials.length === 0 && providers.length === 0) return <LoadingSpinner size="lg" />;

  return (
    <div>
      <PageHeader
        title="Telephony Credentials"
        subtitle="Tenants' own carrier accounts. Secrets are write-only and verified with the carrier on save."
        badge={credentials.length}
        actions={
          <button className="btn-primary" onClick={openCreate} disabled={!storeAvailable || providers.length === 0}>
            <Plus size={16} /> Add credential
          </button>
        }
      />

      {!storeAvailable && (
        <ErrorAlert message="The server has no credential keyring (TELEPHONY_CREDENTIAL_KEYS), so credentials cannot be added or used." />
      )}
      {error && <ErrorAlert message={error} onRetry={load} />}

      <div className={styles.statsGrid}>
        <StatCard title="Active" value={stats.active} color="var(--success)" />
        <StatCard title="Needs attention" value={stats.attention} color="var(--warning)" />
      </div>

      <div className={styles.filterBar}>
        <div className={styles.tenantFilter}>
          <TenantPicker
            tenants={tenants}
            value={filterTenant}
            onChange={setFilterTenant}
            loading={tenantsLoading}
            id="credential-tenant-filter"
            ariaLabel="Filter by tenant"
            placeholder="All tenants"
          />
        </div>
        <label className={styles.checkbox}>
          <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
          Show revoked
        </label>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Label</th>
              <th>Tenant</th>
              <th>Provider</th>
              <th>Account</th>
              <th>Secret</th>
              <th>Status</th>
              <th>Verified</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((c) => (
              <Fragment key={c.id}>
                <tr className={styles.clickableRow} onClick={() => void toggleExpand(c.id)}>
                  <td>
                    <div className={styles.labelCell}>
                      <KeyRound size={14} className={styles.icon} />
                      <span>{c.label}</span>
                    </div>
                  </td>
                  <td>{tenantName.get(c.tenant_id) ?? <span className={styles.mono}>{c.tenant_id}</span>}</td>
                  <td><span className={styles.providerBadge}>{providerOf(c.provider)?.display_name ?? c.provider}</span></td>
                  <td className={styles.mono}>{c.account_ref}</td>
                  <td className={styles.mono}>{c.secret_hint ? `••••${c.secret_hint}` : '—'} <span className={styles.muted}>v{c.secret_version}</span></td>
                  <td>
                    <StatusBadge label={saStatusLabel(c.status)} color={saStatusColor(c.status)} status={c.status} />
                  </td>
                  <td className={styles.muted}>{fmt(c.verified_at)}</td>
                </tr>
                {expandedId === c.id && (
                  <tr>
                    <td colSpan={7} className={styles.detailCell}>
                      <dl className={styles.detailGrid}>
                        <div className={styles.detailItem}><dt>ID</dt><dd className={styles.mono}>{c.id}</dd></div>
                        <div className={styles.detailItem}><dt>Campaigns dialling on it</dt><dd>{usage ? usage.campaigns : '…'}</dd></div>
                        <div className={styles.detailItem}><dt>Calls in flight</dt><dd>{usage ? usage.in_flight_calls : '…'}</dd></div>
                        <div className={styles.detailItem}><dt>Last error</dt><dd>{c.last_error ?? 'None'}</dd></div>
                        <div className={styles.detailItem}><dt>Updated</dt><dd>{fmt(c.updated_at)}</dd></div>
                        {c.revoked_at && <div className={styles.detailItem}><dt>Revoked</dt><dd>{fmt(c.revoked_at)}{c.shredded_at ? ' (secret destroyed)' : ''}</dd></div>}
                      </dl>
                      {c.status !== 'revoked' && (
                        <div className={styles.detailActions} onClick={(e) => e.stopPropagation()}>
                          <button className="btn-secondary" disabled={busyId === c.id} onClick={() => void runAction(c, 'verify')}>
                            <ShieldCheck size={14} /> Verify now
                          </button>
                          <button className="btn-secondary" onClick={() => { setRotateTarget(c); setRotateFields({}); setModalError(null); }}>
                            <RefreshCw size={14} /> Rotate secret
                          </button>
                          <button className="btn-secondary" onClick={() => { setRenameTarget(c); setRenameLabel(c.label); setModalError(null); }}>
                            <Pencil size={14} /> Rename
                          </button>
                          {c.status === 'disabled' ? (
                            <button className={`btn-secondary ${styles.successBtn}`} disabled={busyId === c.id} onClick={() => void runAction(c, 'enable')}>
                              <RotateCcw size={14} /> Enable
                            </button>
                          ) : (
                            <button className="btn-secondary" onClick={() => setConfirm({ cred: c, action: 'disable' })}>
                              <Ban size={14} /> Disable
                            </button>
                          )}
                          <button className={`btn-secondary ${styles.dangerBtn}`} onClick={() => setConfirm({ cred: c, action: 'revoke' })}>
                            <Trash2 size={14} /> Revoke
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {credentials.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title="No telephony credentials"
                    description={filterTenant ? 'This tenant dials on the service’s own carrier account.' : 'Add a tenant’s own carrier account. Campaigns can dial on it once that carrier’s dial path ships.'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="Add telephony credential"
        subtitle="Checked with the carrier before it is saved. The secret cannot be viewed afterwards."
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeCreate}>Cancel</button>
            <button type="submit" form="create-credential-form" className="btn-primary" disabled={saving || !createForm.tenant_id}>
              {saving ? 'Verifying…' : 'Verify and save'}
            </button>
          </>
        }
      >
        <form id="create-credential-form" onSubmit={handleCreate} className={styles.form} autoComplete="off">
          {createError && <div className={styles.error} role="alert">{createError}</div>}
          <div className={styles.field}>
            <label htmlFor="credential-tenant">Tenant</label>
            <TenantPicker
              tenants={tenants}
              value={createForm.tenant_id}
              onChange={(id) => setCreateForm((f) => ({ ...f, tenant_id: id }))}
              loading={tenantsLoading}
              id="credential-tenant"
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="credential-provider">Provider</label>
            <select
              id="credential-provider"
              value={createForm.provider}
              onChange={(e) => setCreateForm((f) => ({ ...f, provider: e.target.value, fields: {} }))}
              required
            >
              {providers.map((p) => <option key={p.provider} value={p.provider}>{p.display_name}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="credential-label">Label</label>
            <input
              id="credential-label"
              value={createForm.label}
              onChange={(e) => setCreateForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Acme main Plivo account"
              maxLength={100}
              required
            />
          </div>
          {createProvider?.fields.map((field) => (
            <div className={styles.field} key={field.key}>
              <label htmlFor={`credential-field-${field.key}`}>{field.label}</label>
              <input
                id={`credential-field-${field.key}`}
                type={field.secret ? 'password' : 'text'}
                autoComplete={field.secret ? 'new-password' : 'off'}
                spellCheck={false}
                value={createForm.fields[field.key] ?? ''}
                onChange={(e) => setCreateForm((f) => ({ ...f, fields: { ...f.fields, [field.key]: e.target.value } }))}
                required
              />
              {field.help && <p className={styles.help}>{field.help}</p>}
            </div>
          ))}
        </form>
      </Modal>

      <Modal
        open={rotateTarget !== null}
        onClose={() => { setRotateTarget(null); setRotateFields({}); }}
        title="Rotate secret"
        subtitle={rotateTarget ? `${rotateTarget.label} · ${rotateTarget.account_ref}. Calls placed before the rotation keep working.` : ''}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => { setRotateTarget(null); setRotateFields({}); }}>Cancel</button>
            <button type="submit" form="rotate-credential-form" className="btn-primary" disabled={saving}>
              {saving ? 'Verifying…' : 'Verify and rotate'}
            </button>
          </>
        }
      >
        <form id="rotate-credential-form" onSubmit={handleRotate} className={styles.form} autoComplete="off">
          {modalError && <div className={styles.error} role="alert">{modalError}</div>}
          {rotateProvider?.fields.filter((f) => f.secret).map((field) => (
            <div className={styles.field} key={field.key}>
              <label htmlFor={`rotate-field-${field.key}`}>New {field.label}</label>
              <input
                id={`rotate-field-${field.key}`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={rotateFields[field.key] ?? ''}
                onChange={(e) => setRotateFields((f) => ({ ...f, [field.key]: e.target.value }))}
                required
              />
            </div>
          ))}
        </form>
      </Modal>

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename credential"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setRenameTarget(null)}>Cancel</button>
            <button type="submit" form="rename-credential-form" className="btn-primary" disabled={saving}>Save</button>
          </>
        }
      >
        <form id="rename-credential-form" onSubmit={handleRename} className={styles.form}>
          {modalError && <div className={styles.error} role="alert">{modalError}</div>}
          <div className={styles.field}>
            <label htmlFor="rename-label">Label</label>
            <input id="rename-label" value={renameLabel} onChange={(e) => setRenameLabel(e.target.value)} maxLength={100} required />
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.action === 'revoke' ? 'Revoke credential?' : 'Disable credential?'}
        message={
          confirm?.action === 'revoke'
            ? `“${confirm.cred.label}” stops dialling for good, and its secret is destroyed once its live calls end. Earlier recordings on it can no longer be played. Campaigns still dialling on it must be moved first.`
            : `“${confirm?.cred.label ?? ''}” stops placing new calls. Calls already in progress finish normally. You can enable it again.`
        }
        confirmLabel={confirm?.action === 'revoke' ? 'Revoke' : 'Disable'}
        danger
        disabled={busyId !== null}
        onConfirm={() => { if (confirm) void runAction(confirm.cred, confirm.action); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
