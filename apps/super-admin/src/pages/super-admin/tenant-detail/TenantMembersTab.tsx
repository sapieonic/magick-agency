import { useState } from 'react';
import { Plus, UserPlus, UserCog, UserMinus } from 'lucide-react';
import { addUserToTenant, changeMembershipRole, revokeMembership } from '../../../api/super-admin';
import type { SuperAdminTenantMember } from '@magick-agency/contracts/api/platform/super-admin';
import type { Role } from '@magick-agency/contracts/rbac';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { StatusBadge } from '@magick-agency/web-ui/components/StatusBadge';
import { DataTable } from '@magick-agency/web-ui/components/DataTable';
import type { Column } from '@magick-agency/web-ui/components/DataTable';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { saStatusColor, saStatusLabel, roleLabel } from '../../../utils/saStatus';
import { inviteEmailNotice } from '../../../utils/inviteEmailNotice';
import styles from '../SATenantDetailPage.module.css';

/**
 * Plan lets a super-admin grant any of the six roles, including `agent`
 * (the Agency Dialer's agent members).
 */
const ROLES: readonly Role[] = ['tenant_owner', 'tenant_admin', 'account_admin', 'operator', 'viewer', 'agent'];

/**
 * The Members tab: the member table, adding a user (to the whole tenant or one
 * account), changing a membership's role and revoking it. A change refetches
 * the tenant silently; a failed refetch is `refreshError`, shown beside the note.
 */
export function TenantMembersTab({ tenantId, tenantName, members, accounts, refreshError, reload }: {
  tenantId: string;
  tenantName: string;
  members: SuperAdminTenantMember[];
  accounts: Array<{ id: string; name: string }>;
  refreshError: string | null;
  reload: (options?: { silent?: boolean }) => Promise<void>;
}) {
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
  /*
    Its own slot rather than a tone on `memberNote`: "added, but not emailed" is
    neither a success nor a failure of the add, and it has to stay visible after
    the modal closes, because nothing else tells the super admin.
  */
  const [memberWarning, setMemberWarning] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  const resetAddUser = () => setUserForm({ email: '', role: 'operator', name: '', account_id: '' });

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddingUser(true);
    setAddUserError(null);
    try {
      const res = await addUserToTenant(tenantId, {
        email: userForm.email,
        role: userForm.role as Role,
        name: userForm.name || undefined,
        ...(userForm.account_id ? { account_id: userForm.account_id } : {}),
      });
      // Whether the invitee was emailed; see `inviteEmailNotice` for the three answers.
      const notice = inviteEmailNotice(
        `Added ${userForm.email} as ${roleLabel(userForm.role)}`,
        userForm.email,
        res.invite_email,
      );
      setMemberError(null);
      setMemberNote(notice.tone === 'success' ? notice.message : null);
      setMemberWarning(notice.tone === 'warning' ? notice.message : null);
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
    if (!tenantId || !roleTarget) return;
    const target = roleTarget;
    setChangingRole(true);
    setRoleError(null);
    try {
      await changeMembershipRole(tenantId, target.id, {
        role: roleForm.role as Role,
        ...(roleForm.reason.trim() ? { reason: roleForm.reason.trim() } : {}),
      });
      setRoleTarget(null);
      setMemberError(null);
      setMemberWarning(null);
      setMemberNote(`${target.email} is now ${roleLabel(roleForm.role)}.`);
      await reload({ silent: true });
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : 'Failed to change role');
    } finally {
      setChangingRole(false);
    }
  };

  const handleRevoke = async () => {
    if (!tenantId || !revokeTarget) return;
    const target = revokeTarget;
    setRevoking(true);
    setMemberError(null);
    try {
      const res = await revokeMembership(tenantId, target.id);
      setRevokeTarget(null);
      setMemberWarning(null);
      setMemberNote(
        `Revoked ${target.email}. ${res.staffing_closed} campaign assignment${res.staffing_closed === 1 ? '' : 's'} closed.`,
      );
      await reload({ silent: true });
    } catch (err) {
      setRevokeTarget(null);
      setMemberNote(null);
      setMemberWarning(null);
      setMemberError(err instanceof Error ? err.message : 'Failed to revoke membership');
    } finally {
      setRevoking(false);
    }
  };

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
    <>
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2><UserPlus size={18} /> Members ({members.length})</h2>
          <button className="btn-primary" onClick={() => setShowAddUser(true)}>
            <Plus size={14} /> Add user
          </button>
        </div>
        {memberNote && <div className={styles.success} role="status">{memberNote}</div>}
        {memberWarning && <div className={styles.warningBox} role="alert">{memberWarning}</div>}
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
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {addUserError && <div className={styles.error}><ErrorText message={addUserError} /></div>}
        </form>
      </Modal>

      {/* Change role Modal */}
      <Modal
        open={!!roleTarget}
        onClose={() => setRoleTarget(null)}
        title="Change role"
        subtitle={roleTarget ? `Change the role of ${roleTarget.email} in ${tenantName}.` : undefined}
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
          ? `Revoke ${revokeTarget.email}'s access to ${tenantName}? Their campaign assignments are closed too.`
          : ''}
        confirmLabel={revoking ? 'Revoking...' : 'Revoke'}
        danger
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </>
  );
}
