import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { Phone, Plus, Trash2, Pencil, Search, RotateCcw } from 'lucide-react';
import {
  listPhoneNumbers,
  listTelephonyProviders,
  createPhoneNumber,
  getPhoneNumberDetail,
  updatePhoneNumber,
  retirePhoneNumber,
  reactivatePhoneNumber,
  deletePhoneNumber,
} from '../../api/super-admin';
import type { TelephonyProvider } from '../../api/super-admin';
import type { PhoneNumber } from '@magick-agency/contracts/api/platform/super-admin';
import {
  LoadingSpinner,
  ErrorAlert,
  PageHeader,
  HelpTooltip,
  StatCard,
  StatusBadge,
  Modal,
  ConfirmDialog,
  AdvancedSection,
  EmptyState,
} from '../../components/common';
import { ErrorText } from '../../components/common/ErrorText';
import { saStatusColor, saStatusLabel } from '../../utils/saStatus';
import { telephonyProviderAlias } from '../../config/telephonyProviders';
import styles from './SAPhoneNumbersPage.module.css';

interface PhoneNumberAssignment {
  tenant_id: string;
  tenant_name: string;
  is_default: boolean;
  assigned_at: string;
}

const CAPABILITY_OPTIONS = ['voice', 'sms'] as const;

type BulkAction = 'retire' | 'reactivate';

export default function SAPhoneNumbersPage() {
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [providers, setProviders] = useState<TelephonyProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterProvider, setFilterProvider] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    phone_number: '',
    provider_id: '',
    label: '',
    region: '',
    max_concurrent_calls: 1,
    capabilities: ['voice'] as string[],
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Detail expansion
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [assignments, setAssignments] = useState<PhoneNumberAssignment[]>([]);

  // Retire blocked modal
  const [retireBlockedPhone, setRetireBlockedPhone] = useState<PhoneNumber | null>(null);

  // Edit modal
  const [editPhone, setEditPhone] = useState<PhoneNumber | null>(null);
  const [editForm, setEditForm] = useState({ label: '', notes: '', max_concurrent_calls: 1 });
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Single-row destructive confirms
  const [retireConfirm, setRetireConfirm] = useState<PhoneNumber | null>(null);
  const [reactivateConfirm, setReactivateConfirm] = useState<PhoneNumber | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<PhoneNumber | null>(null);

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nums, provs] = await Promise.all([
        listPhoneNumbers({
          provider_id: filterProvider || undefined,
          status: filterStatus || undefined,
        }),
        listTelephonyProviders(),
      ]);
      setPhoneNumbers(nums);
      setProviders(provs);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load phone numbers');
    } finally {
      setLoading(false);
    }
  }, [filterProvider, filterStatus]);

  useEffect(() => { load(); }, [load]);

  // Client-side phone/label search over the loaded numbers.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return phoneNumbers;
    return phoneNumbers.filter(
      pn =>
        pn.phone_number.toLowerCase().includes(q) ||
        (pn.label ?? '').toLowerCase().includes(q),
    );
  }, [phoneNumbers, search]);

  const stats = useMemo(() => {
    let active = 0, retired = 0;
    for (const pn of phoneNumbers) {
      if (pn.status === 'active') active++;
      if (pn.status === 'retired') retired++;
    }
    return { active, retired };
  }, [phoneNumbers]);

  // Eligible selections for each bulk action, derived from row data.
  const selectedRows = useMemo(
    () => filtered.filter(pn => selected.has(pn.id)),
    [filtered, selected],
  );
  const retireEligible = useMemo(
    () => selectedRows.filter(pn => pn.status === 'active' && (pn.assignment_count ?? 0) === 0),
    [selectedRows],
  );
  const reactivateEligible = useMemo(
    () => selectedRows.filter(pn => pn.status === 'retired'),
    [selectedRows],
  );

  const allVisibleSelected = filtered.length > 0 && filtered.every(pn => selected.has(pn.id));

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected(prev => {
      if (filtered.length > 0 && filtered.every(pn => prev.has(pn.id))) return new Set();
      return new Set(filtered.map(pn => pn.id));
    });
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await createPhoneNumber({
        phone_number: form.phone_number,
        provider_id: form.provider_id,
        label: form.label || undefined,
        region: form.region || undefined,
        max_concurrent_calls: form.max_concurrent_calls,
        capabilities: form.capabilities.length > 0 ? form.capabilities : undefined,
      });
      setShowCreate(false);
      setForm({ phone_number: '', provider_id: '', label: '', region: '', max_concurrent_calls: 1, capabilities: ['voice'] });
      load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to add phone number');
    } finally {
      setCreating(false);
    }
  };

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
    setRetireConfirm(pn);
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

  const openEdit = (pn: PhoneNumber) => {
    setEditPhone(pn);
    setEditError(null);
    setEditForm({
      label: pn.label ?? '',
      notes: pn.notes ?? '',
      max_concurrent_calls: pn.max_concurrent_calls,
    });
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editPhone) return;
    setEditing(true);
    setEditError(null);
    try {
      await updatePhoneNumber(editPhone.id, {
        label: editForm.label || undefined,
        notes: editForm.notes || undefined,
        max_concurrent_calls: editForm.max_concurrent_calls,
      });
      setEditPhone(null);
      load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update phone number');
    } finally {
      setEditing(false);
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

  // Run a bulk lifecycle action sequentially over eligible selected rows
  // using the existing per-item endpoints, then refetch.
  const runBulk = async () => {
    const action = bulkAction;
    if (!action) return;
    const targets = action === 'retire' ? retireEligible : reactivateEligible;
    setBulkRunning(true);
    setError(null);
    // Run all eligible items, tolerating partial failure: allSettled lets us
    // report exactly how many succeeded/failed instead of aborting on the first
    // error and leaving the table out of sync with the server.
    const results = await Promise.allSettled(
      targets.map(pn =>
        action === 'retire' ? retirePhoneNumber(pn.id) : reactivatePhoneNumber(pn.id),
      ),
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    try {
      setExpandedId(null);
      await load(); // always refetch so the table reflects server state
    } finally {
      setBulkRunning(false);
      setBulkAction(null);
    }
    if (failed > 0) {
      const verb = action === 'retire' ? 'retired' : 'reactivated';
      setError(
        `${succeeded} number${succeeded !== 1 ? 's' : ''} ${verb}, ${failed} failed. Please retry the failed number${failed !== 1 ? 's' : ''}.`,
      );
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

        {selectedRows.length > 0 && (
          <div className={styles.bulkBar}>
            <span className={styles.bulkCount}>{selectedRows.length} selected</span>
            <button
              type="button"
              className="btn-secondary"
              disabled={retireEligible.length === 0 || bulkRunning}
              onClick={() => setBulkAction('retire')}
              title={retireEligible.length === 0 ? 'No selected rows are eligible to retire (active, no assignments)' : undefined}
            >
              <Trash2 size={14} /> Retire ({retireEligible.length})
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={reactivateEligible.length === 0 || bulkRunning}
              onClick={() => setBulkAction('reactivate')}
              title={reactivateEligible.length === 0 ? 'No selected rows are retired' : undefined}
            >
              <RotateCcw size={14} /> Reactivate ({reactivateEligible.length})
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
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
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
                      checked={selected.has(pn.id)}
                      onChange={() => toggleSelect(pn.id)}
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
                            onClick={e => { e.stopPropagation(); openEdit(pn); }}
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
                              onClick={e => { e.stopPropagation(); setReactivateConfirm(pn); }}
                            >
                              <RotateCcw size={14} /> Reactivate
                            </button>
                            <button
                              className={`btn-secondary ${styles.dangerBtn}`}
                              onClick={e => { e.stopPropagation(); setDeleteConfirm(pn); }}
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

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add phone number"
        subtitle="Register a number to the inventory"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            <button type="submit" form="create-phone-form" className="btn-primary" disabled={creating}>
              {creating ? 'Adding…' : 'Add number'}
            </button>
          </>
        }
      >
        <form id="create-phone-form" onSubmit={handleCreate} className={styles.form}>
          <div className={styles.field}>
            <label>Phone number</label>
            <input
              value={form.phone_number}
              onChange={e => setForm(f => ({ ...f, phone_number: e.target.value }))}
              placeholder="+919876543210"
              required
            />
          </div>
          <div className={styles.field}>
            <label>Provider</label>
            <select
              value={form.provider_id}
              onChange={e => setForm(f => ({ ...f, provider_id: e.target.value }))}
              required
            >
              <option value="">Select provider…</option>
              {providers.filter(p => p.status === 'active').map(p => (
                <option key={p.id} value={p.id}>{telephonyProviderAlias(p.name, p.display_name)}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label>Label (optional)</label>
            <input
              value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Primary, Collections"
            />
          </div>

          <AdvancedSection label="Advanced settings" summary="Region, capabilities and concurrency">
            <div className={styles.field}>
              <label>Region (optional)</label>
              <input
                value={form.region}
                onChange={e => setForm(f => ({ ...f, region: e.target.value }))}
                placeholder="e.g. IN, US"
              />
            </div>
            <div className={styles.field}>
              <label>
                Per-number routing cap
                <HelpTooltip text="Optional capacity associated with this telephone number. It is not purchased provider concurrency and is not added to the account provider allocation." />
              </label>
              <input
                type="number"
                min={1}
                value={form.max_concurrent_calls}
                onChange={e => setForm(f => ({ ...f, max_concurrent_calls: parseInt(e.target.value) || 1 }))}
                required
              />
            </div>
            <div className={styles.field}>
              <label>Capabilities</label>
              <div className={styles.capCheckboxes}>
                {CAPABILITY_OPTIONS.map(cap => (
                  <label key={cap} className={styles.capCheckbox}>
                    <input
                      type="checkbox"
                      checked={form.capabilities.includes(cap)}
                      onChange={e => {
                        setForm(f => ({
                          ...f,
                          capabilities: e.target.checked
                            ? [...f.capabilities, cap]
                            : f.capabilities.filter(c => c !== cap),
                        }));
                      }}
                    />
                    {cap.toUpperCase()}
                  </label>
                ))}
              </div>
            </div>
          </AdvancedSection>

          {createError && <div className={styles.error}><ErrorText message={createError} /></div>}
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editPhone}
        onClose={() => setEditPhone(null)}
        title={editPhone ? `Edit ${editPhone.phone_number}` : 'Edit'}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setEditPhone(null)}>Cancel</button>
            <button type="submit" form="edit-phone-form" className="btn-primary" disabled={editing}>
              {editing ? 'Saving…' : 'Save changes'}
            </button>
          </>
        }
      >
        <form id="edit-phone-form" onSubmit={handleEdit} className={styles.form}>
          <div className={styles.field}>
            <label>Label</label>
            <input
              value={editForm.label}
              onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Primary, Collections"
              maxLength={255}
            />
          </div>

          <AdvancedSection label="Advanced settings" summary="Notes and concurrency">
            <div className={styles.field}>
              <label>Notes</label>
              <textarea
                value={editForm.notes}
                onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Internal notes about this number"
                rows={3}
              />
            </div>
            <div className={styles.field}>
              <label>
                Per-number routing cap
                <HelpTooltip text="This number-level value is separate from provider procurement and is not summed into the account concurrency allocation." />
              </label>
              <input
                type="number"
                min={1}
                value={editForm.max_concurrent_calls}
                onChange={e => setEditForm(f => ({ ...f, max_concurrent_calls: parseInt(e.target.value) || 1 }))}
                required
              />
            </div>
          </AdvancedSection>

          {editError && <div className={styles.error}><ErrorText message={editError} /></div>}
        </form>
      </Modal>

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

      {/* Single-row destructive confirms */}
      <ConfirmDialog
        open={!!retireConfirm}
        title="Retire phone number"
        message="Retire this phone number? It can be reactivated later if needed."
        confirmLabel="Retire"
        danger
        onCancel={() => setRetireConfirm(null)}
        onConfirm={() => { const pn = retireConfirm; setRetireConfirm(null); if (pn) handleRetire(pn.id); }}
      />
      <ConfirmDialog
        open={!!reactivateConfirm}
        title="Reactivate phone number"
        message="Reactivate this phone number? It will become available for assignment again."
        confirmLabel="Reactivate"
        onCancel={() => setReactivateConfirm(null)}
        onConfirm={() => { const pn = reactivateConfirm; setReactivateConfirm(null); if (pn) handleReactivate(pn.id); }}
      />
      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete permanently"
        message="Permanently delete this phone number? This action is irreversible and the number cannot be reactivated."
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => { const pn = deleteConfirm; setDeleteConfirm(null); if (pn) handleDelete(pn.id); }}
      />

      {/* Bulk lifecycle confirm */}
      <ConfirmDialog
        open={!!bulkAction}
        title={bulkAction === 'reactivate' ? 'Reactivate selected numbers' : 'Retire selected numbers'}
        message={
          bulkAction === 'reactivate'
            ? `Reactivate ${reactivateEligible.length} retired number${reactivateEligible.length !== 1 ? 's' : ''}?`
              + (selectedRows.length - reactivateEligible.length > 0
                ? ` ${selectedRows.length - reactivateEligible.length} selected number(s) are not retired and will be skipped.`
                : '')
              + ' They will become available for assignment again.'
            : `Retire ${retireEligible.length} active, unassigned number${retireEligible.length !== 1 ? 's' : ''}?`
              + (selectedRows.length - retireEligible.length > 0
                ? ` ${selectedRows.length - retireEligible.length} selected number(s) are not eligible (assigned or not active) and will be skipped.`
                : '')
              + ' They can be reactivated later if needed.'
        }
        confirmLabel={bulkRunning ? 'Working…' : bulkAction === 'reactivate' ? 'Reactivate' : 'Retire'}
        danger={bulkAction === 'retire'}
        onCancel={() => { if (!bulkRunning) setBulkAction(null); }}
        onConfirm={runBulk}
      />
    </div>
  );
}
