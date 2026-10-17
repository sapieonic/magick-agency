import { useState, useEffect, useId } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import styles from './Pagination.module.css';

interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;

  /** Adds first/last jump buttons either side of the page box. Default false. */
  showEdges?: boolean;
  /**
   * Renders "Showing 1–20 of 5,205 calls" in place of today's bare
   * "· 5205 total". Pass the noun so the label speaks the surface's language;
   * singular/plural is chosen off the NUMERIC total, never a string match.
   */
  itemNoun?: { singular: string; plural: string };
  /** Renders a page-size <select>. Requires `onLimitChange`. */
  pageSizeOptions?: number[];
  onLimitChange?: (limit: number) => void;
  /**
   * 'centered' (default — today's look, everything on one centred row) or
   * 'split' (the count label hard left, the controls hard right) for a pager
   * sitting in a table card's footer.
   */
  layout?: 'centered' | 'split';
  /** Drops the component's own vertical padding, for a card-footer pager. */
  flush?: boolean;
}

export function Pagination({
  total,
  limit,
  offset,
  onChange,
  showEdges = false,
  itemNoun,
  pageSizeOptions,
  onLimitChange,
  layout = 'centered',
  flush = false,
}: PaginationProps) {
  const pageSizeId = useId();
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const [inputValue, setInputValue] = useState(String(currentPage));

  // Sync input when page changes externally (e.g. filter reset)
  useEffect(() => {
    setInputValue(String(currentPage));
  }, [currentPage]);

  const jumpToPage = () => {
    const page = parseInt(inputValue, 10);
    if (isNaN(page) || page < 1) {
      setInputValue(String(currentPage));
      return;
    }
    const clamped = Math.min(Math.max(1, page), totalPages);
    setInputValue(String(clamped));
    onChange((clamped - 1) * limit);
  };

  const handleLimitChange = (next: number) => {
    // Reset to offset 0 whenever the page size changes — staying on
    // "page 14" while the size changes would land the reader somewhere
    // arbitrary in the new pagination.
    onLimitChange?.(next);
    onChange(0);
  };

  const rangeLabel = (() => {
    if (!itemNoun || total === 0) return null;
    const start = offset + 1;
    const end = Math.min(offset + limit, total);
    const noun = total === 1 ? itemNoun.singular : itemNoun.plural;
    return `Showing ${start.toLocaleString('en-IN')}–${end.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} ${noun}`;
  })();

  const containerClassName = [
    styles.container,
    layout === 'split' ? styles.split : null,
    flush ? styles.flush : null,
  ]
    .filter(Boolean)
    .join(' ');

  const controls = (
    <div className={styles.controls}>
      {showEdges && (
        <button
          type="button"
          className={styles.button}
          disabled={!hasPrev}
          onClick={() => onChange(0)}
          aria-label="First page"
        >
          <ChevronsLeft size={14} />
        </button>
      )}
      <button
        type="button"
        className={styles.button}
        disabled={!hasPrev}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft size={14} />
        Previous
      </button>
      <span className={styles.info}>
        Page{' '}
        <input
          type="text"
          className={styles.pageInput}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={jumpToPage}
          onKeyDown={(e) => { if (e.key === 'Enter') jumpToPage(); }}
          style={{ width: `${Math.max(2, String(totalPages).length)}ch` }}
        />
        {' '}of <strong>{totalPages}</strong>
        {!itemNoun && total > 0 && <> &middot; {total} total</>}
      </span>
      <button
        type="button"
        className={styles.button}
        disabled={!hasNext}
        onClick={() => onChange(offset + limit)}
      >
        Next
        <ChevronRight size={14} />
      </button>
      {showEdges && (
        <button
          type="button"
          className={styles.button}
          disabled={!hasNext}
          onClick={() => onChange((totalPages - 1) * limit)}
          aria-label="Last page"
        >
          <ChevronsRight size={14} />
        </button>
      )}
      {pageSizeOptions && onLimitChange && (
        <span className={styles.pageSize}>
          <label htmlFor={pageSizeId} className={styles.pageSizeLabel}>
            Per page
          </label>
          <select
            id={pageSizeId}
            className={styles.pageSizeSelect}
            value={limit}
            onChange={(e) => handleLimitChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </span>
      )}
    </div>
  );

  if (rangeLabel) {
    return (
      <div className={containerClassName}>
        <span className={styles.rangeLabel}>{rangeLabel}</span>
        {controls}
      </div>
    );
  }

  return <div className={containerClassName}>{controls}</div>;
}
