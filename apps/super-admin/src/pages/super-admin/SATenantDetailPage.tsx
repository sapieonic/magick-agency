import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Plus, UserPlus, Trash2, Phone, PhoneOff, Save, Gauge, SlidersHorizontal, Settings, UserCog, UserMinus } from 'lucide-react';
import { useSuperAdminTenant } from '../../hooks/useSuperAdminTenant';
import {
  addUserToTenant, getTenantPhoneNumbers, assignPhoneNumber, unassignPhoneNumber, listPhoneNumbers,
  getTenantAccounts, updateAccountConcurrency, getAccountConcurrency, listTelephonyProviders, updateProviderConcurrency,
  getAccountSettings, updateAccountSettings, changeMembershipRole, revokeMembership,
} from '../../api/super-admin';
import type {
  AccountConcurrencyDetail, TenantAccountWithConcurrency, SuperAdminTenantMember,
  TenantPhoneAssignment, PhoneNumber,
} from '@magick-agency/contracts/api/platform/super-admin';
import type { AgencyAccountSettings, UpdateAgencyAccountSettingsBody } from '@magick-agency/contracts/api/platform/settings';
import type { Role } from '@magick-agency/contracts/rbac';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { ErrorText } from '../../components/common/ErrorText';
import { EmptyState } from '../../components/common/EmptyState';
import { PageHeader } from '../../components/common/PageHeader';
import { Breadcrumbs } from '../../components/common/Breadcrumbs';
import { StatusBadge } from '../../components/common/StatusBadge';
import { DataTable } from '../../components/common/DataTable';
import type { Column } from '../../components/common/DataTable';
import { Modal } from '../../components/common/Modal';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { TenantFeatureFlags } from '../../components/super-admin/TenantFeatureFlags';
import { saStatusColor, saStatusLabel, roleLabel } from '../../utils/saStatus';
import { parseStrictInteger } from '../../utils/strictInteger';
import { telephonyProviderAlias } from '../../config/telephonyProviders';
import styles from './SATenantDetailPage.module.css';

/**
 * Plan lets a super-admin grant any of the six roles, including `agent`
 * (the Agency Dialer's agent members).
 */
const ROLES: readonly Role[] = ['tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer', 'agent'];

/** Plan / contract `AgencyAccountSettings.webrtc_max_duration_seconds`. */
const WEBRTC_MAX_DURATION_MIN = 60;
const WEBRTC_MAX_DURATION_MAX = 14_400;

/** Agency has one carrier (plan Decided #3); used when an account has no breakdown rows yet. */

type TenantTab = 'overview' | 'service' | 'flags' | 'members';

const TABS: Array<{ id: TenantTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'service', label: 'Service' },
  { id: 'flags', label: 'Feature Flags' },
  { id: 'members', label: 'Members' },
];

/**
 * NEW: the per-account settings row that replaces governance.
 * One account at a time; a PATCH carries only the fields that changed.
 */
function AccountSettingsPanel({ tenantId, accounts }: {
  tenantId: string;
  accounts: Array<{ id: string; name: string }>;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [settings, setSettings] = useState<AgencyAccountSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allowRecording, setAllowRecording] = useState(false);
  const [analyzeCalls, setAnalyzeCalls] = useState(false);
  const [duration, setDuration] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const apply = (s: AgencyAccountSettings) => {
    setSettings(s);
    setAllowRecording(s.allow_recording);
    setAnalyzeCalls(s.analyze_calls);
    setDuration(String(s.webrtc_max_duration_seconds));
  };

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  useEffect(() => {
    if (!accountId) return;
    const seq = ++requestSequence.current;
    setLoading(true);
    setLoadError(null);
    setSettings(null);
    setSaveError(null);
    setSaved(null);
    setReason('');
    getAccountSettings(tenantId, accountId)
      .then(res => { if (seq === requestSequence.current) apply(res.settings); })
      .catch(err => {
        if (seq === requestSequence.current) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load account settings');
        }
      })
      .finally(() => { if (seq === requestSequence.current) setLoading(false); });
  }, [tenantId, accountId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaveError(null);
    setSaved(null);
    const body: UpdateAgencyAccountSettingsBody = {};
    if (allowRecording !== settings.allow_recording) body.allow_recording = allowRecording;
    if (analyzeCalls !== settings.analyze_calls) body.analyze_calls = analyzeCalls;
    if (duration.trim() !== String(settings.webrtc_max_duration_seconds)) {
      const parsed = parseStrictInteger(duration);
      if (parsed === null || parsed < WEBRTC_MAX_DURATION_MIN || parsed > WEBRTC_MAX_DURATION_MAX) {
        setSaveError(
          `Max call duration must be a whole number of seconds between ${WEBRTC_MAX_DURATION_MIN} and ${WEBRTC_MAX_DURATION_MAX}.`,
        );
        return;
      }
      body.webrtc_max_duration_seconds = parsed;
    }
    if (Object.keys(body).length === 0) return;
    if (reason.trim()) body.reason = reason.trim();
    setSaving(true);
    try {
      const res = await updateAccountSettings(tenantId, accountId, body);
      apply(res.settings);
      setReason('');
      setSaved('Account settings saved.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save account settings');
    } finally {
      setSaving(false);
    }
  };

  const dirty = settings !== null && (
    allowRecording !== settings.allow_recording
    || analyzeCalls !== settings.analyze_calls
    || duration.trim() !== String(settings.webrtc_max_duration_seconds)
  );

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2><Settings size={18} /> Account Settings</h2>
      </div>
      <p className={styles.hint}>
        Recording, call analysis and the hard cap on a bridged call, per account. These replace the
        old governance toggles. Campaigns are still checked per field against these values.
      </p>
      {accounts.length === 0 ? (
        <EmptyState icon={<PhoneOff size={28} />} title="No accounts" />
      ) : (
        <form onSubmit={handleSave} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="settings-account">Account</label>
            <select id="settings-account" value={accountId} onChange={e => setAccountId(e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {loading && <LoadingSpinner size="sm" />}
          {loadError && <div className={styles.error}><ErrorText message={loadError} /></div>}
          {settings && (
            <>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={allowRecording} onChange={e => setAllowRecording(e.target.checked)} />
                Allow recording
              </label>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={analyzeCalls} onChange={e => setAnalyzeCalls(e.target.checked)} />
                Analyze calls
              </label>
              <div className={styles.field}>
                <label htmlFor="settings-duration">Max call duration (seconds)</label>
                <input
                  id="settings-duration"
                  value={duration}
                  inputMode="numeric"
                  onChange={e => { setDuration(e.target.value); setSaveError(null); }}
                />
                <span className={styles.hint}>
                  {WEBRTC_MAX_DURATION_MIN} to {WEBRTC_MAX_DURATION_MAX}. A bridged call is hung up at this length.
                </span>
              </div>
              <div className={styles.field}>
                <label htmlFor="settings-max-concurrent">Max concurrent calls</label>
                <input id="settings-max-concurrent" value={settings.max_concurrent_calls} readOnly disabled />
                <span className={styles.hint}>Read-only here: set it with the concurrency editor above.</span>
              </div>
              <div className={styles.field}>
                <label htmlFor="settings-reason">Reason (optional)</label>
                <input id="settings-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />
              </div>
              {saveError && <div className={styles.error}><ErrorText message={saveError} /></div>}
              {saved && <div className={styles.success} role="status">{saved}</div>}
              <div>
                <button type="submit" className="btn-primary" disabled={saving || !dirty}>
                  {saving ? 'Saving...' : 'Save settings'}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}

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

  // Add user form
  const [showAddUser, setShowAddUser] = useState(false);
  const [userForm, setUserForm] = useState({ email: '', role: 'operator' as string, name: '', account_id: '' });
  const [addingUser, setAddingUser] = useState(false);
  const [addUserError, setAddUserError] = useState<string | null>(null);

  // Change role / revoke (NEW, plan)
  const [roleTarget, setRoleTarget] = useState<SuperAdminTenantMember | null>(null);
  const [roleForm, setRoleForm] = useState({ role: 'operator' as string, reason: '' });
  const [changingRole, setChangingRole] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SuperAdminTenantMember | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [memberNote, setMemberNote] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  // Phone number management
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneAssignment[]>([]);
  const [phonesLoading, setPhonesLoading] = useState(false);
  const [allPhoneNumbers, setAllPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [showAssignPhone, setShowAssignPhone] = useState(false);
  const [assignPhoneId, setAssignPhoneId] = useState('');
  const [assignPhoneDefault, setAssignPhoneDefault] = useState(false);
  const [assigningPhone, setAssigningPhone] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [unassignTarget, setUnassignTarget] = useState<TenantPhoneAssignment | null>(null);

  // Account concurrency
  const [accounts, setAccounts] = useState<TenantAccountWithConcurrency[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [concurrencyEdits, setConcurrencyEdits] = useState<Record<string, number>>({});
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

  const loadAccounts = useCallback(async () => {
    if (!id) return;
    setAccountsLoading(true);
    try {
      const accs = await getTenantAccounts(id);
      setAccounts(accs);
      const edits: Record<string, number> = {};
      accs.forEach(a => { if (a.max_concurrent_calls !== null) edits[a.id] = a.max_concurrent_calls; });
      setConcurrencyEdits(edits);
    } catch {
      setAccounts([]);
    } finally {
      setAccountsLoading(false);
    }
  }, [id]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const handleSaveConcurrency = async (accountId: string) => {
    const value = concurrencyEdits[accountId];
    if (value === undefined || value < 1 || value > 1000) return;
    setSavingConcurrency(prev => ({ ...prev, [accountId]: true }));
    setConcurrencyMsg(prev => ({ ...prev, [accountId]: '' }));
    try {
      await updateAccountConcurrency(id!, accountId, value);
      setConcurrencyMsg(prev => ({ ...prev, [accountId]: 'Saved' }));
      setTimeout(() => setConcurrencyMsg(prev => ({ ...prev, [accountId]: '' })), 2000);
    } catch (err) {
      setConcurrencyMsg(prev => ({ ...prev, [accountId]: err instanceof Error ? err.message : 'Failed' }));
    } finally {
      setSavingConcurrency(prev => ({ ...prev, [accountId]: false }));
    }
  };

  const handleOpenProviderConcurrency = async (account: TenantAccountWithConcurrency) => {
    if (!id) return;
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
        getAccountConcurrency(id, account.id),
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
    if (!id || !concurrencyTarget || !concurrencyDetail) return;
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
      await updateProviderConcurrency(id, concurrencyTarget.id, {
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
      await loadAccounts();
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
    if (!id || !concurrencyTarget || !concurrencyDetail) return;
    if (concurrencyChangeReason.trim().length < 3 || !concurrencyImpactConfirmed) {
      setProviderConcurrencyError('Enter a reason and confirm the impact before rollback.');
      return;
    }
    setSavingProviderConcurrency(true);
    setProviderConcurrencyError(null);
    try {
      await updateProviderConcurrency(id, concurrencyTarget.id, {
        mode: 'legacy_total',
        version: concurrencyDetail.allocation.version,
        max_concurrent_calls: concurrencyDetail.allocation.total_concurrency,
        change_reason: concurrencyChangeReason.trim(),
      });
      setConcurrencyTarget(null);
      setConcurrencyDetail(null);
      await loadAccounts();
    } catch (err) {
      setProviderConcurrencyError(err instanceof Error ? err.message : 'Failed to switch to legacy mode');
    } finally {
      setSavingProviderConcurrency(false);
    }
  };

  const loadPhones = useCallback(async () => {
    if (!id) return;
    setPhonesLoading(true);
    try {
      const phones = await getTenantPhoneNumbers(id);
      setTenantPhones(phones);
    } catch {
      setTenantPhones([]);
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
    try {
      const all = await listPhoneNumbers({ status: 'active' });
      setAllPhoneNumbers(all);
    } catch {
      setAllPhoneNumbers([]);
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

  const resetAddUser = () => setUserForm({ email: '', role: 'operator', name: '', account_id: '' });

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddingUser(true);
    setAddUserError(null);
    try {
      await addUserToTenant(id!, {
        email: userForm.email,
        role: userForm.role as Role,
        name: userForm.name || undefined,
        ...(userForm.account_id ? { account_id: userForm.account_id } : {}),
      });
      setShowAddUser(false);
      resetAddUser();
      reload();
    } catch (err) {
      setAddUserError(err instanceof Error ? err.message : 'Failed to add user');
    } finally {
      setAddingUser(false);
    }
  };

  const openChangeRole = (m: SuperAdminTenantMember) => {
    setRoleTarget(m);
    setRoleForm({ role: m.role, reason: '' });
    setRoleError(null);
  };

  const handleChangeRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !roleTarget) return;
    const target = roleTarget;
    setChangingRole(true);
    setRoleError(null);
    try {
      await changeMembershipRole(id, target.id, {
        role: roleForm.role as Role,
        ...(roleForm.reason.trim() ? { reason: roleForm.reason.trim() } : {}),
      });
      setRoleTarget(null);
      setMemberError(null);
      setMemberNote(`${target.email} is now ${roleLabel(roleForm.role)}.`);
      await reload({ silent: true });
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : 'Failed to change role');
    } finally {
      setChangingRole(false);
    }
  };

  const handleRevoke = async () => {
    if (!id || !revokeTarget) return;
    const target = revokeTarget;
    setRevoking(true);
    setMemberError(null);
    try {
      const res = await revokeMembership(id, target.id);
      setRevokeTarget(null);
      setMemberNote(
        `Revoked ${target.email}. ${res.staffing_closed} campaign assignment${res.staffing_closed === 1 ? '' : 's'} closed.`,
      );
      await reload({ silent: true });
    } catch (err) {
      setRevokeTarget(null);
      setMemberNote(null);
      setMemberError(err instanceof Error ? err.message : 'Failed to revoke membership');
    } finally {
      setRevoking(false);
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

  const memberColumns: Column<SuperAdminTenantMember>[] = [
    { key: 'email', label: 'Email', render: m => m.email },
    {
      key: 'phone_number',
      label: 'Phone',
      render: m => (m.phone_number && m.phone_number !== '0000000000'
        ? <span className={styles.mono}>{m.phone_number}</span>
        : '-'),
    },
    { key: 'display_name', label: 'Name', render: m => m.display_name || '-' },
    { key: 'role', label: 'Role', render: m => roleLabel(m.role) },
    {
      key: 'user_status',
      label: 'Status',
      render: m => (
        <StatusBadge
          label={saStatusLabel(m.user_status)}
          color={saStatusColor(m.user_status)}
          status={m.user_status}
        />
      ),
    },
    {
      key: 'actions',
      label: '',
      render: m => (
        <div className={styles.concurrencyActions}>
          <button
            className="btn-secondary"
            onClick={() => openChangeRole(m)}
            aria-label={`Change role for ${m.email}`}
          >
            <UserCog size={12} /> Change role
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => setRevokeTarget(m)}
            title="Revoke"
            aria-label={`Revoke ${m.email}`}
          >
            <UserMinus size={14} />
          </button>
        </div>
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
          {!phonesLoading && tenantPhones.length === 0 ? (
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
      {tab === 'service' && (<>
        <AccountSettingsPanel tenantId={id!} accounts={accountOptions} />

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
      </>)}

      {/* ── Feature Flags: per-tenant / per-account rollout controls ── */}
      {tab === 'flags' && id && (
        <TenantFeatureFlags
          tenantId={id}
          accounts={accountOptions}
        />
      )}

      {/* ── Members ── */}
      {tab === 'members' && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2><UserPlus size={18} /> Members ({members.length})</h2>
            <button className="btn-primary" onClick={() => setShowAddUser(true)}>
              <Plus size={14} /> Add user
            </button>
          </div>
          {memberNote && <div className={styles.success} role="status">{memberNote}</div>}
          {memberError && <div className={styles.error} role="alert"><ErrorText message={memberError} /></div>}
          {refreshError && (
            <div className={styles.hint} role="status">
              The change was saved, but the member list could not be refreshed. Reload the page to see it.
            </div>
          )}
          {members.length === 0 ? (
            <EmptyState
              icon={<UserPlus size={28} />}
              title="No members"
              description="Add a user to grant access to this tenant."
              action={
                <button className="btn-primary" onClick={() => setShowAddUser(true)}>
                  <Plus size={16} /> Add user
                </button>
              }
            />
          ) : (
            <DataTable<SuperAdminTenantMember>
              columns={memberColumns}
              data={members}
              keyExtractor={m => m.id}
            />
          )}
        </div>
      )}

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

      {/* Add user Modal */}
      <Modal
        open={showAddUser}
        onClose={() => setShowAddUser(false)}
        title="Add user to tenant"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setShowAddUser(false)}>Cancel</button>
            <button type="submit" form="add-user-form" className="btn-primary" disabled={addingUser}>
              {addingUser ? 'Adding...' : 'Add User'}
            </button>
          </>
        }
      >
        <form id="add-user-form" onSubmit={handleAddUser} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="add-user-email">Email</label>
            <input
              id="add-user-email"
              type="email"
              value={userForm.email}
              onChange={e => setUserForm(f => ({ ...f, email: e.target.value }))}
              placeholder="user@example.com"
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="add-user-name">Name (optional)</label>
            <input
              id="add-user-name"
              value={userForm.name}
              onChange={e => setUserForm(f => ({ ...f, name: e.target.value }))}
              placeholder="John Doe"
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="add-user-role">Role</label>
            <select
              id="add-user-role"
              value={userForm.role}
              onChange={e => setUserForm(f => ({ ...f, role: e.target.value }))}
            >
              {ROLES.map(r => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="add-user-account">Account (optional)</label>
            <select
              id="add-user-account"
              value={userForm.account_id}
              onChange={e => setUserForm(f => ({ ...f, account_id: e.target.value }))}
            >
              <option value="">Whole tenant</option>
              {accountOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {addUserError && <div className={styles.error}><ErrorText message={addUserError} /></div>}
        </form>
      </Modal>

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
          {phoneError && <div className={styles.error}><ErrorText message={phoneError} /></div>}
        </form>
      </Modal>

      {/* Change role Modal */}
      <Modal
        open={!!roleTarget}
        onClose={() => setRoleTarget(null)}
        title="Change role"
        subtitle={roleTarget ? `Change the role of ${roleTarget.email} in ${tenant.name}.` : undefined}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setRoleTarget(null)}>Cancel</button>
            <button type="submit" form="change-role-form" className="btn-primary" disabled={changingRole}>
              {changingRole ? 'Saving...' : 'Change role'}
            </button>
          </>
        }
      >
        <form id="change-role-form" onSubmit={handleChangeRole} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="change-role-select">Role</label>
            <select
              id="change-role-select"
              value={roleForm.role}
              onChange={e => setRoleForm(f => ({ ...f, role: e.target.value }))}
            >
              {ROLES.map(r => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="change-role-reason">Reason (optional)</label>
            <input
              id="change-role-reason"
              value={roleForm.reason}
              onChange={e => setRoleForm(f => ({ ...f, reason: e.target.value }))}
              maxLength={500}
            />
          </div>
          {roleError && <div className={styles.error}><ErrorText message={roleError} /></div>}
        </form>
      </Modal>

      {/* Revoke Confirmation */}
      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke membership"
        message={revokeTarget
          ? `Revoke ${revokeTarget.email}'s access to ${tenant.name}? Their campaign assignments are closed too.`
          : ''}
        confirmLabel={revoking ? 'Revoking...' : 'Revoke'}
        danger
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />

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
