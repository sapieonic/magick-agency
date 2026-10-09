import { useRef, useEffect, useState, useCallback, type ReactNode } from 'react';
import { ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react';
import styles from './DataTable.module.css';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  /** Server-side sortable column — requires `onSortChange` on the table. */
  sortable?: boolean;
  /** Fixed column width in px. Advisory: the table uses the browser's `auto` layout (no `table-layout: fixed`), so a browser may compress a column to fit rather than overflow the row. */
  width?: number;
  /** Cell + header alignment. Default 'left'. */
  align?: 'left' | 'right' | 'center';
}

export type SortOrder = 'asc' | 'desc';

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  onRowClick?: (row: T) => void;
  keyExtractor: (row: T) => string;
  /** Currently active sort column key (null = backend default order). */
  sortBy?: string | null;
  sortOrder?: SortOrder;
  /** Called with the column key when a sortable header is clicked. */
  onSortChange?: (key: string) => void;
}

const SKELETON_ROW_COUNT = 5;

const ALIGN_CLASS: Record<'right' | 'center', string | undefined> = {
  right: styles.alignRight,
  center: styles.alignCenter,
};

/** Header/cell alignment class for a column — undefined for the default 'left'. */
function alignClass<T>(col: Column<T>): string | undefined {
  if (col.align === 'right' || col.align === 'center') return ALIGN_CLASS[col.align];
  return undefined;
}

const INTERACTIVE_DESCENDANT_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';

/**
 * True when the event originated from an interactive descendant (a nested button,
 * link, form control, etc.) rather than the row itself — used to keep nested
 * controls (e.g. an "End call" button in an actions column) from also activating
 * the row's onRowClick.
 */
function isInteractiveDescendant(target: EventTarget | null, boundary: Element): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
  return interactive !== null && interactive !== boundary;
}

export function DataTable<T>({
  columns,
  data,
  loading = false,
  onRowClick,
  keyExtractor,
  sortBy = null,
  sortOrder = 'desc',
  onSortChange,
}: DataTableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll, { passive: true });
    window.addEventListener('resize', checkScroll);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, [checkScroll, data]);

  const renderSkeletonRows = () =>
    Array.from({ length: SKELETON_ROW_COUNT }, (_, rowIdx) => (
      <tr key={`skeleton-${rowIdx}`}>
        {columns.map((col) => (
          <td key={col.key} className={alignClass(col)}>
            <div
              className={styles.skeletonCell}
              style={{ width: `${60 + Math.random() * 40}%` }}
            />
          </td>
        ))}
      </tr>
    ));

  const renderDataRows = () => {
    if (data.length === 0) {
      return (
        <tr className={styles.emptyRow}>
          <td colSpan={columns.length}>No data available</td>
        </tr>
      );
    }

    return data.map((row) => (
      <tr
        key={keyExtractor(row)}
        className={onRowClick ? styles.clickableRow : undefined}
        onClick={
          onRowClick
            ? (e) => {
                if (isInteractiveDescendant(e.target, e.currentTarget)) return;
                onRowClick(row);
              }
            : undefined
        }
        onKeyDown={
          onRowClick
            ? (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (isInteractiveDescendant(e.target, e.currentTarget)) return;
                e.preventDefault();
                onRowClick(row);
              }
            : undefined
        }
        tabIndex={onRowClick ? 0 : undefined}
      >
        {columns.map((col) => (
          <td key={col.key} className={alignClass(col)}>
            {col.render
              ? col.render(row)
              : String((row as Record<string, unknown>)[col.key] ?? '')}
          </td>
        ))}
      </tr>
    ));
  };

  const renderHeader = (col: Column<T>) => {
    if (!col.sortable || !onSortChange) return col.label;
    const isActive = sortBy === col.key;
    return (
      <button
        type="button"
        className={`${styles.sortButton}${isActive ? ` ${styles.sortActive}` : ''}`}
        onClick={() => onSortChange(col.key)}
        title={`Sort by ${col.label}`}
      >
        {col.label}
        {isActive
          ? sortOrder === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
          : <ChevronsUpDown size={12} className={styles.sortIdleIcon} />}
      </button>
    );
  };

  return (
    <div className={styles.wrapper}>
      <div
        ref={scrollRef}
        className={`${styles.scrollContainer}${canScrollRight ? ` ${styles.canScrollRight}` : ''}`}
      >
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={alignClass(col)}
                  style={col.width !== undefined ? { width: col.width } : undefined}
                  aria-sort={
                    col.sortable && onSortChange && sortBy === col.key
                      ? sortOrder === 'asc' ? 'ascending' : 'descending'
                      : undefined
                  }
                >
                  {renderHeader(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{loading ? renderSkeletonRows() : renderDataRows()}</tbody>
        </table>
      </div>
    </div>
  );
}
