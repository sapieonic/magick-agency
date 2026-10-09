import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useSuperAdminAudit } from '../../hooks/useSuperAdminAudit';
import { PageHeader } from '../../components/common/PageHeader';
import { DataTable } from '../../components/common/DataTable';
import type { Column } from '../../components/common/DataTable';
import { Pagination } from '../../components/common/Pagination';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { EmptyState } from '../../components/common/EmptyState';
import { Modal } from '../../components/common/Modal';
import type { SuperAdminAuditEntry } from '@magick-agency/contracts/api/platform/super-admin';
import { localDayEndIso, localDayStartIso } from '../../utils/localDayBounds';
import styles from './SAAuditPage.module.css';

const ACTION_LABELS: Record<string, string> = {
  create_tenant: 'Created tenant',
  add_user_to_tenant: 'Added user to tenant',
  create_admin: 'Created admin',
  remove_admin: 'Removed admin',
  reactivate_admin: 'Reactivated admin',
  reset_admin_password: 'Reset admin password',
  // NEW in magick-agency (actions the agency super-admin routes write).
  change_membership_role: 'Changed membership role',
  revoke_membership: 'Revoked membership',
  update_account_settings: 'Updated account settings',
};

function formatAction(action: string): string {
  return ACTION_LABELS[action] || action.replace(/[._]/g, ' ');
}

function formatResourceType(resourceType: string): string {
  return resourceType.replace(/_/g, ' ');
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

const PREVIEW_KEYS = 3;
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

function DetailsCell({ details }: { details: Record<string, unknown> }) {
  const keys = Object.keys(details);
  if (keys.length === 0) return <span className={styles.detailsEmpty}>—</span>;

  const preview = keys.slice(0, PREVIEW_KEYS);
  const hasMore = keys.length > PREVIEW_KEYS;

  return (
    <span className={styles.detailsChips}>
      {preview.map((k) => (
        <span key={k} className={styles.chip}>
          <span className={styles.chipKey}>{k}</span>
          <span className={styles.chipVal}>{formatValue(details[k])}</span>
        </span>
      ))}
      {hasMore && <span className={styles.chipMore}>+{keys.length - PREVIEW_KEYS} more</span>}
    </span>
  );
}

export default function SAAuditPage() {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<SuperAdminAuditEntry | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo(() => ({
    q: debouncedQ || undefined,
    action: actionFilter || undefined,
    resource_id: resourceId.trim() || undefined,
    from: fromDate ? localDayStartIso(fromDate) ?? undefined : undefined,
    to: toDate ? localDayEndIso(toDate) ?? undefined : undefined,
  }), [debouncedQ, actionFilter, resourceId, fromDate, toDate]);
  const { entries, total, actions, loading, error, reload } = useSuperAdminAudit(PAGE_SIZE, offset, filters);

  const actionOptions = useMemo(() => {
    return actions
      .map((value) => ({ value, label: formatAction(value) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [actions]);

  const isFiltering = Boolean(filters.q || filters.action || filters.resource_id || filters.from || filters.to);

  const columns: Column<SuperAdminAuditEntry>[] = [
    {
      key: 'created_at',
      label: 'When',
      render: (e) => (
        <span className={styles.dateCell}>
          {new Date(e.created_at).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </span>
      ),
    },
    {
      key: 'admin_email',
      label: 'Actor',
      render: (e) => <span className={styles.actor}>{e.admin_email}</span>,
    },
    {
      key: 'action',
      label: 'Action',
      render: (e) => <span className={styles.actionBadge}>{formatAction(e.action)}</span>,
    },
    {
      key: 'resource',
      label: 'Resource',
      render: (e) => (
        <span className={styles.resourceCell}>
          <span className={styles.resourceBadge}>{formatResourceType(e.resource_type)}</span>
          {e.resource_id && (
            <span className={styles.mono} title={e.resource_id}>
              {e.resource_id.slice(0, 8)}…
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'details',
      label: 'Details',
      render: (e) => <DetailsCell details={e.details} />,
    },
  ];

  if (error) return <ErrorAlert message={error} onRetry={reload} />;

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Administrative actions performed across the platform"
        badge={total}
      />

      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <Search size={15} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search email, action, or id."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
            aria-label="Search audit entries"
          />
        </div>
        <select
          className={styles.actionSelect}
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setOffset(0); }}
          aria-label="Filter by action type"
        >
          <option value="">All actions</option>
          {actionOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          className={styles.resourceInput}
          value={resourceId}
          onChange={(e) => { setResourceId(e.target.value); setOffset(0); }}
          placeholder="Resource id"
          aria-label="Resource id"
        />
        <input
          type="date"
          className={styles.dateInput}
          value={fromDate}
          onChange={(e) => {
            const nextFrom = e.target.value;
            setFromDate(nextFrom);
            if (nextFrom && toDate && toDate < nextFrom) setToDate('');
            setOffset(0);
          }}
          aria-label="From date"
        />
        <input
          type="date"
          className={styles.dateInput}
          value={toDate}
          min={fromDate || undefined}
          onChange={(e) => { setToDate(e.target.value); setOffset(0); }}
          aria-label="To date"
        />
      </div>

      {!loading && entries.length === 0 ? (
        isFiltering ? (
          <EmptyState
            icon={<Search size={28} />}
            title="No matching entries"
            description="No audit entries match your filters. Try clearing the search, action, or dates."
          />
        ) : (
          <EmptyState title="No audit entries yet" description="Administrative actions will appear here as they happen." />
        )
      ) : (
        <DataTable<SuperAdminAuditEntry>
          columns={columns}
          data={entries}
          loading={loading}
          keyExtractor={(e) => e.id}
          onRowClick={(e) =>
            Object.keys(e.details).length > 0 ? setSelected(e) : undefined
          }
        />
      )}

      {total > PAGE_SIZE && (
        <Pagination total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
      )}

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Audit entry details"
        subtitle={selected ? `${formatAction(selected.action)} · ${selected.admin_email}` : undefined}
      >
        {selected && (
          <pre className={styles.json}>{JSON.stringify(selected.details, null, 2)}</pre>
        )}
      </Modal>
    </div>
  );
}
