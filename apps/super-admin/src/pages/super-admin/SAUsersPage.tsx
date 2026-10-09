import { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Users } from 'lucide-react';
import { useSuperAdminUsers } from '../../hooks/useSuperAdminUsers';
import { useSuperAdminTenants } from '../../hooks/useSuperAdminTenants';
import type { SuperAdminUser } from '@magick-agency/contracts/api/platform/super-admin';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  ErrorAlert,
  EmptyState,
} from '../../components/common';
import type { Column } from '../../components/common/DataTable';
import { TenantPicker } from '../../components/super-admin/TenantPicker';
import { saStatusColor, saStatusLabel, roleLabel } from '../../utils/saStatus';
import styles from './SAUsersPage.module.css';

export default function SAUsersPage() {
  const { users, loading, error, reload } = useSuperAdminUsers();
  const { tenants, loading: tenantsLoading } = useSuperAdminTenants();
  const [search, setSearch] = useState('');

  // Tenant filter is deep-linkable via `?tenant=<id>`, same convention as
  // Governance, so a link into "this tenant's users" can be shared/bookmarked.
  const [searchParams, setSearchParams] = useSearchParams();
  const tenantId = searchParams.get('tenant') ?? '';
  const setTenantId = useCallback((id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('tenant', id); else next.delete('tenant');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(u => {
      if (tenantId && !u.memberships.some(m => m.tenant_id === tenantId)) return false;
      if (!q) return true;
      return u.email.toLowerCase().includes(q) ||
        (u.display_name && u.display_name.toLowerCase().includes(q));
    });
  }, [users, search, tenantId]);

  const filtersActive = !!search.trim() || !!tenantId;

  const columns: Column<SuperAdminUser>[] = [
    {
      key: 'email',
      label: 'Email',
      render: (u) => (
        <div className={styles.emailCell}>
          {u.email}
          {u.is_pending && <span className={styles.pendingBadge}>Pending</span>}
        </div>
      ),
    },
    {
      key: 'phone_number',
      label: 'Phone',
      render: (u) => (u.phone_number && u.phone_number !== '0000000000' ? u.phone_number : '—'),
    },
    {
      key: 'display_name',
      label: 'Name',
      render: (u) => u.display_name || '—',
    },
    {
      key: 'status',
      label: 'Status',
      render: (u) => <StatusBadge label={saStatusLabel(u.status)} color={saStatusColor(u.status)} status={u.status} />,
    },
    {
      key: 'memberships',
      label: 'Memberships',
      render: (u) => (
        <div className={styles.memberships}>
          {u.memberships.map((m, i) => (
            <span key={i} className={styles.tenantChip}>
              {m.tenant_name} <span className={styles.roleLabel}>({roleLabel(m.role)})</span>
            </span>
          ))}
          {u.memberships.length === 0 && <span className={styles.noTenant}>No tenants</span>}
        </div>
      ),
    },
    {
      key: 'created_at',
      label: 'Joined',
      render: (u) => (
        <span className={styles.dateCell}>{new Date(u.created_at).toLocaleDateString('en-IN')}</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="All users across every tenant"
        badge={users.length}
      />

      {error && <ErrorAlert message={error} onRetry={reload} />}

      <div className={styles.searchRow}>
        <div className={styles.searchBar}>
          <Search size={16} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by email or name…"
            aria-label="Search users"
          />
        </div>
        <TenantPicker
          id="users-tenant-filter"
          tenants={tenants}
          value={tenantId}
          onChange={setTenantId}
          loading={tenantsLoading}
          placeholder="Filter by tenant…"
          ariaLabel="Filter by tenant"
        />
        {filtersActive && !loading && (
          <span className={styles.resultCount}>
            {filtered.length} of {users.length}
          </span>
        )}
      </div>

      {!loading && filtersActive && filtered.length === 0 ? (
        <EmptyState
          icon={<Users size={28} />}
          title="No users found"
          description="No users match your search. Try a different email, name or tenant."
        />
      ) : (
        <DataTable<SuperAdminUser>
          columns={columns}
          data={filtered}
          loading={loading}
          keyExtractor={(u) => u.id}
        />
      )}
    </div>
  );
}
