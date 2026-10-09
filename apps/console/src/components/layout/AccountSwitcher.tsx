import { useState, useRef, useEffect } from 'react';
import { Briefcase, ChevronDown, AlertTriangle } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { SwitcherDropdown } from './SwitcherDropdown';
import { shouldCloseSwitcherOnBlur } from '../../utils/switcherFocus';
import styles from './AccountSwitcher.module.css';

export function AccountSwitcher() {
  const { accounts, accountId, setActiveAccountId, accountResolution, reloadAccounts } =
    useTenant();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Hide entirely if no accounts loaded yet
  if (accounts.length === 0) {
    return null;
  }

  const activeAccount = accounts.find(a => a.id === accountId) ?? null;

  function closeMenu(restoreFocus = false) {
    if (restoreFocus) triggerRef.current?.focus();
    setOpen(false);
  }

  function handleSelect(id: string) {
    setActiveAccountId(id);
    closeMenu(true);
  }

  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    // Tab out closes; a null relatedTarget is a scrollbar / chrome click and
    // must not. Pointer-outside is the document mousedown listener above.
    if (shouldCloseSwitcherOnBlur(ref.current, e.relatedTarget)) {
      setOpen(false);
    }
  }

  /**
   * The narrowed-list warning (`accountResolution === 'degraded'`).
   *
   * **This control is the right home for it because this control is what is
   * wrong.** `GET /accounts` failed for a reason that was not a permission refusal,
   * so we fell back to the caller's own memberships: the user is working, but the
   * list in this dropdown may be short. Previously that was reported nowhere —
   * resolution said `'ready'`, no retry was offered, and the only escapes were a
   * tenant switch or a reload, neither of which a user tries when nothing has told
   * them anything is wrong.
   *
   * Non-blocking on purpose. `AccountUnavailable` is for `'error'`, where there is
   * no usable account at all; taking the whole app down over a list that might be
   * missing a row would be a worse outcome than the narrowing it reports.
   *
   * Rendered in BOTH the single- and multi-account shapes, because the single case
   * is the more likely one when a list has been narrowed to just the caller's own
   * membership — and it is the shape that otherwise renders as plain, confident
   * text with nothing to click.
   */
  const degraded = accountResolution === 'degraded';
  const warning = degraded ? (
    <button
      type="button"
      className={styles.degraded}
      onClick={reloadAccounts}
      title="We couldn’t load the full account list, so this may be missing accounts you have access to. Click to try again."
      data-testid="accounts-degraded"
    >
      <AlertTriangle className={styles.degradedIcon} aria-hidden="true" />
      <span>List may be incomplete — retry</span>
    </button>
  ) : null;

  // If only 1 account, show as static text (no dropdown)
  if (accounts.length <= 1) {
    return (
      <>
        <div className={styles.trigger} style={{ cursor: 'default' }}>
          <Briefcase className={styles.triggerIcon} />
          <span className={styles.triggerName}>
            {activeAccount?.name ?? 'No account'}
          </span>
        </div>
        {warning}
      </>
    );
  }

  return (
    <div className={styles.switcher} ref={ref} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen(prev => !prev)}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Briefcase className={styles.triggerIcon} />
        <span className={styles.triggerName}>
          {activeAccount?.name ?? 'Select account'}
        </span>
        <ChevronDown
          className={`${styles.triggerChevron} ${open ? styles.triggerChevronOpen : ''}`}
        />
      </button>

      {open && (
        <SwitcherDropdown
          label="Switch account"
          items={accounts.map(account => ({
            id: account.id,
            name: account.name,
          }))}
          activeId={activeAccount?.id}
          onSelect={handleSelect}
          onClose={() => closeMenu(true)}
          searchPlaceholder="Search accounts…"
          searchAriaLabel="Search accounts"
          listAriaLabel="Accounts"
          emptyNoun="account"
        />
      )}
      {warning}
    </div>
  );
}
