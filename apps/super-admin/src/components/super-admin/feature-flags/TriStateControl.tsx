import { useRef, type ReactNode } from 'react';
import type { TriState } from './flagUtils';
import styles from './featureFlags.module.css';

interface Props {
  value: TriState;
  onSelect: (next: TriState) => void;
  /** Accessible label for the radiogroup (e.g. the flag name). */
  ariaLabel: string;
  /** Sub-line under "Inherit" attributing the inherited default's source. */
  inheritSub?: ReactNode;
  disabled?: boolean;
}

const ORDER: TriState[] = ['inherit', 'on', 'off'];

/**
 * Segmented Inherit / On / Off control for a boolean flag. Implements the WAI-ARIA
 * radiogroup keyboard contract: a single Tab stop (roving tabindex) with
 * Arrow/Home/End moving the selection. Presentational only — the parent owns the
 * write (and any confirm/reason gating). Shared by the tenant tab and the global
 * registry so the two surfaces stay identical.
 */
export function TriStateControl({ value, onSelect, ariaLabel, inheritSub, disabled }: Props) {
  const groupRef = useRef<HTMLDivElement>(null);

  const move = (delta: number) => {
    const idx = ORDER.indexOf(value);
    const next = ORDER[(idx + delta + ORDER.length) % ORDER.length]!;
    onSelect(next);
    // Move focus to the newly-selected radio so AT announces it.
    requestAnimationFrame(() => {
      groupRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowLeft':
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); onSelect('inherit'); break;
      case 'End': e.preventDefault(); onSelect('off'); break;
    }
  };

  const radio = (state: TriState, className: string | undefined, label: ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === state}
      tabIndex={value === state ? 0 : -1}
      className={`${styles.seg} ${className ?? ''}`}
      disabled={disabled}
      onClick={() => onSelect(state)}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={groupRef}
      className={styles.triState}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {radio('inherit', value === 'inherit' ? styles.segActive : '', (
        <>
          <span>Inherit</span>
          {inheritSub != null && <span className={styles.segSub} aria-hidden="true">{inheritSub}</span>}
        </>
      ))}
      {radio('on', value === 'on' ? styles.segOn : '', 'On')}
      {radio('off', value === 'off' ? styles.segOff : '', 'Off')}
    </div>
  );
}
