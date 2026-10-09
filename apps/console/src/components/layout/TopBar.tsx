import { useState, useRef, useEffect } from 'react';
import { Menu, ChevronDown, LogOut, Sun, Moon, Copy, Check } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { useTheme } from '../../contexts/ThemeContext';
import { TenantSwitcher } from './TenantSwitcher';
import { AccountSwitcher } from './AccountSwitcher';
import styles from './TopBar.module.css';

interface TopBarProps {
  onMenuClick?: () => void;
  /** Whether the mobile navigation drawer is currently open. */
  menuExpanded?: boolean;
  /** id of the mobile navigation drawer this button controls. */
  menuControls?: string;
}

export function TopBar({ onMenuClick, menuExpanded, menuControls }: TopBarProps) {
  const { user, logout } = useAuth();
  const { tenantId, accountId } = useTenant();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<'tenant' | 'account' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function getInitials(name: string | null, email: string): string {
    if (name) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    return email.slice(0, 2).toUpperCase();
  }

  async function handleLogout() {
    setMenuOpen(false);
    await logout();
  }

  async function handleCopyId(which: 'tenant' | 'account', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(which);
      setTimeout(() => setCopiedId(prev => (prev === which ? null : prev)), 2000);
    } catch {
      // Clipboard API may not be available
    }
  }

  const displayName = user?.display_name || user?.email || 'User';
  const initials = getInitials(user?.display_name ?? null, user?.email ?? '');

  return (
    <div className={styles.topbar}>
      <button
        className={styles.menuBtn}
        onClick={onMenuClick}
        type="button"
        aria-label="Toggle menu"
        aria-expanded={menuExpanded}
        aria-controls={menuControls}
      >
        <Menu size={20} />
      </button>

      <div className={styles.spacer} />

      <div className={styles.actions}>
        <TenantSwitcher />
        <AccountSwitcher />

        <button
          className={styles.themeToggle}
          onClick={toggleTheme}
          type="button"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <div className={styles.userMenu} ref={menuRef}>
          <button
            className={styles.userBtn}
            onClick={() => setMenuOpen(prev => !prev)}
            type="button"
          >
            <div className={styles.avatar}>
              {user?.avatar_url ? (
                <img src={user.avatar_url} alt={displayName} />
              ) : (
                initials
              )}
            </div>
            <span className={styles.userName}>{displayName}</span>
            <ChevronDown
              className={`${styles.chevron} ${menuOpen ? styles.chevronOpen : ''}`}
            />
          </button>

          {menuOpen && (
            <div className={styles.dropdown}>
              <div className={styles.dropdownHeader}>
                <div className={styles.dropdownName}>
                  {user?.display_name || 'User'}
                </div>
                <div className={styles.dropdownEmail}>{user?.email}</div>
              </div>

              {(tenantId || accountId) && (
                <div className={styles.idSection}>
                  {tenantId && (
                    <div className={styles.idRow}>
                      <span className={styles.idLabel}>Tenant ID</span>
                      <code className={styles.idValue} title={tenantId}>{tenantId}</code>
                      <button
                        className={styles.idCopyBtn}
                        onClick={() => handleCopyId('tenant', tenantId)}
                        type="button"
                        title="Copy Tenant ID"
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
                      >
                        {copiedId === 'account' ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/*
                The menu holds no Settings, "Credits & Billing" or "API Keys" items
                (decision #5).
              */}
              <div className={styles.dropdownDivider} />
              <button
                className={styles.dropdownItemDanger}
                onClick={handleLogout}
                type="button"
              >
                <LogOut size={14} />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
