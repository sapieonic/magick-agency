import { useState, useCallback, useMemo } from 'react';
import { Users, UserPlus } from 'lucide-react';
import { useTeam } from '../../hooks/useTeam';
import { usePermission } from '../../hooks/usePermission';
import { useTenant } from '../../contexts/TenantContext';
import { removeUserMembership } from '../../api/users';
import { formatRelativeTime } from '@magick-agency/web-ui/format';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { PageDescription } from '../../components/common';
import { getRoleLevel } from '../../utils/permissions';
import type { TenantMember } from '../../types/team';
import { getRoleColor, getRoleLabel } from './teamRoles';
import { InviteModal } from './InviteModal';
import { ResendInviteModal } from './ResendInviteModal';
import { MemberActionsMenu, errorMessage, memberName } from './MemberActionsMenu';
import styles from './TeamPage.module.css';

// The invitation rules live in `teamInvites.ts`; re-exported for the tests (and
// any caller) that import them from the page.
export { inviteNotKnownJoined, inviteSignInUrl, invitationIsResendable, isInvitationLink } from './teamInvites';

/* ── Helpers ──────────────────────────────────── */

/**
 * The Invite column's two values, styled the same way
 * `ROLE_COLOR_MAP` styles the Role column beside it — `--warning` for a state
 * that needs attention, `--success` for the settled one. Not `--ember`: ember
 * is reserved for what the platform is doing right now (a live call, a running
 * broadcast), and somebody who has not signed up for days is a static fact
 * about a row, not motion.
 */
const INVITE_BADGE_COLOR: Record<'active' | 'pending', string> = {
  pending: 'var(--warning)',
  active: 'var(--success)',
};

/**
 * Operator-facing copy. The wire enum (`'active' | 'pending'`) must never reach
 * the screen as-is, and `'active'` must not reach it in TRANSLATION either:
 * `Membership.status` is separately `'active' | 'inactive' | 'revoked'`, and
 * super-admin's own tenant-members table already renders a green **Active** for
 * that different fact (`SATenantDetailPage`'s `saStatusLabel`). A supervisor who
 * sees both screens would have had one word standing for two unrelated things.
 * **Joined** is the ticket's own alternative ("Pending vs Signed up (or
 * Joined)") and collides with nothing.
 */
const INVITE_BADGE_LABEL: Record<'active' | 'pending', string> = {
  pending: 'Pending',
  active: 'Joined',
};

/**
 * The Invite cell: has this person signed up for Magick Agency yet.
 *
 * A component rather than repeated `invite_state` reads inline in
 * the table, so the state is resolved ONCE per row and the colour and the label
 * can never be read from two different resolutions of it.
 *
 * ── Accessible by construction, which is why there is no ARIA here ─────────
 * It reuses the `roleBadge` pill beside it unchanged — same class, same
 * `color-mix` background, a different colour/label pair — and the fact that
 * distinguishes the two states is the rendered WORD, not the colour. So it
 * survives grayscale, a colour-blind reader and a screen reader with no added
 * affordance. An `aria-label` here would only restate the visible text, which
 * is the kind of decoration that makes real labels harder to trust.
 */
function InviteStateBadge({ member }: { member: TenantMember }) {
  const state = member.membership.invite_state;

  /**
   * Absent — an older server, or a cached SPA outliving a rollback — renders a
   * neutral placeholder and NO badge.
   *
   * There is deliberately no display default, because every default is a
   * positive claim made on no evidence, and both directions are wrong in a way
   * this column exists to prevent. `'active'` would stamp a green "Joined" on
   * an invitee who may never have signed in — the precise sentence the ticket
   * was raised to stop the page getting wrong. `'pending'` would accuse
   * established members of never having joined. "We were not told" is a third
   * thing, and the cell says it rather than picking a side.
   *
   * Its twin `inviteNotKnownJoined` keeps defaulting, because a PREDICATE has
   * to answer something: see its docstring for why its direction differs.
   */
  if (state === undefined) {
    return <span className={styles.inviteUnknown} aria-label="Unknown">—</span>;
  }

  const color = INVITE_BADGE_COLOR[state];
  return (
    <span
      className={styles.roleBadge}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {INVITE_BADGE_LABEL[state]}
    </span>
  );
}

/* ── Team Page ────────────────────────────────── */

export default function TeamPage() {
  const { tenantId, role } = useTenant();
  const { members, loading, loaded, error, reload } = useTeam();
  const canInvite = usePermission('user.invite');
  const [showInvite, setShowInvite] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<TenantMember | null>(null);
  const [removing, setRemoving] = useState(false);
  /** The member whose invitation is being re-issued. See {@link ResendInviteModal}. */
  const [resendFor, setResendFor] = useState<TenantMember | null>(null);
  /** Why the last role change or removal failed; cleared by the next one that succeeds. */
  const [actionError, setActionError] = useState<string | null>(null);

  const handleRoleChanged = useCallback(() => {
    setActionError(null);
    reload();
  }, [reload]);

  const handleInvited = useCallback(() => {
    setShowInvite(false);
    reload();
  }, [reload]);

  const handleRemove = useCallback(async () => {
    if (!tenantId || !confirmRemove) return;
    setRemoving(true);
    try {
      await removeUserMembership(tenantId, confirmRemove.user.id);
      setConfirmRemove(null);
      setActionError(null);
      reload();
    } catch (err) {
      /* Close the confirmation and say why on the page — the dialog's question
         has been answered, and the member is still on the list beside the error. */
      setConfirmRemove(null);
      setActionError(
        `Could not remove ${memberName(confirmRemove)}: ${errorMessage(err, 'the request failed')}`,
      );
    } finally {
      setRemoving(false);
    }
  }, [tenantId, confirmRemove, reload]);

  // Most access first, by the contract's hierarchy — the one the server enforces —
  // rather than a second ordering kept here. An unknown role reads level 0, last.
  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => getRoleLevel(b.membership.role) - getRoleLevel(a.membership.role)),
    [members],
  );

  if (error) {
    return (
      <div className={styles.page}>
        <PageHeader title="Team" badge={0} />
        <ErrorAlert message={error} onRetry={reload} />
      </div>
    );
  }

  /* Only before the first answer. A reload (after an invite, a role change, a
     removal) keeps the table on screen rather than blanking the page. */
  if (loading && !loaded) {
    return (
      <div className={styles.page}>
        <PageHeader title="Team" />
        <div className={styles.loadingWrap}>
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Team"
        badge={members.length}
        actions={
          canInvite ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowInvite(true)}
            >
              <UserPlus size={14} />
              Invite Member
            </button>
          ) : undefined
        }
      />
      <PageDescription
        pageKey="team"
        description="Manage your team members and their access levels. Invite new users by email, assign roles to control what they can see and do, and remove members when needed."
        tips={[
          'Roles control access: Viewers can only see data, Operators can make calls, Admins can manage the account.',
          'Invited users will receive an email with instructions to join your workspace.',
        ]}
      />

      {actionError && (
        <p className="error-text" role="alert" data-testid="team-action-error">
          <ErrorText message={actionError} />
        </p>
      )}

      {members.length === 0 ? (
        <EmptyState
          icon={<Users size={32} />}
          title="No team members"
          description="Invite your team members to collaborate on this workspace."
          action={
            canInvite ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowInvite(true)}
              >
                <UserPlus size={14} />
                Invite Member
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className={styles.tableCard}>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  {/* "Invite", never "Status": `membership.status` is a
                      different field with different values (`active` /
                      `inactive` / `revoked`), and super-admin's tenant-members
                      table already spends the word on it.

                      Sits beside Role, not beside the "Invited" DATE, so the
                      two headings that share a word-stem are not adjacent —
                      "Invite | Invited" side by side reads as one mistake. It
                      also groups the two facts about a person's access. */}
                  <th>Invite</th>
                  <th>Account</th>
                  {/* Renamed from "Joined": the value below has always been
                      `membership.created_at`, i.e. when the invite was WRITTEN,
                      not when the person signed up. A row for somebody who has
                      never signed in read "Joined 3 days ago" — the exact case
                      this ticket exists for — and the fix is the honest label,
                      not a different value; the Invite column beside it is what
                      actually says whether they have. */}
                  <th>Invited</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedMembers.map((m) => (
                  <tr key={m.membership.id}>
                    <td>
                      <div className={styles.nameCell}>
                        <div className={styles.avatar}>
                          {(m.user.display_name ?? m.user.email).charAt(0).toUpperCase()}
                        </div>
                        <span className={styles.name}>
                          {m.user.display_name || m.user.email.split('@')[0]}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className={styles.email}>{m.user.email}</span>
                    </td>
                    <td>
                      <span
                        className={styles.roleBadge}
                        style={{
                          color: getRoleColor(m.membership.role),
                          backgroundColor: `color-mix(in srgb, ${getRoleColor(m.membership.role)} 14%, transparent)`,
                        }}
                      >
                        {getRoleLabel(m.membership.role)}
                      </span>
                    </td>
                    <td>
                      <InviteStateBadge member={m} />
                    </td>
                    <td>
                      <span className={styles.account}>
                        {m.membership.account_id ? m.membership.account_id.slice(0, 8) : 'Tenant-level'}
                      </span>
                    </td>
                    <td>
                      <span className={styles.invited}>
                        {formatRelativeTime(m.membership.created_at)}
                      </span>
                    </td>
                    <td>
                      <MemberActionsMenu
                        member={m}
                        currentRole={role}
                        onRoleChanged={handleRoleChanged}
                        onRoleChangeFailed={setActionError}
                        onRemoveClick={setConfirmRemove}
                        onResendClick={setResendFor}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvited={handleInvited}
          onCreated={reload}
        />
      )}

      {resendFor && (
        <ResendInviteModal
          member={resendFor}
          onClose={() => setResendFor(null)}
          onResent={reload}
        />
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove Team Member"
        message={`Are you sure you want to remove ${confirmRemove?.user.display_name || confirmRemove?.user.email}? They will lose access to this workspace.`}
        confirmLabel={removing ? 'Removing...' : 'Remove'}
        danger
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}
