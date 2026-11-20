import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ImageOff } from 'lucide-react';
import {
  TILE_ICON_KEYS,
  TILE_ICON_LABELS,
  TileIcon,
  isTileIconKey,
  type TileIconKey,
} from '@magick-agency/web-ui/components/TileIcon';
import styles from './TileIconPicker.module.css';

/**
 * The picture on an outcome's or a break reason's tile (agent station BE-13), in campaign
 * Settings: a small button showing the picture, which opens a grid of every picture the station
 * draws (`TILE_ICON_KEYS`, the same map the station uses) and "No picture". No picture leaves the
 * key out, and the station then picks one from the outcome itself.
 *
 * The grid is a radio group: arrow keys move between pictures, Enter or Space picks one, Escape
 * closes it and puts focus back on the button. A click outside closes it too. A stored value the
 * list does not know (a stray, or one retired) shows as no picture, as the station shows it, and
 * is replaced only when the supervisor picks.
 */
export function TileIconPicker({
  value,
  onChange,
  name,
  disabled = false,
  describedBy,
  testId,
}: {
  value: string | null | undefined;
  /** The picture picked, or `undefined` for none. */
  onChange: (next: TileIconKey | undefined) => void;
  /** What the tile is called ("Will pay"), for the button's label. */
  name: string;
  disabled?: boolean;
  describedBy?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const gridId = useId();
  const current = isTileIconKey(value) ? value : null;
  const options: Array<TileIconKey | null> = [null, ...TILE_ICON_KEYS];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    // The picked picture (or No picture) takes focus, as a radio group's checked radio does.
    gridRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (key: TileIconKey | null) => {
    onChange(key ?? undefined);
    close();
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 6, ArrowLeft: -1, ArrowUp: -6 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const radios = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const at = radios.indexOf(document.activeElement as HTMLElement);
    const next = radios[Math.min(radios.length - 1, Math.max(0, (at < 0 ? 0 : at) + step))];
    next?.focus();
  };

  const label = current ? TILE_ICON_LABELS[current] : 'No picture';
  return (
    <div className={styles.picker} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((was) => !was)}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? gridId : undefined}
        aria-label={`Picture for ${name}: ${label}`}
        aria-describedby={describedBy}
        title={`Picture: ${label}`}
        data-testid={testId}
      >
        {current ? <TileIcon icon={current} size={16} /> : <ImageOff size={14} aria-hidden="true" className={styles.none} />}
      </button>
      {open ? (
        <div
          ref={gridRef}
          id={gridId}
          className={styles.grid}
          role="radiogroup"
          aria-label={`Picture for ${name}`}
          onKeyDown={onGridKey}
        >
          {options.map((key) => {
            const checked = key === current;
            const optionLabel = key ? TILE_ICON_LABELS[key] : 'No picture';
            return (
              <button
                key={key ?? 'none'}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className={key ? styles.option : `${styles.option} ${styles.noneOption}`}
                onClick={() => pick(key)}
                title={optionLabel}
                aria-label={optionLabel}
                data-testid={`tile-icon-option-${key ?? 'none'}`}
              >
                {key ? <TileIcon icon={key} size={18} /> : <ImageOff size={16} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
