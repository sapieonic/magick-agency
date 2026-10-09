import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Search, X } from 'lucide-react';
import { filterTenants, type SearchableTenant } from '../../utils/tenant-search';
import styles from './TenantPicker.module.css';

/**
 * Searchable tenant combobox for super-admin screens.
 *
 * Replaces a plain `<select>` of every tenant (which forces scrolling once the
 * list grows) with a type-to-filter listbox. Filtering matches name, slug and
 * id (see `utils/tenant-search`). Fully keyboard driven: ↑/↓ move the active
 * option, Enter selects, Escape closes (and clears an unsubmitted query).
 */
export interface TenantPickerProps {
  tenants: SearchableTenant[];
  /** Selected tenant id, or '' for none. */
  value: string;
  onChange: (tenantId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  /** Input id, so a caller-owned <label htmlFor> binds to the field. */
  id?: string;
  placeholder?: string;
  /**
   * Accessible name for callers that don't render a visible `<label>` next
   * to the field (e.g. inline filters). Omit when a `<label htmlFor>` already
   * labels `id` — the two would otherwise fight over the field's accessible name.
   */
  ariaLabel?: string;
}

export function TenantPicker({
  tenants,
  value,
  onChange,
  loading = false,
  disabled = false,
  id = 'tenant-picker',
  placeholder = 'Search tenants by name, slug or ID…',
  ariaLabel,
}: TenantPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = useMemo(
    () => tenants.find((t) => t.id === value) ?? null,
    [tenants, value],
  );

  // A `?tenant=` deep link can name a tenant that no longer exists (or that this
  // admin can't see). Say so instead of rendering an empty-looking field, and
  // keep the clear affordance available so the dead selection can be dropped.
  const unresolvedSelection = !!value && !selected && !loading;

  // While the menu is open the input *is* the search box; when closed it shows
  // the current selection so the field reads like a normal picker.
  const results = useMemo(
    () => (open ? filterTenants(tenants, query) : tenants),
    [tenants, query, open],
  );

  const listboxId = `${id}-listbox`;
  // Clamp rather than index blindly: `results` can shrink under a stale
  // activeIndex (a filtered query, or the tenant list reloading while open).
  const clampedIndex = results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1);
  const activeOption = results[clampedIndex];

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  // Click outside dismisses without changing the selection.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, close]);

  // Keep the active option in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, clampedIndex, query]);

  const select = useCallback((tenantId: string) => {
    onChange(tenantId);
    close();
  }, [onChange, close]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (results.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((clampedIndex + delta + results.length) % results.length);
      return;
    }
    if ((e.key === 'Home' || e.key === 'End') && open && results.length > 0) {
      e.preventDefault();
      setActiveIndex(e.key === 'Home' ? 0 : results.length - 1);
      return;
    }
    if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      if (activeOption) select(activeOption.id);
      return;
    }
    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab' && open) {
      close();
    }
  }

  return (
    <div className={styles.picker} ref={rootRef}>
      <div className={`${styles.field} ${open ? styles.fieldOpen : ''}`}>
        <span className={styles.leadIcon} aria-hidden="true">
          {open ? <Search size={14} /> : <Building2 size={14} />}
        </span>
        <input
          id={id}
          ref={inputRef}
          type="text"
          className={styles.input}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeOption ? `${id}-opt-${activeOption.id}` : undefined}
          autoComplete="off"
          disabled={disabled || loading}
          placeholder={
            loading ? 'Loading tenants…'
              : unresolvedSelection && !open ? 'Tenant not found — search to pick one'
              : placeholder
          }
          value={open ? query : selected?.name ?? ''}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onMouseDown={() => { if (!open) setOpen(true); }}
          onKeyDown={handleKeyDown}
        />
        {(selected || unresolvedSelection) && !disabled && !loading && (
          <button
            type="button"
            className={styles.clearBtn}
            aria-label="Clear tenant filter"
            title="Clear tenant"
            onClick={() => { onChange(''); setQuery(''); setActiveIndex(0); inputRef.current?.focus(); }}
          >
            <X size={14} />
          </button>
        )}
        <button
          type="button"
          className={styles.toggleBtn}
          aria-label={open ? 'Close tenant list' : 'Open tenant list'}
          tabIndex={-1}
          disabled={disabled || loading}
          onClick={() => (open ? close() : (setOpen(true), inputRef.current?.focus()))}
        >
          <ChevronDown size={14} className={open ? styles.chevronOpen : undefined} />
        </button>
      </div>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.resultCount} aria-live="polite">
            {results.length === 0
              ? 'No tenants match'
              : `${results.length} of ${tenants.length} tenant${tenants.length === 1 ? '' : 's'}`}
          </div>
          <ul className={styles.list} id={listboxId} role="listbox" ref={listRef} aria-label="Tenants">
            {results.length === 0 ? (
              <li className={styles.empty} role="presentation">
                No tenant matches “{query}”. Try a different name, slug or ID.
              </li>
            ) : (
              results.map((tenant, index) => (
                <li
                  key={tenant.id}
                  id={`${id}-opt-${tenant.id}`}
                  role="option"
                  aria-selected={tenant.id === value}
                  data-active={index === clampedIndex}
                  className={`${styles.option} ${index === clampedIndex ? styles.optionActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(e) => e.preventDefault()} // keep focus on the input
                  onClick={() => select(tenant.id)}
                >
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{tenant.name}</span>
                    <span className={styles.optionSlug}>{tenant.slug}</span>
                  </span>
                  {tenant.id === value && <Check size={14} className={styles.checkIcon} />}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
