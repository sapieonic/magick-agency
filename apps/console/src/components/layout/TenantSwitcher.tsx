import { useState, useRef, useEffect } from 'react';
import { Building2, ChevronDown } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { SwitcherDropdown } from './SwitcherDropdown';
import { shouldCloseSwitcherOnBlur } from '../../utils/switcherFocus';
import styles from './ContextSwitcher.module.css';

/**
 * The tenant line of the sidebar's context block (decision B28): no box, small and muted above the account, the full
 * width of the sidebar. A plain label with one to choose from, the switcher otherwise.
 */
export function TenantSwitcher() {
  const triggerClass = `${styles.trigger} ${styles.tenant}`;
  const { tenants } = useAuth();
  const { activeTenant, setActiveTenantId } = useTenant();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function closeMenu(restoreFocus = false) {
    // Focus the trigger before unmounting the dropdown, otherwise Escape
    // (and select) leave keyboard/AT users on the document body.
    if (restoreFocus) triggerRef.current?.focus();
    setOpen(false);
  }

  function handleSelect(tenantId: string) {
    setActiveTenantId(tenantId);
    closeMenu(true);
  }

  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    // Tab out closes; a null relatedTarget is a scrollbar / chrome click and
    // must not. Pointer-outside is the document mousedown listener above.
    if (shouldCloseSwitcherOnBlur(ref.current, e.relatedTarget)) {
      setOpen(false);
    }
  }

  if (tenants.length <= 1) {
    return (
      <div className={triggerClass} style={{ cursor: 'default' }} title={activeTenant?.name ?? 'No organisation'}>
        <Building2 className={styles.triggerIcon} />
        <span className={styles.triggerName}>
          {activeTenant?.name ?? 'No organisation'}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.switcher} ref={ref} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        className={triggerClass}
        onClick={() => setOpen(prev => !prev)}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Building2 className={styles.triggerIcon} />
        <span className={styles.triggerName} title={activeTenant?.name ?? 'Select organisation'}>
          {activeTenant?.name ?? 'Select organisation'}
        </span>
        <ChevronDown
          className={`${styles.triggerChevron} ${open ? styles.triggerChevronOpen : ''}`}
        />
      </button>

      {open && (
        <SwitcherDropdown
          label="Switch organisation"
          items={tenants.map(tenant => ({
            id: tenant.id,
            name: tenant.name,
            subtitle: tenant.slug,
          }))}
          activeId={activeTenant?.id}
          onSelect={handleSelect}
          onClose={() => closeMenu(true)}
          searchPlaceholder="Search organisations…"
          searchAriaLabel="Search organisations"
          listAriaLabel="Organisations"
          emptyNoun="organisation"
        />
      )}
    </div>
  );
}
