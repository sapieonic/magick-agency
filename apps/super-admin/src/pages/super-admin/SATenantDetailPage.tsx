import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Phone } from 'lucide-react';
import { useSuperAdminTenant } from '../../hooks/useSuperAdminTenant';
import {
  getTenantPhoneNumbers, assignPhoneNumber, unassignPhoneNumber, listPhoneNumbers, getTenantAccounts,
} from '../../api/super-admin';
import type {
  TenantAccountWithConcurrency, TenantPhoneAssignment, PhoneNumber,
} from '@magick-agency/contracts/api/platform/super-admin';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { Breadcrumbs } from '@magick-agency/web-ui/components/Breadcrumbs';
import { StatusBadge } from '@magick-agency/web-ui/components/StatusBadge';
import { DataTable } from '@magick-agency/web-ui/components/DataTable';
import type { Column } from '@magick-agency/web-ui/components/DataTable';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { telephonyProviderAlias } from '@magick-agency/web-ui/telephonyProviders';
import { TenantFeatureFlags } from '../../components/super-admin/TenantFeatureFlags';
import { saStatusColor, saStatusLabel } from '../../utils/saStatus';
import { TenantServiceTab } from './tenant-detail/TenantServiceTab';
import { TenantMembersTab } from './tenant-detail/TenantMembersTab';
import styles from './SATenantDetailPage.module.css';

type TenantTab = 'overview' | 'service' | 'flags' | 'members';

const TABS: Array<{ id: TenantTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'service', label: 'Service' },
  { id: 'flags', label: 'Feature Flags' },
  { id: 'members', label: 'Members' },
];

export default function SATenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, refreshError, reload } = useSuperAdminTenant(id);

  // Active tab — splits the long single-scroll page so each concern (and the
  // Feature Flags table in particular) gets its own surface. Backed by a URL
  // param so a tab is deep-linkable and survives refresh / back-nav.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TenantTab = TABS.some(t => t.id === tabParam) ? (tabParam as TenantTab) : 'overview';
  const setTab = (id: TenantTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  // Phone number management
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneAssignment[]>([]);
  const [phonesLoading, setPhonesLoading] = useState(false);
  const [phonesError, setPhonesError] = useState<string | null>(null);
  const [allPhoneNumbers, setAllPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [assignableError, setAssignableError] = useState<string | null>(null);
  const [showAssignPhone, setShowAssignPhone] = useState(false);
  const [assignPhoneId, setAssignPhoneId] = useState('');
  const [assignPhoneDefault, setAssignPhoneDefault] = useState(false);
  const [assigningPhone, setAssigningPhone] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [unassignTarget, setUnassignTarget] = useState<TenantPhoneAssignment | null>(null);

  // Accounts: the Service, Flags and Members tabs all read them.
  const [accounts, setAccounts] = useState<TenantAccountWithConcurrency[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    if (!id) return;
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const accs = await getTenantAccounts(id);
      setAccounts(accs);
    } catch (err) {
      // A failure is not "no accounts": say so, with a retry.
      setAccounts([]);
      setAccountsError(err instanceof Error ? err.message : 'Failed to load accounts');
    } finally {
      setAccountsLoading(false);
    }
  }, [id]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const loadPhones = useCallback(async () => {
    if (!id) return;
    setPhonesLoading(true);
    setPhonesError(null);
    try {
      const phones = await getTenantPhoneNumbers(id);
      setTenantPhones(phones);
    } catch (err) {
      // A failure is not "no numbers assigned": say so, with a retry.
      setTenantPhones([]);
      setPhonesError(err instanceof Error ? err.message : 'Failed to load phone numbers');
    } finally {
      setPhonesLoading(false);
    }
  }, [id]);

  useEffect(() => { loadPhones(); }, [loadPhones]);

  const handleOpenAssignPhone = async () => {
    setShowAssignPhone(true);
    setAssignPhoneId('');
    setAssignPhoneDefault(false);
    setPhoneError(null);
    setAssignableError(null);
    try {
      const all = await listPhoneNumbers({ status: 'active' });
      setAllPhoneNumbers(all);
    } catch (err) {
      // An empty picker would read as "nothing left to assign".
      setAllPhoneNumbers([]);
      setAssignableError(err instanceof Error ? err.message : 'Failed to load phone numbers');
    }
  };

  const handleAssignPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignPhoneId) return;
    setAssigningPhone(true);
    setPhoneError(null);
    try {
      await assignPhoneNumber(assignPhoneId, { tenant_id: id!, is_default: assignPhoneDefault });
      setShowAssignPhone(false);
      loadPhones();
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : 'Failed to assign phone number');
    } finally {
      setAssigningPhone(false);
    }
  };

  const handleUnassignPhone = async () => {
    if (!unassignTarget) return;
    const target = unassignTarget;
    setUnassignTarget(null);
    try {
      await unassignPhoneNumber(target.phone_number_id, id!);
      loadPhones();
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : 'Failed to unassign');
    }
  };

  if (loading) return <LoadingSpinner size="lg" />;
  if (error) return <ErrorAlert message={error} onRetry={reload} />;
  if (!data) return <ErrorAlert message="Tenant not found" />;

  const { tenant, members } = data;
  const accountOptions = accounts.map(a => ({ id: a.id, name: a.name }));

  const phoneColumns: Column<TenantPhoneAssignment>[] = [
    {
      key: 'phone_number',
      label: 'Phone Number',
      render: p => <span className={styles.mono}>{p.phone_number}</span>,
    },
    {
      key: 'provider',
      label: 'Provider',
      render: p => telephonyProviderAlias(p.provider_name, p.provider_display_name),
    },
    { key: 'label', label: 'Label', render: p => p.label || '--' },
    { key: 'is_default', label: 'Default', render: p => (p.is_default ? 'Yes' : '--') },
    { key: 'max_concurrent_calls', label: 'Max Concurrent', render: p => p.max_concurrent_calls },
    {
      key: 'actions',
      label: '',
      render: p => (
        <button
          className={styles.iconBtn}
          onClick={() => setUnassignTarget(p)}
          title="Unassign"
          aria-label={`Unassign ${p.phone_number}`}
        >
          <Trash2 size={14} />
        </button>
      ),
    },
  ];

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: 'Tenants', href: '/tenants' },
          { label: tenant.name },
        ]}
      />

      <PageHeader
        title={tenant.name}
        subtitle={tenant.slug}
        actions={
          <StatusBadge
            label={saStatusLabel(tenant.status)}
            color={saStatusColor(tenant.status)}
            status={tenant.status}
          />
        }
      />

      {/* Tab strip */}
      <div className={styles.tabs} role="tablist" aria-label="Tenant sections">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview: phone numbers ── */}
      {tab === 'overview' && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2><Phone size={18} /> Phone Numbers ({tenantPhones.length})</h2>
            <button className="btn-primary" onClick={handleOpenAssignPhone}>
              <Plus size={14} /> Assign number
            </button>
          </div>
          {phoneError && <div className={styles.error}><ErrorText message={phoneError} /></div>}
          {phonesError ? (
            <ErrorAlert message={phonesError} onRetry={loadPhones} />
          ) : !phonesLoading && tenantPhones.length === 0 ? (
            <EmptyState
              icon={<Phone size={28} />}
              title="No phone numbers assigned"
              description="Assign a number from agency's phone-number inventory so this tenant can place and receive calls."
              action={
                <button className="btn-primary" onClick={handleOpenAssignPhone}>
                  <Plus size={16} /> Assign number
                </button>
              }
            />
          ) : (
            <DataTable<TenantPhoneAssignment>
              columns={phoneColumns}
              data={tenantPhones}
              loading={phonesLoading}
              keyExtractor={p => p.id}
            />
          )}
        </div>
      )}

      {/* ── Service: per-account settings + per-account concurrency ── */}
      {tab === 'service' && (accountsError ? (
        <ErrorAlert message={accountsError} onRetry={loadAccounts} />
      ) : (
        <TenantServiceTab
          tenantId={id!}
          accounts={accounts}
          accountsLoading={accountsLoading}
          onReloadAccounts={loadAccounts}
        />
      ))}

      {/* ── Feature Flags: per-tenant / per-account rollout controls ── */}
      {tab === 'flags' && id && (
        <TenantFeatureFlags
          tenantId={id}
          accounts={accountOptions}
        />
      )}

      {/* ── Members ── */}
      {tab === 'members' && (
        <TenantMembersTab
          tenantId={id!}
          tenantName={tenant.name}
          members={members}
          accounts={accountOptions}
          refreshError={refreshError}
          reload={reload}
        />
      )}

      {/* Assign Phone Number Modal */}
      <Modal
        open={showAssignPhone}
        onClose={() => setShowAssignPhone(false)}
        title="Assign phone number"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setShowAssignPhone(false)}>Cancel</button>
            <button type="submit" form="assign-phone-form" className="btn-primary" disabled={assigningPhone || !assignPhoneId}>
              {assigningPhone ? 'Assigning...' : 'Assign'}
            </button>
          </>
        }
      >
        <form id="assign-phone-form" onSubmit={handleAssignPhone} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="assign-phone-select">Phone Number</label>
            <select
              id="assign-phone-select"
              value={assignPhoneId}
              onChange={e => setAssignPhoneId(e.target.value)}
              required
            >
              <option value="">Select a phone number...</option>
              {allPhoneNumbers
                .filter(pn => !tenantPhones.some(tp => tp.phone_number_id === pn.id))
                .map(pn => (
                  <option key={pn.id} value={pn.id}>
                    {pn.phone_number} ({telephonyProviderAlias(pn.provider_name, pn.provider_display_name)}){pn.label ? ` - ${pn.label}` : ''}
                  </option>
                ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={assignPhoneDefault}
                onChange={e => setAssignPhoneDefault(e.target.checked)}
              />
              Set as default for this tenant
            </label>
          </div>
          {assignableError && <div className={styles.error}><ErrorText message={assignableError} /></div>}
          {phoneError && <div className={styles.error}><ErrorText message={phoneError} /></div>}
        </form>
      </Modal>

      {/* Unassign Phone Confirmation */}
      <ConfirmDialog
        open={!!unassignTarget}
        title="Unassign phone number"
        message={unassignTarget
          ? `Unassign ${unassignTarget.phone_number} from ${tenant.name}?`
          : ''}
        confirmLabel="Unassign"
        danger
        onConfirm={handleUnassignPhone}
        onCancel={() => setUnassignTarget(null)}
      />
    </div>
  );
}
