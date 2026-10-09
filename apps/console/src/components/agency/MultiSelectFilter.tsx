import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './SpineListLayout.module.css';

export interface MultiSelectFilterOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  /** Shown on the closed trigger and read as its accessible name. */
  label: string;
  options: MultiSelectFilterOption[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}

/**
 * A checkbox dropdown for one group of togglable filter values — the
 * multi-select equivalent of a run of `FilterChip` pills, for a group with
 * enough options that laying every one out flat costs more screen space than
 * it is worth (see `AgencyCampaignActivityPage`'s "What happened" groups,
 * which used to spread four rows of pills above the fold).
 *
 * Modelled on `SAUsagePage`'s local `StatusMultiSelect`: same outside-click +
 * Escape dismissal (with focus handed back to the trigger), same "focus
 * moves to the first checkbox on open" behaviour, same plain checkbox list
 * rather than a `listbox` — there is no `option` markup here to make one
 * valid. Unlike that one, this is generic over any `{value,label}[]`, so a
 * second grouped-pill filter can reuse it instead of growing its own copy.
 */
export function MultiSelectFilter({ label, options, selected, onToggle, onClear }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Opening moves focus onto the first option, so the options are reachable
  // without tabbing through the rest of the filter bar first.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
  }, [open]);

  return (
    <div
      className={styles.multiSelect}
      ref={wrapRef}
      // Tabbing past the last option leaves the menu behind otherwise. Focus
      // is not restored here — the user is deliberately moving on.
      onBlur={(e) => {
        if (!open) return;
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.multiSelectButton} ${selected.length > 0 ? styles.multiSelectActive : ''}`}
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-expanded={open}
        aria-controls={menuId}
      >
        <span>
          {label}
          {/*
            `aria-hidden`, deliberately: the count is a sighted-user summary,
            not part of the accessible name. Baking it into the name would
            make the trigger's name shift with every toggle ("Calls" →
            "Calls 1" → "Calls 2"), which is the one thing a screen-reader
            user relies on staying put to find this same control again.
          */}
          {selected.length > 0 && (
            <span className={styles.multiSelectCount} aria-hidden="true">{selected.length}</span>
          )}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        // No `role="listbox"`: these are native checkboxes, already accessible
        // in a plain container, and a listbox with no `option` children is
        // invalid ARIA.
        <div className={styles.multiSelectMenu} id={menuId} ref={menuRef}>
          {options.map((opt) => (
            <label key={opt.value} className={styles.multiSelectOption}>
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => onToggle(opt.value)}
              />
              {opt.label}
            </label>
          ))}
          <button
            type="button"
            className={styles.multiSelectClear}
            onClick={onClear}
            disabled={selected.length === 0}
          >
            Clear {label.toLowerCase()}
          </button>
        </div>
      )}
    </div>
  );
}

export default MultiSelectFilter;
