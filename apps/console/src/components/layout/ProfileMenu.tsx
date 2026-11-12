import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, LogOut, Moon, Sun } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { useTheme } from '../../contexts/ThemeContext';
import { shouldCloseSwitcherOnBlur } from '../../utils/switcherFocus';
import { UserAvatar } from '../common/UserAvatar';
import styles from './ProfileMenu.module.css';

/**
 * The signed-in person's menu, at the right of the console's top bar: who you are, the tenant
 * and account ids to quote to support, the theme, and sign out. It is in the one shell every
 * signed-in page uses, so sign-out is reachable everywhere (it used to live only in the `/app`
 * shell's top bar).
 *
 * No Settings, "Credits & Billing" or "API Keys" items (decision #5); Settings is in the
 * sidebar.
 *
 * A disclosure, not a menu: the panel holds text, ids to copy and two buttons, reached with Tab
 * in page order, so the trigger says `aria-expanded` and `aria-controls` and claims no popup
 * role. Escape closes it and puts focus back on the trigger; Tab past its last control or a
 * click outside closes it.
 */
export function ProfileMenu() {
  const { user, logout } = useAuth();
  const { tenantId, accountId } = useTenant();
  const { theme, toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<'tenant' | 'account' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = `${useId()}-profile`;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      // Search above it takes its own Escape (`defaultPrevented`): one layer per press.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  async function handleLogout() {
    setOpen(false);
    await logout();
  }

  async function handleCopyId(which: 'tenant' | 'account', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(which);
      setTimeout(() => setCopiedId((prev) => (prev === which ? null : prev)), 2000);
    } catch {
      // The Clipboard API may not be available.
    }
  }

  const displayName = user?.display_name || user?.email || 'User';
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <div
      className={styles.userMenu}
      ref={menuRef}
      onBlur={(e) => {
        if (open && shouldCloseSwitcherOnBlur(menuRef.current, e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        className={styles.userBtn}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Profile menu for ${displayName}`}
        data-testid="profile-menu-trigger"
      >
        <UserAvatar user={user} size="sm" />
        <span className={styles.userName}>{displayName}</span>
        <ChevronDown className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className={styles.dropdown} id={panelId} data-testid="profile-menu">
          <div className={styles.dropdownHeader}>
            <div className={styles.dropdownName}>{user?.display_name || 'User'}</div>
            <div className={styles.dropdownEmail}>{user?.email}</div>
          </div>

          {(tenantId || accountId) && (
            <div className={styles.idSection}>
              {tenantId && (
                <div className={styles.idRow}>
                  <span className={styles.idLabel}>Organisation ID</span>
                  <code className={styles.idValue} title={tenantId}>{tenantId}</code>
                  <button
                    className={styles.idCopyBtn}
                    onClick={() => handleCopyId('tenant', tenantId)}
                    type="button"
                    title="Copy organisation ID"
                    aria-label="Copy organisation ID"
                  >
                    {copiedId === 'tenant' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              )}
              {accountId && (
                <div className={styles.idRow}>
                  <span className={styles.idLabel}>Account ID</span>
                  <code className={styles.idValue} title={accountId}>{accountId}</code>
                  <button
                    className={styles.idCopyBtn}
                    onClick={() => handleCopyId('account', accountId)}
                    type="button"
                    title="Copy Account ID"
                    aria-label="Copy Account ID"
                  >
                    {copiedId === 'account' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              )}
            </div>
          )}

          <button className={styles.dropdownItem} onClick={toggleTheme} type="button" data-testid="profile-menu-theme">
            {theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
            {`Switch to ${nextTheme} mode`}
          </button>

          <div className={styles.dropdownDivider} />
          <button className={styles.dropdownItemDanger} onClick={handleLogout} type="button">
            <LogOut size={14} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
