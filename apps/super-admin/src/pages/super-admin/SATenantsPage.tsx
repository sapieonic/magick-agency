import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Plus, Search } from 'lucide-react';
import { useSuperAdminTenants } from '../../hooks/useSuperAdminTenants';
import { createTenant } from '../../api/super-admin';
import type { SuperAdminTenant } from '@magick-agency/contracts/api/platform/super-admin';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { ErrorText } from '../../components/common/ErrorText';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import type { Column } from '../../components/common/DataTable';
import { StatusBadge } from '../../components/common/StatusBadge';
import { EmptyState } from '../../components/common/EmptyState';
import { Modal } from '../../components/common/Modal';
import { saStatusColor, saStatusLabel } from '../../utils/saStatus';
import styles from './SATenantsPage.module.css';

export default function SATenantsPage() {
  const { tenants, loading, error, reload } = useSuperAdminTenants();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', owner_email: '', owner_name: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await createTenant({
        name: createForm.name,
        owner_email: createForm.owner_email,
        owner_name: createForm.owner_name || undefined,
      });
      setShowCreate(false);
      setCreateForm({ name: '', owner_email: '', owner_name: '' });
      reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setCreating(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      t => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q),
    );
  }, [tenants, search]);

  const columns: Column<SuperAdminTenant>[] = [
    {
      key: 'name',
      label: 'Tenant',
      render: t => (
        <div className={styles.nameCell}>
          <Building2 size={16} className={styles.nameIcon} />
          <div>
            <div className={styles.nameTitle}>{t.name}</div>
            <div className={`${styles.nameSlug} ${styles.mono}`}>{t.slug}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: t => (
        <StatusBadge label={saStatusLabel(t.status)} color={saStatusColor(t.status)} status={t.status} />
      ),
    },
    {
      key: 'member_count',
      label: 'Members',
      render: t => t.member_count,
    },
    {
      key: 'created_at',
      label: 'Created',
      render: t => new Date(t.created_at).toLocaleDateString('en-IN'),
    },
  ];

  if (error) return <ErrorAlert message={error} onRetry={reload} />;

  const showEmpty = !loading && tenants.length === 0;
  const showNoResults = !loading && tenants.length > 0 && filtered.length === 0;

  return (
    <div>
      <PageHeader
        title="Tenants"
        subtitle="Organizations on the platform — members and accounts."
        badge={tenants.length}
        actions={
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Add tenant
          </button>
        }
      />

      {!showEmpty && (
        <div className={styles.searchBar}>
          <Search size={16} className={styles.searchIcon} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search tenants by name or slug…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search tenants"
          />
        </div>
      )}

      {showEmpty ? (
        <EmptyState
          icon={<Building2 size={28} />}
          title="No tenants yet"
          description="Create the first tenant to get started."
          action={
            <button className="btn-primary" onClick={() => setShowCreate(true)}>
              <Plus size={16} /> Add tenant
            </button>
          }
        />
      ) : showNoResults ? (
        <EmptyState
          icon={<Search size={28} />}
          title="No matching tenants"
          description={`No tenant matches "${search.trim()}". Try a different name or slug.`}
        />
      ) : (
        <DataTable<SuperAdminTenant>
          columns={columns}
          data={filtered}
          loading={loading}
          keyExtractor={t => t.id}
          onRowClick={t => navigate(`/tenants/${t.id}`)}
        />
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add tenant"
        subtitle="Creates the organization and invites its owner."
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
            <button type="submit" form="create-tenant-form" className="btn-primary" disabled={creating}>
              {creating ? 'Creating…' : 'Create tenant'}
            </button>
          </>
        }
      >
        <form id="create-tenant-form" onSubmit={handleCreate} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="tenant-name">Organization name</label>
            <input
              id="tenant-name"
              value={createForm.name}
              onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Acme Corp"
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="tenant-owner-email">Owner email</label>
            <input
              id="tenant-owner-email"
              type="email"
              value={createForm.owner_email}
              onChange={e => setCreateForm(f => ({ ...f, owner_email: e.target.value }))}
              placeholder="owner@acme.com"
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="tenant-owner-name">Owner name (optional)</label>
            <input
              id="tenant-owner-name"
              value={createForm.owner_name}
              onChange={e => setCreateForm(f => ({ ...f, owner_name: e.target.value }))}
              placeholder="Jane Doe"
            />
          </div>
          {createError && <div className={styles.error}><ErrorText message={createError} /></div>}
        </form>
      </Modal>
    </div>
  );
}
