import { useState, useCallback, useRef, useLayoutEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, MoreVertical, Send, Shield, Trash2 } from 'lucide-react';
import { canManageRole } from '@magick-agency/contracts/rbac';
import { usePermission } from '../../hooks/usePermission';
import { useTenant } from '../../contexts/TenantContext';
import { updateUserRole } from '../../api/users';
import type { TenantMember, UpdateRoleInput } from '../../types/team';
import type { Role } from '../../types/auth';
import { CHANGE_ROLES, getRoleColor } from './teamRoles';
import { invitationIsResendable } from './teamInvites';
import styles from './TeamPage.module.css';

/** How a member is named in a sentence about them: their name, else their address. */
export function memberName(member: TenantMember): string {
  return member.user.display_name || member.user.email;
}

/** The thrown error's own message, or a fallback when it carries none. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export interface MemberActionsMenuProps {
  member: TenantMember;
  currentRole: Role | undefined;
  onRoleChanged: () => void;
  /** The role change was refused; `message` is the sentence to show. */
  onRoleChangeFailed: (message: string) => void;
  onRemoveClick: (member: TenantMember) => void;
  onResendClick: (member: TenantMember) => void;
}

export function MemberActionsMenu({
  member,
  currentRole,
  onRoleChanged,
  onRoleChangeFailed,
  onRemoveClick,
  onResendClick,
}: MemberActionsMenuProps) {
  const { tenantId } = useTenant();
  const canUpdateRole = usePermission('user.update_role');
  const canRemove = usePermission('user.remove');
  /* `user.invite` rather than a permission of its own: the server guards
     `POST /invites/resend` with exactly that, on the reasoning that re-issuing an
     invitation is the same act as issuing one. A menu item behind a looser check
     than the route would 403 on arrival. */
  const canResend = usePermission('user.invite') && invitationIsResendable(member);
  const [open, setOpen] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The contract's rule, the one the server applies: strictly higher in
  // `ROLE_HIERARCHY` (`agent` sits below `viewer`). No resolved role acts on nobody.
  const canActOn = currentRole !== undefined && canManageRole(currentRole, member.membership.role);
  const assignable = currentRole
    ? CHANGE_ROLES.filter((r) => canManageRole(currentRole, r.value) && r.value !== member.membership.role)
    : [];

  const closeMenu = useCallback(() => {
    setOpen(false);
    setRoleMenuOpen(false);
  }, []);

  // Position the menu in the viewport (portaled) so table overflow cannot clip it.
  // Prefer below the trigger; flip above when there isn't enough room.
  const reposition = useCallback(() => {
    const btn = buttonRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;

    const rect = btn.getBoundingClientRect();
    const menuHeight = menu.offsetHeight;
    const pad = 8;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - pad;
    const placeAbove = spaceBelow < menuHeight && rect.top - pad >= menuHeight + gap;
    const top = placeAbove ? rect.top - menuHeight - gap : rect.bottom + gap;
    const right = Math.max(pad, window.innerWidth - rect.right);

    setMenuStyle({
      position: 'fixed',
      top: `${Math.max(pad, top)}px`,
      right: `${right}px`,
      left: 'auto',
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onReposition = () => reposition();
    window.addEventListener('resize', onReposition);
    // Capture scroll from nested overflow containers (table wrap, page content).
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, roleMenuOpen, reposition]);

  const handleRoleChange = async (newRole: Role) => {
    if (!tenantId) return;
    setUpdating(true);
    try {
      await updateUserRole(tenantId, member.user.id, {
        role: newRole as UpdateRoleInput['role'],
      });
      onRoleChanged();
    } catch (err) {
      /* Said, not swallowed: nothing reloads on this path, so a silent failure
         left the old badge on screen reading as a change still on its way. */
      onRoleChangeFailed(
        `Could not change ${memberName(member)}’s role: ${errorMessage(err, 'the request failed')}`,
      );
    } finally {
      setUpdating(false);
      closeMenu();
    }
  };

  if (!canActOn || (!canUpdateRole && !canRemove && !canResend)) {
    return null;
  }

  return (
    <div className={styles.actionsWrap}>
      <button
        type="button"
        className={styles.actionsButton}
        ref={buttonRef}
        aria-label="Member actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) closeMenu();
          else { setOpen(true); setRoleMenuOpen(false); }
        }}
        disabled={updating}
      >
        <MoreVertical size={16} />
      </button>
      {open && createPortal(
        <>
          <div className={styles.actionsBackdrop} onClick={closeMenu} />
          <div
            className={styles.actionsMenu}
            ref={menuRef}
            style={menuStyle}
            role="menu"
            aria-label="Member actions"
          >
            {canUpdateRole && (
              <div className={styles.actionsSubWrap}>
                <button
                  type="button"
                  className={styles.actionsItem}
                  role="menuitem"
                  onClick={() => setRoleMenuOpen(!roleMenuOpen)}
                >
                  <Shield size={14} />
                  Change Role
                  <ChevronDown size={12} className={styles.actionsChevron} />
                </button>
                {roleMenuOpen && (
                  <div className={styles.roleSubmenu}>
                    {assignable.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        className={styles.roleOption}
                        role="menuitem"
                        onClick={() => handleRoleChange(r.value)}
                        disabled={updating}
                      >
                        <span
                          className={styles.roleOptionDot}
                          style={{ backgroundColor: getRoleColor(r.value) }}
                        />
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {canResend && (
              /* Above Remove, and deliberately: deleting the membership was the
                 ONLY way out of an expired invitation before this existed, so the
                 recovery has to sit where the workaround was reached for. */
              <button
                type="button"
                className={styles.actionsItem}
                role="menuitem"
                onClick={() => { onResendClick(member); closeMenu(); }}
              >
                <Send size={14} />
                Resend Invite
              </button>
            )}
            {canRemove && (
              <button
                type="button"
                className={`${styles.actionsItem} ${styles.actionsItemDanger}`}
                role="menuitem"
                onClick={() => { onRemoveClick(member); closeMenu(); }}
              >
                <Trash2 size={14} />
                Remove
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
