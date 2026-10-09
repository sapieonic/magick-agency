import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { filterSwitcherItems, type SwitcherSearchItem } from '../../utils/switcherSearch';
import styles from './SwitcherDropdown.module.css';

export type SwitcherItem = SwitcherSearchItem;

interface SwitcherDropdownProps {
  label: string;
  items: SwitcherItem[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onClose: () => void;
  searchPlaceholder: string;
  searchAriaLabel: string;
  listAriaLabel: string;
  emptyNoun: string;
}

/**
 * Shared dropdown for the top-bar tenant and account switchers.
 *
 * The list is the scrolling surface (`max-height` + `overflow-y: auto`); the
 * label and search stay put above it. Selection is click / Enter / Space on an
 * item — wheel and trackpad motion only scroll. Options are `tabIndex={-1}`
 * so Tab leaves the composite instead of walking every row; ArrowUp/ArrowDown
 * still move programmatic focus.
 */
export function SwitcherDropdown({
  label,
  items,
  activeId,
  onSelect,
  onClose,
  searchPlaceholder,
  searchAriaLabel,
  listAriaLabel,
  emptyNoun,
}: SwitcherDropdownProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterSwitcherItems(items, query), [items, query]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  function focusItem(index: number) {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-switcher-item]');
    buttons?.[index]?.focus();
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown' && visible.length > 0) {
      e.preventDefault();
      focusItem(0);
    }
  }

  function handleItemKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (index < visible.length - 1) focusItem(index + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0) searchRef.current?.focus();
      else focusItem(index - 1);
    }
  }

  return (
    <div className={styles.dropdown} role="presentation">
      <div className={styles.header}>
        <div className={styles.dropdownLabel}>{label}</div>
        <div className={styles.search}>
          <Search className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={searchPlaceholder}
            aria-label={searchAriaLabel}
            autoComplete="off"
          />
        </div>
      </div>
      <div
        className={styles.list}
        ref={listRef}
        role="listbox"
        aria-label={listAriaLabel}
        data-testid="switcher-list"
        onWheel={(e) => e.stopPropagation()}
      >
        {visible.length === 0 ? (
          <div className={styles.empty} role="presentation">
            No {emptyNoun} matches “{query.trim()}”.
          </div>
        ) : (
          visible.map((item, index) => {
            const selected = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                data-switcher-item
                className={selected ? styles.itemActive : styles.item}
                onClick={() => onSelect(item.id)}
                onKeyDown={(e) => handleItemKeyDown(e, index)}
              >
                <span className={styles.itemInfo}>
                  <span className={styles.itemName}>{item.name}</span>
                  {item.subtitle ? (
                    <span className={styles.itemSubtitle}>{item.subtitle}</span>
                  ) : null}
                </span>
                {selected && <Check className={styles.checkIcon} aria-hidden="true" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
