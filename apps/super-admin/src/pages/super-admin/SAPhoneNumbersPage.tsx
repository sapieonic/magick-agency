import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { Phone, Plus, Trash2, Pencil, Search, RotateCcw } from 'lucide-react';
import {
  listPhoneNumbers,
  listTelephonyProviders,
  getPhoneNumberDetail,
  retirePhoneNumber,
  reactivatePhoneNumber,
  deletePhoneNumber,
} from '../../api/super-admin';
import type { TelephonyProvider } from '../../api/super-admin';
import type { PhoneNumber } from '@magick-agency/contracts/api/platform/super-admin';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { StatusBadge } from '@magick-agency/web-ui/components/StatusBadge';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { StatCard } from '../../components/common';
import { saStatusColor, saStatusLabel } from '../../utils/saStatus';
import { telephonyProviderAlias } from '@magick-agency/web-ui/telephonyProviders';
import { PhoneNumberCreateModal } from './phone-numbers/PhoneNumberCreateModal';
import { PhoneNumberEditModal } from './phone-numbers/PhoneNumberEditModal';
import { usePhoneNumberBulk } from './phone-numbers/usePhoneNumberBulk';
import styles from './SAPhoneNumbersPage.module.css';

interface PhoneNumberAssignment {
  tenant_id: string;
  tenant_name: string;
  is_default: boolean;
  assigned_at: string;
}

/** The one single-row destructive confirmation that can be open at a time. */
type RowConfirm = { kind: 'retire' | 'reactivate' | 'delete'; phone: PhoneNumber };

const ROW_CONFIRM_COPY: Record<RowConfirm['kind'], { title: string; message: string; confirmLabel: string; danger: boolean }> = {
  retire: {
    title: 'Retire phone number',
    message: 'Retire this phone number? It can be reactivated later if needed.',
    confirmLabel: 'Retire',
    danger: true,
  },
  reactivate: {
    title: 'Reactivate phone number',
    message: 'Reactivate this phone number? It will become available for assignment again.',
    confirmLabel: 'Reactivate',
    danger: false,
  },
  delete: {
    title: 'Delete permanently',
    message: 'Permanently delete this phone number? This action is irreversible and the number cannot be reactivated.',
    confirmLabel: 'Delete',
    danger: true,
  },
};

export default function SAPhoneNumbersPage() {
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  // The inventory read leaves deleted numbers out, so the Deleted filter
  // reads them by status on its own (refetched each time it is picked).
  const [deletedNumbers, setDeletedNumbers] = useState<PhoneNumber[]>([]);
  const [providers, setProviders] = useState<TelephonyProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Filters
  const [filterProvider, setFilterProvider] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');

  // Create / edit modals
  const [showCreate, setShowCreate] = useState(false);
  const [editPhone, setEditPhone] = useState<PhoneNumber | null>(null);

  // Detail expansion
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [assignments, setAssignments] = useState<PhoneNumberAssignment[]>([]);

  // Retire blocked modal
  const [retireBlockedPhone, setRetireBlockedPhone] = useState<PhoneNumber | null>(null);

  // Single-row destructive confirm (retire / reactivate / delete)
  const [rowConfirm, setRowConfirm] = useState<RowConfirm | null>(null);

  // Provider / status filters, then the phone/label search.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = filterStatus === 'deleted' ? deletedNumbers : phoneNumbers;
    return rows.filter(
      pn =>
        (!filterProvider || pn.provider_id === filterProvider)
        && (!filterStatus || pn.status === filterStatus)
        && (!q
          || pn.phone_number.toLowerCase().includes(q)
          || (pn.label ?? '').toLowerCase().includes(q)),
    );
  }, [phoneNumbers, deletedNumbers, filterProvider, filterStatus, search]);

  // Over the whole inventory, never the filtered rows.
  const stats = useMemo(() => {
    let active = 0, retired = 0;
    for (const pn of phoneNumbers) {
      if (pn.status === 'active') active++;
      if (pn.status === 'retired') retired++;
    }
    return { active, retired };
  }, [phoneNumbers]);

  const bulk = usePhoneNumberBulk(filtered, {
    afterRun: async () => {
      setExpandedId(null);
      await load();
    },
    onError: setError,
  });
  const { clearSelection } = bulk;

  // The whole inventory, unfiltered: the provider and status filters narrow it
  // client-side, so a filter change costs no request and the stat cards can
  // count the whole inventory (there is no pagination; the route returns it all).
  // The route leaves deleted numbers out; the Deleted filter reads those itself.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nums = await listPhoneNumbers();
      setPhoneNumbers(nums);
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load phone numbers');
    } finally {
      setLoading(false);
    }
  }, [clearSelection]);

  // The provider catalog is static for the page's life: fetched once.
  const loadCatalog = useCallback(async () => {
    setCatalogError(null);
    try {
      setProviders(await listTelephonyProviders());
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Failed to load telephony providers');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  useEffect(() => {
    if (filterStatus !== 'deleted') return;
    let cancelled = false;
    setDeletedNumbers([]);
    listPhoneNumbers({ status: 'deleted' })
      .then(rows => { if (!cancelled) setDeletedNumbers(rows); })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load deleted phone numbers');
      });
    return () => { cancelled = true; };
  }, [filterStatus]);

  // A filter change starts a fresh selection, as the refetch it replaced did.
  useEffect(() => { clearSelection(); }, [filterProvider, filterStatus, clearSelection]);

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    setDetailLoading(true);
    setAssignments([]);
    try {
      const detail = await getPhoneNumberDetail(id);
      setAssignments(detail.assignments);
    } catch {
      setAssignments([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const requestRetire = (pn: PhoneNumber) => {
    // Block when the loaded detail shows live assignments.
    if (expandedId === pn.id && assignments.length > 0) {
      setRetireBlockedPhone(pn);
      return;
    }
    setRowConfirm({ kind: 'retire', phone: pn });
  };

  const handleRetire = async (id: string) => {
    try {
      await retirePhoneNumber(id);
      setExpandedId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retire phone number');
    }
  };

  const handleReactivate = async (id: string) => {
    try {
      await reactivatePhoneNumber(id);
      setExpandedId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reactivate phone number');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePhoneNumber(id);
      setExpandedId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete phone number');
    }
  };

  if (loading && phoneNumbers.length === 0) return <LoadingSpinner size="lg" />;
  if (error && phoneNumbers.length === 0) return <ErrorAlert message={error} onRetry={load} />;

  return (
    <div>
      <PageHeader
        title="Phone Numbers"
        subtitle="Number inventory — provider, capabilities, concurrency and tenant assignments"
        badge={phoneNumbers.length}
        actions={
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Add number
          </button>
        }
      />

      {error && <ErrorAlert message={error} onRetry={load} />}
      {catalogError && <ErrorAlert message={catalogError} onRetry={loadCatalog} />}

      <div className={styles.statsGrid}>
        <StatCard title="Active" value={stats.active} color="var(--success)" />
        <StatCard title="Retired" value={stats.retired} color="var(--warning)" />
      </div>

      <div className={styles.filterBar}>
        <div className={styles.searchBox}>
          <Search size={15} className={styles.searchIcon} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search number or label…"
            aria-label="Search phone numbers"
          />
        </div>
        <select
          value={filterProvider}
          onChange={e => setFilterProvider(e.target.value)}
          aria-label="Filter by provider"
        >
          <option value="">All providers</option>
          {providers.map(p => (
            <option key={p.id} value={p.id}>{telephonyProviderAlias(p.name, p.display_name)}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="retired">Retired</option>
          <option value="deleted">Deleted</option>
        </select>

        {bulk.selectedRows.length > 0 && (
          <div className={styles.bulkBar}>
            <span className={styles.bulkCount}>{bulk.selectedRows.length} selected</span>
            <button
              type="button"
              className="btn-secondary"
              disabled={bulk.retireEligible.length === 0 || bulk.bulkRunning}
              onClick={() => bulk.setBulkAction('retire')}
              title={bulk.retireEligible.length === 0 ? 'No selected rows are eligible to retire (active, no assignments)' : undefined}
            >
              <Trash2 size={14} /> Retire ({bulk.retireEligible.length})
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={bulk.reactivateEligible.length === 0 || bulk.bulkRunning}
              onClick={() => bulk.setBulkAction('reactivate')}
              title={bulk.reactivateEligible.length === 0 ? 'No selected rows are retired' : undefined}
            >
              <RotateCcw size={14} /> Reactivate ({bulk.reactivateEligible.length})
            </button>
          </div>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.checkCol}>
                <input
                  type="checkbox"
                  checked={bulk.allVisibleSelected}
                  onChange={bulk.toggleSelectAll}
                  aria-label="Select all"
                />
              </th>
              <th>Phone number</th>
              <th>Provider</th>
              <th>Capabilities</th>
              <th>Label</th>
              <th>Region</th>
              <th>Concurrency</th>
              <th>Status</th>
              <th>Tenants</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(pn => (
              <Fragment key={pn.id}>
                <tr
                  className={styles.clickableRow}
                  onClick={() => handleExpand(pn.id)}
                >
                  <td className={styles.checkCol} onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={bulk.selected.has(pn.id)}
                      onChange={() => bulk.toggleSelect(pn.id)}
                      aria-label={`Select ${pn.phone_number}`}
                    />
                  </td>
                  <td>
                    <div className={styles.phoneCell}>
                      <Phone size={14} className={styles.phoneIcon} />
                      <span className={styles.mono}>{pn.phone_number}</span>
                    </div>
                  </td>
                  <td>
                    <span className={styles.providerBadge}>
                      {telephonyProviderAlias(pn.provider_name, pn.provider_display_name)}
                    </span>
                  </td>
                  <td>
                    {pn.capabilities.map(c => (
                      <span key={c} className={styles.capBadge}>{c}</span>
                    ))}
                  </td>
                  <td className={styles.labelText}>{pn.label || '--'}</td>
                  <td className={styles.regionText}>{pn.region || '--'}</td>
                  <td>{pn.max_concurrent_calls}</td>
                  <td>
                    <StatusBadge
                      label={saStatusLabel(pn.status)}
                      color={saStatusColor(pn.status)}
                      status={pn.status}
                    />
                  </td>
                  <td>
                    <span className={styles.countBadge}>
                      {pn.assignment_count ?? 0}
                    </span>
                  </td>
                </tr>
                {expandedId === pn.id && (
                  <tr>
                    <td colSpan={10} className={styles.detailCell}>
                      <div className={styles.detailGrid}>
                        <div className={styles.detailItem}>
                          <dt>ID</dt>
                          <dd className={styles.mono}>{pn.id}</dd>
                        </div>
                        <div className={styles.detailItem}>
                          <dt>Notes</dt>
                          <dd>{pn.notes || 'None'}</dd>
                        </div>
                        <div className={styles.detailItem}>
                          <dt>Created</dt>
                          <dd>{new Date(pn.created_at).toLocaleString('en-IN')}</dd>
                        </div>
                      </div>

                      <div className={styles.assignmentsSection}>
                        <h4>Assigned tenants</h4>
                        {detailLoading ? (
                          <LoadingSpinner size="sm" />
                        ) : assignments.length === 0 ? (
                          <p className={styles.noAssignments}>No tenants assigned.</p>
                        ) : (
                          assignments.map(a => (
                            <div key={a.tenant_id} className={styles.assignmentRow}>
                              <div className={styles.assignmentInfo}>
                                <span className={styles.assignmentName}>{a.tenant_name}</span>
                                {a.is_default && <span className={styles.defaultBadge}>Default</span>}
                              </div>
                              <span className={styles.mono}>{a.tenant_id}</span>
                            </div>
                          ))
                        )}
                      </div>

                      <div className={styles.detailActions}>
                        {pn.status !== 'deleted' && (
                          <button
                            className="btn-secondary"
                            onClick={e => { e.stopPropagation(); setEditPhone(pn); }}
                          >
                            <Pencil size={14} /> Edit
                          </button>
                        )}
                        {pn.status === 'active' && (
                          <button
                            className={`btn-secondary ${styles.dangerBtn}`}
                            onClick={e => { e.stopPropagation(); requestRetire(pn); }}
                          >
                            <Trash2 size={14} /> Retire
                          </button>
                        )}
                        {pn.status === 'retired' && (
                          <>
                            <button
                              className={`btn-secondary ${styles.successBtn}`}
                              onClick={e => { e.stopPropagation(); setRowConfirm({ kind: 'reactivate', phone: pn }); }}
                            >
                              <RotateCcw size={14} /> Reactivate
                            </button>
                            <button
                              className={`btn-secondary ${styles.dangerBtn}`}
                              onClick={e => { e.stopPropagation(); setRowConfirm({ kind: 'delete', phone: pn }); }}
                            >
                              <Trash2 size={14} /> Delete permanently
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10}>
                  <EmptyState
                    title="No phone numbers"
                    description={
                      search || filterProvider || filterStatus
                        ? 'No numbers match the current filters.'
                        : 'Add a number to get started.'
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <PhoneNumberCreateModal
        open={showCreate}
        providers={providers}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); load(); }}
      />

      <PhoneNumberEditModal
        key={editPhone?.id ?? 'closed'}
        phone={editPhone}
        onClose={() => setEditPhone(null)}
        onSaved={() => { setEditPhone(null); load(); }}
      />

      {/* Retire blocked modal */}
      <Modal
        open={!!retireBlockedPhone}
        onClose={() => setRetireBlockedPhone(null)}
        title="Cannot retire phone number"
        footer={
          <button type="button" className="btn-secondary" onClick={() => setRetireBlockedPhone(null)}>
            Close
          </button>
        }
      >
        {retireBlockedPhone && (
          <>
            <p className={styles.retireBlockedDesc}>
              <strong>{retireBlockedPhone.phone_number}</strong> is currently assigned to{' '}
              {assignments.length} tenant{assignments.length !== 1 ? 's' : ''}.
              You must unassign all tenants before retiring this number.
            </p>
            <div className={styles.retireBlockedList}>
              {assignments.map(a => (
                <div key={a.tenant_id} className={styles.assignmentRow}>
                  <div className={styles.assignmentInfo}>
                    <span className={styles.assignmentName}>{a.tenant_name}</span>
                    {a.is_default && <span className={styles.defaultBadge}>Default</span>}
                  </div>
                  <span className={styles.mono}>{a.tenant_id}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      {/* Single-row destructive confirm */}
      <ConfirmDialog
        open={!!rowConfirm}
        title={rowConfirm ? ROW_CONFIRM_COPY[rowConfirm.kind].title : ''}
        message={rowConfirm ? ROW_CONFIRM_COPY[rowConfirm.kind].message : ''}
        confirmLabel={rowConfirm ? ROW_CONFIRM_COPY[rowConfirm.kind].confirmLabel : ''}
        danger={rowConfirm ? ROW_CONFIRM_COPY[rowConfirm.kind].danger : false}
        onCancel={() => setRowConfirm(null)}
        onConfirm={() => {
          const confirm = rowConfirm;
          setRowConfirm(null);
          if (!confirm) return;
          if (confirm.kind === 'retire') handleRetire(confirm.phone.id);
          else if (confirm.kind === 'reactivate') handleReactivate(confirm.phone.id);
          else handleDelete(confirm.phone.id);
        }}
      />

      {/* Bulk lifecycle confirm */}
      <ConfirmDialog
        open={!!bulk.bulkAction}
        title={bulk.bulkAction === 'reactivate' ? 'Reactivate selected numbers' : 'Retire selected numbers'}
        message={
          bulk.bulkAction === 'reactivate'
            ? `Reactivate ${bulk.reactivateEligible.length} retired number${bulk.reactivateEligible.length !== 1 ? 's' : ''}?`
              + (bulk.selectedRows.length - bulk.reactivateEligible.length > 0
                ? ` ${bulk.selectedRows.length - bulk.reactivateEligible.length} selected number(s) are not retired and will be skipped.`
                : '')
              + ' They will become available for assignment again.'
            : `Retire ${bulk.retireEligible.length} active, unassigned number${bulk.retireEligible.length !== 1 ? 's' : ''}?`
              + (bulk.selectedRows.length - bulk.retireEligible.length > 0
                ? ` ${bulk.selectedRows.length - bulk.retireEligible.length} selected number(s) are not eligible (assigned or not active) and will be skipped.`
                : '')
              + ' They can be reactivated later if needed.'
        }
        confirmLabel={bulk.bulkRunning ? 'Working…' : bulk.bulkAction === 'reactivate' ? 'Reactivate' : 'Retire'}
        danger={bulk.bulkAction === 'retire'}
        onCancel={() => { if (!bulk.bulkRunning) bulk.setBulkAction(null); }}
        onConfirm={bulk.runBulk}
      />
    </div>
  );
}
