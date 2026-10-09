import { useState, useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import styles from './DateRangeFilter.module.css';

/** Quick-pick windows, plus an explicit start/end range. */
export type DateRangePreset = 'today' | '7d' | 'custom';

/** Inclusive ISO 8601 creation-time bounds, as the list endpoints accept them. */
export interface DateRangeValue {
  from?: string;
  to?: string;
}

interface DateRangeFilterProps {
  /** Currently applied range (undefined = no date filter). */
  value: DateRangeValue | undefined;
  /** Called with the resolved range, or undefined to clear the filter. */
  onApply: (range: DateRangeValue | undefined) => void;
}

/** Midnight `daysAgo` days before today, in the browser's local timezone. */
function startOfDaysAgo(daysAgo: number): Date {
  const now = new Date();
  // Calendar arithmetic, not millisecond subtraction: Date normalizes an
  // out-of-range day, so this stays on the right date across a DST shift.
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
}

/**
 * Resolve a preset to concrete bounds. Deliberately computed on demand (in an
 * event handler) rather than during render: the rolling presets read the
 * current clock, so evaluating them in a memo would produce a new object every
 * render and re-trigger the parent's fetch loop.
 *
 * The upper bound is left open. Pinning `to` to the click instant would freeze
 * the window, so the list's auto-refresh could never surface a call that landed
 * afterwards — the opposite of what "Today" should mean.
 */
function resolvePreset(preset: 'today' | '7d'): DateRangeValue {
  // 7d is 7 calendar days *inclusive* of today, hence 6.
  return { from: startOfDaysAgo(preset === 'today' ? 0 : 6).toISOString() };
}

/** Local `YYYY-MM-DD` for a date input, or '' if the instant is unparseable. */
function toDateInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-midnight (or end-of-day) instant for a `YYYY-MM-DD` input value. */
function toIsoBound(day: string, edge: 'start' | 'end'): string | null {
  const d = new Date(`${day}T${edge === 'start' ? '00:00:00' : '23:59:59.999'}`);
  // A hand-typed year like 275760 overflows the Date range; toISOString() would
  // throw rather than just producing a useless filter.
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sameRange(a: DateRangeValue | undefined, b: DateRangeValue | undefined): boolean {
  return (a?.from ?? undefined) === (b?.from ?? undefined) && (a?.to ?? undefined) === (b?.to ?? undefined);
}

/**
 * Creation-date filter for the call list views. Bounds are anchored to the
 * browser's local timezone — "Today" means the user's today, not UTC's, which
 * matters most for IST users whose day would otherwise cut over at 05:30.
 * The wire format stays ISO 8601 (UTC instants).
 *
 * Custom bounds commit on Enter/blur rather than per keystroke, mirroring
 * `PhoneFilterInput`: a date input fires `change` on every typed digit, so
 * applying eagerly would dispatch a request per character (year 1, 10, 202,
 * 2026...) and reset pagination four times over.
 */
export function DateRangeFilter({ value, onApply }: DateRangeFilterProps) {
  const [preset, setPreset] = useState<DateRangePreset | null>(null);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [invalid, setInvalid] = useState(false);

  /**
   * Last range this component emitted. Lets the sync effect below tell our own
   * value echoing back (ignore) from the parent changing it (reconcile to it).
   * Starts undefined, not at `value`, so a range supplied on the first render
   * is still reconciled into the controls.
   */
  const emitted = useRef<DateRangeValue | undefined>(undefined);

  const emit = useCallback(
    (range: DateRangeValue | undefined) => {
      emitted.current = range;
      onApply(range);
    },
    [onApply],
  );

  const resetLocal = useCallback(() => {
    setPreset(null);
    setCustomFrom('');
    setCustomTo('');
    setInvalid(false);
  }, []);

  // Reflect an externally-driven change (a parent clearing filters, restoring
  // saved state, ...) so the controls can't show something the list isn't
  // filtered by. Without this the `value` prop would be write-only.
  useEffect(() => {
    if (sameRange(value, emitted.current)) return;
    emitted.current = value;
    if (!value || (!value.from && !value.to)) {
      resetLocal();
      return;
    }
    // A bare range carries no record of which preset produced it, so surface it
    // as a custom range — the one mode that can represent any bounds.
    setPreset('custom');
    setCustomFrom(value.from ? toDateInputValue(value.from) : '');
    setCustomTo(value.to ? toDateInputValue(value.to) : '');
    setInvalid(false);
  }, [value, resetLocal]);

  const handlePreset = useCallback(
    (next: 'today' | '7d') => {
      // Clicking the active preset toggles it off.
      if (preset === next) {
        resetLocal();
        emit(undefined);
        return;
      }
      // Drop any custom draft: leaving it behind would resurrect stale dates the
      // next time the user opened the custom panel.
      setPreset(next);
      setCustomFrom('');
      setCustomTo('');
      setInvalid(false);
      emit(resolvePreset(next));
    },
    [preset, emit, resetLocal],
  );

  const handleCustomToggle = useCallback(() => {
    if (preset === 'custom') {
      resetLocal();
      if (value) emit(undefined);
      return;
    }
    // The draft is already empty here — every path that leaves custom mode
    // (preset click, toggle-off, clear, external sync) clears it on the way
    // out, so there is nothing stale to discard on the way in.
    setPreset('custom');
    setInvalid(false);
    // Switching away from a preset drops its filter immediately. Keeping it
    // would leave the pills reading "Custom" over an empty form while the list
    // stayed narrowed to the old preset.
    if (value) emit(undefined);
  }, [preset, value, emit, resetLocal]);

  /** Apply whichever custom bounds are filled; either alone is a valid open range. */
  const commitCustom = useCallback(() => {
    if (!customFrom && !customTo) {
      setInvalid(false);
      if (value) emit(undefined);
      return;
    }
    // The inputs' min/max only *discourage* an inverted range — the browser
    // still reports the typed value — and the backend 400s on from > to, which
    // unmounts the filter bar and strands the user with no way to correct it.
    if (customFrom && customTo && customFrom > customTo) {
      setInvalid(true);
      return;
    }
    const from = customFrom ? toIsoBound(customFrom, 'start') : null;
    const to = customTo ? toIsoBound(customTo, 'end') : null;
    if ((customFrom && !from) || (customTo && !to)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const range: DateRangeValue = {};
    if (from) range.from = from;
    if (to) range.to = to;
    // Blur fires on every tab-through; only refetch when the range actually moved.
    if (sameRange(range, value)) return;
    emit(range);
  }, [customFrom, customTo, value, emit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') commitCustom();
    },
    [commitCustom],
  );

  const handleClear = useCallback(() => {
    resetLocal();
    emit(undefined);
  }, [emit, resetLocal]);

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <div className={styles.segmented}>
          <button
            type="button"
            className={`${styles.pill}${preset === 'today' ? ` ${styles.pillActive}` : ''}`}
            onClick={() => handlePreset('today')}
          >
            Today
          </button>
          <button
            type="button"
            className={`${styles.pill}${preset === '7d' ? ` ${styles.pillActive}` : ''}`}
            onClick={() => handlePreset('7d')}
          >
            Last 7 days
          </button>
          <button
            type="button"
            className={`${styles.pill}${preset === 'custom' ? ` ${styles.pillActive}` : ''}`}
            onClick={handleCustomToggle}
          >
            Custom
          </button>
        </div>

        {preset === 'custom' && (
          <div className={styles.dateRange}>
            <input
              className={`${styles.dateInput}${invalid ? ` ${styles.dateInputInvalid}` : ''}`}
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => { setCustomFrom(e.target.value); setInvalid(false); }}
              onKeyDown={handleKeyDown}
              onBlur={commitCustom}
              title="From date"
              aria-label="From date"
            />
            <span className={styles.dateSep}>—</span>
            <input
              className={`${styles.dateInput}${invalid ? ` ${styles.dateInputInvalid}` : ''}`}
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => { setCustomTo(e.target.value); setInvalid(false); }}
              onKeyDown={handleKeyDown}
              onBlur={commitCustom}
              title="To date"
              aria-label="To date"
            />
          </div>
        )}

        {(value || preset) && (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={handleClear}
            title="Clear date filter"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {invalid && (
        <p className={styles.error} role="alert">
          Enter a valid range — the start date must not be after the end date.
        </p>
      )}
    </div>
  );
}
