import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Download, ListPlus } from 'lucide-react';
import styles from './ExportSplitButton.module.css';

export interface ExportSplitButtonProps {
  /** The plain export: exactly the file Export CSV always gave (CL43). */
  onExport: () => void;
  /** Opens Export with fields. */
  onExportWithFields: () => void;
  /** The plain export is running: its part says so. */
  exporting: boolean;
  disabled: boolean;
  /** The plain export's tooltip. */
  title: string;
}

/**
 * The campaign Call log's **Export CSV** as a split button (`docs/call-log.md` §10): the main part
 * is the plain export, one click and the same file; the arrow opens a menu with **Export with
 * fields…**. The menu is dismissed the way the console's other menus are (Escape gives focus back
 * to the arrow; a press outside closes it and goes on to what it landed on).
 */
export function ExportSplitButton({ onExport, onExportWithFields, exporting, disabled, title }: ExportSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) arrowRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    itemRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Disabled while open (a load began): the menu goes with the button.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const onArrowKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !disabled) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // One item: the arrows keep focus on it, Tab leaves the menu and closes it.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      itemRef.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className={styles.split} ref={wrapRef}>
      <button
        type="button"
        className={`btn-secondary ${styles.main}`}
        onClick={onExport}
        disabled={disabled}
        title={title}
      >
        <Download size={16} aria-hidden="true" />
        {exporting ? 'Preparing…' : 'Export CSV'}
      </button>
      <button
        type="button"
        ref={arrowRef}
        className={`btn-secondary ${styles.arrow}`}
        aria-label="More export options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onArrowKeyDown}
        disabled={disabled}
        data-testid="call-log-export-more"
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.menu} id={menuId} role="menu" aria-label="More export options" onKeyDown={onMenuKeyDown}>
          <button
            type="button"
            ref={itemRef}
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              onExportWithFields();
            }}
          >
            <ListPlus size={14} aria-hidden="true" />
            Export with fields…
          </button>
        </div>
      )}
    </div>
  );
}
