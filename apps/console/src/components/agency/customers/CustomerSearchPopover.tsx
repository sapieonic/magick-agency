import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { usePermission } from '../../../hooks/usePermission';
import { CustomerSearchBox } from './CustomerSearchBox';
import styles from './CustomerSearchPopover.module.css';

/**
 * "Search a number" in the agency shell's top bar (`docs/customer-history.md` §5).
 *
 * A button that opens the full box in a panel rather than the box itself: the top
 * bar is one line high, and the box's helper text, live preview and recent
 * searches are the part that tells people how to type a number (CH5), so they are
 * never squeezed out. Escape or a click outside closes it; a search closes it as
 * it opens the results.
 */
export function CustomerSearchPopover({ resultsPath = '/agency/customers' }: { resultsPath?: string }) {
  const allowed = usePermission('agency.customer_history.read');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  if (!allowed) return null;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Search a number"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="customer-search-trigger"
      >
        <Search size={15} aria-hidden="true" />
        <span>Search a number</span>
      </button>
      {open && (
        <div id={panelId} className={styles.panel} role="dialog" aria-label="Search a number">
          <CustomerSearchBox resultsPath={resultsPath} onSearched={() => close(false)} autoFocus />
        </div>
      )}
    </div>
  );
}

export default CustomerSearchPopover;
