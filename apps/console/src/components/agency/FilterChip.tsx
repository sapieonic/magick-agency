import { Check } from 'lucide-react';
import styles from './SpineListLayout.module.css';

interface FilterChipProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * A single checkbox filter rendered as a toggle pill. The native checkbox
 * stays in the DOM — focusable, toggled by its label, matched by
 * `getByLabelText` — but is visually replaced by the pill the label renders;
 * `display: none` on the input would drop it from the accessibility tree
 * along with the pixels.
 */
export function FilterChip({ label, checked, onChange }: FilterChipProps) {
  return (
    <label className={`${styles.chip} ${checked ? styles.chipActive : ''}`}>
      <input
        type="checkbox"
        className={styles.chipInput}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {checked && <Check size={13} className={styles.chipCheck} aria-hidden="true" />}
      {label}
    </label>
  );
}
