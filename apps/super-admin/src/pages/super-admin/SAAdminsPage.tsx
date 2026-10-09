import { useState, useMemo } from 'react';
import { ShieldCheck, Plus, Trash2, Lock, Search, RotateCcw, KeyRound, Eye, EyeOff } from 'lucide-react';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useSuperAdminAdmins } from '../../hooks/useSuperAdminAdmins';
import { createAdmin, removeAdmin, reactivateAdmin, resetAdminPassword } from '../../api/super-admin';
import type { SuperAdmin } from '@magick-agency/contracts/api/platform/super-admin';
import { useToast } from '../../contexts/ToastContext';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  ErrorAlert,
  Modal,
  ConfirmDialog,
} from '../../components/common';
import type { Column } from '../../components/common/DataTable';
import { ErrorText } from '../../components/common/ErrorText';
import { saStatusColor, saStatusLabel } from '../../utils/saStatus';
import styles from './SAAdminsPage.module.css';

export default function SAAdminsPage() {
  const { admin: currentAdmin } = useSuperAdmin();
  const { admins, loading, error, reload } = useSuperAdminAdmins();
  const { showToast, showErrorToast } = useToast();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmReactivateId, setConfirmReactivateId] = useState<string | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [resetTarget, setResetTarget] = useState<SuperAdmin | null>(null);
  const [resetForm, setResetForm] = useState({ admin_password: '', new_password: '', confirm: '' });
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [showResetPw, setShowResetPw] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await createAdmin(form);
      setShowCreate(false);
      setForm({ email: '', password: '', name: '' });
      reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create admin');
    } finally {
      setCreating(false);
    }
  };

  const handleRemove = async () => {
    if (!confirmRemoveId) return;
    setRemoving(true);
    try {
      await removeAdmin(confirmRemoveId);
      setConfirmRemoveId(null);
      showToast('Admin removed', 'success');
      reload();
    } catch (err) {
      showErrorToast(err, 'Failed to remove admin');
    } finally {
      setRemoving(false);
    }
  };

  const handleReactivate = async () => {
    if (!confirmReactivateId) return;
    setReactivating(true);
    try {
      await reactivateAdmin(confirmReactivateId);
      const name = adminToReactivate?.name;
      setConfirmReactivateId(null);
      showToast(name ? `${name} reactivated` : 'Admin reactivated', 'success');
      reload();
    } catch (err) {
      showErrorToast(err, 'Failed to reactivate admin');
    } finally {
      setReactivating(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    if (resetForm.new_password !== resetForm.confirm) {
      setResetError('New passwords do not match');
      return;
    }
    setResetting(true);
    setResetError(null);
    try {
      await resetAdminPassword(resetTarget.id, {
        admin_password: resetForm.admin_password,
        new_password: resetForm.new_password,
      });
      const email = resetTarget.email;
      setResetTarget(null);
      showToast(`Password reset for ${email}`, 'success');
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setResetting(false);
    }
  };

  const adminToRemove = confirmRemoveId ? admins.find(a => a.id === confirmRemoveId) : null;
  const adminToReactivate = confirmReactivateId ? admins.find(a => a.id === confirmReactivateId) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return admins;
    return admins.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.email.toLowerCase().includes(q),
    );
  }, [admins, search]);

  const columns: Column<SuperAdmin>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (a) => {
        const isSelf = a.id === currentAdmin?.id;
        return (
          <div className={styles.nameCell}>
            <ShieldCheck size={16} className={styles.adminIcon} />
            {a.name}
            {a.is_system && (
              <span title="System admin">
                <Lock size={12} className={styles.systemIcon} />
              </span>
            )}
            {isSelf && <span className={styles.youBadge}>you</span>}
          </div>
        );
      },
    },
    { key: 'email', label: 'Email' },
    {
      key: 'status',
      label: 'Status',
      render: (a) => <StatusBadge label={saStatusLabel(a.status)} color={saStatusColor(a.status)} status={a.status} />,
    },
    {
      key: 'created_at',
      label: 'Created',
      render: (a) => (
        <span className={styles.dateCell}>{new Date(a.created_at).toLocaleDateString('en-IN')}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      render: (a) => {
        const isSelf = a.id === currentAdmin?.id;
        if (a.is_system || isSelf) return null;
        return (
          <div className={styles.rowActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => {
                setResetTarget(a);
                setResetForm({ admin_password: '', new_password: '', confirm: '' });
                setResetError(null);
                setShowResetPw(false);
              }}
              title="Reset password"
              aria-label={`Reset password for ${a.name}`}
            >
              <KeyRound size={14} />
            </button>
            {a.status === 'inactive' ? (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setConfirmReactivateId(a.id)}
                title="Reactivate admin"
                aria-label={`Reactivate ${a.name}`}
              >
                <RotateCcw size={14} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => setConfirmRemoveId(a.id)}
                title="Remove admin"
                aria-label={`Remove ${a.name}`}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Admins"
        subtitle="Super admins with platform-wide access"
        badge={admins.length}
        actions={
          <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Add admin
          </button>
        }
      />

      {error && <ErrorAlert message={error} onRetry={reload} />}

      <div className={styles.searchBar}>
        <Search size={16} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or email…"
          aria-label="Search admins"
        />
      </div>

      <DataTable<SuperAdmin>
        columns={columns}
        data={filtered}
        loading={loading}
        keyExtractor={(a) => a.id}
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create super admin"
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
            <button type="submit" form="create-admin-form" className="btn-primary" disabled={creating}>
              {creating ? 'Creating…' : 'Create admin'}
            </button>
          </>
        }
      >
        <form id="create-admin-form" onSubmit={handleCreate} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="admin-name">Name</label>
            <input
              id="admin-name"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Admin Name"
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="admin-email">Email</label>
            <input
              id="admin-email"
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="admin@example.com"
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Min 8 characters"
              minLength={8}
              required
            />
          </div>
          {createError && <ErrorText message={createError} />}
        </form>
      </Modal>

      <ConfirmDialog
        open={!!confirmRemoveId && !!adminToRemove}
        title="Remove admin"
        message={
          adminToRemove
            ? `Remove ${adminToRemove.name} (${adminToRemove.email})? They will no longer be able to log in.`
            : ''
        }
        confirmLabel={removing ? 'Removing…' : 'Remove admin'}
        danger
        disabled={removing}
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemoveId(null)}
      />

      <ConfirmDialog
        open={!!confirmReactivateId && !!adminToReactivate}
        title="Reactivate admin"
        message={
          adminToReactivate
            ? `Reactivate ${adminToReactivate.name} (${adminToReactivate.email})? They will be able to log in again.`
            : ''
        }
        confirmLabel={reactivating ? 'Reactivating…' : 'Reactivate admin'}
        disabled={reactivating}
        onConfirm={handleReactivate}
        onCancel={() => setConfirmReactivateId(null)}
      />

      <Modal
        open={!!resetTarget}
        onClose={() => setResetTarget(null)}
        title={resetTarget ? `Reset password — ${resetTarget.name}` : 'Reset password'}
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setResetTarget(null)}>
              Cancel
            </button>
            <button type="submit" form="reset-password-form" className="btn-primary" disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset password'}
            </button>
          </>
        }
      >
        <form id="reset-password-form" onSubmit={handleResetPassword} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="reset-admin-password">Your password</label>
            <input
              id="reset-admin-password"
              type="password"
              value={resetForm.admin_password}
              onChange={e => setResetForm(f => ({ ...f, admin_password: e.target.value }))}
              placeholder="Confirm it's you"
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="reset-new-password">New password</label>
            <input
              id="reset-new-password"
              type={showResetPw ? 'text' : 'password'}
              value={resetForm.new_password}
              onChange={e => setResetForm(f => ({ ...f, new_password: e.target.value }))}
              placeholder="Min 8 characters"
              minLength={8}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="reset-confirm-password">Confirm new password</label>
            <input
              id="reset-confirm-password"
              type={showResetPw ? 'text' : 'password'}
              value={resetForm.confirm}
              onChange={e => setResetForm(f => ({ ...f, confirm: e.target.value }))}
              placeholder="Re-enter new password"
              minLength={8}
              required
            />
          </div>
          <button
            type="button"
            className={styles.pwToggle}
            onClick={() => setShowResetPw(v => !v)}
            aria-label={showResetPw ? 'Hide passwords' : 'Show passwords'}
          >
            {showResetPw ? <EyeOff size={14} /> : <Eye size={14} />}
            {showResetPw ? 'Hide passwords' : 'Show passwords'}
          </button>
          {resetError && <ErrorText message={resetError} />}
        </form>
      </Modal>
    </div>
  );
}
