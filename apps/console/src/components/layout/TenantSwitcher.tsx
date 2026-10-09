import { useState, useRef, useEffect } from 'react';
import { Building2, ChevronDown } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { SwitcherDropdown } from './SwitcherDropdown';
import { shouldCloseSwitcherOnBlur } from '../../utils/switcherFocus';
import styles from './TenantSwitcher.module.css';

export function TenantSwitcher() {
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
      <div className={styles.trigger} style={{ cursor: 'default' }} title={activeTenant?.name ?? 'No tenant'}>
        <Building2 className={styles.triggerIcon} />
        <span className={styles.triggerName}>
          {activeTenant?.name ?? 'No tenant'}
        </span>
      </div>
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
        <Building2 className={styles.triggerIcon} />
        <span className={styles.triggerName} title={activeTenant?.name ?? 'Select tenant'}>
          {activeTenant?.name ?? 'Select tenant'}
        </span>
        <ChevronDown
          className={`${styles.triggerChevron} ${open ? styles.triggerChevronOpen : ''}`}
        />
      </button>

      {open && (
        <SwitcherDropdown
          label="Switch tenant"
          items={tenants.map(tenant => ({
            id: tenant.id,
            name: tenant.name,
            subtitle: tenant.slug,
          }))}
          activeId={activeTenant?.id}
          onSelect={handleSelect}
          onClose={() => closeMenu(true)}
          searchPlaceholder="Search tenants…"
          searchAriaLabel="Search tenants"
          listAriaLabel="Tenants"
          emptyNoun="tenant"
        />
      )}
    </div>
  );
}
