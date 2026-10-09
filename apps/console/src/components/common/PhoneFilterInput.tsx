import { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { normalizeE164 } from '../../utils/phone';
import styles from './PhoneFilterInput.module.css';

interface PhoneFilterInputProps {
  /** Currently applied phone filter (undefined = no filter). */
  value: string | undefined;
  /** Called with the normalized E.164 number, or undefined to clear the filter. */
  onApply: (phone: string | undefined) => void;
}

/**
 * Exact-match phone search box for call list views. The backend matches the
 * full E.164 number only (no substring search), so input is normalized and
 * validated before the filter is applied (on Enter or blur).
 */
export function PhoneFilterInput({ value, onApply }: PhoneFilterInputProps) {
  const [input, setInput] = useState(value ?? '');
  const [invalid, setInvalid] = useState(false);

  const apply = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) {
      setInvalid(false);
      if (value !== undefined) onApply(undefined);
      return;
    }
    const normalized = normalizeE164(trimmed);
    if (!normalized) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setInput(normalized);
    if (normalized !== value) onApply(normalized);
  }, [input, value, onApply]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') apply();
    },
    [apply],
  );

  const handleClear = useCallback(() => {
    setInput('');
    setInvalid(false);
    onApply(undefined);
  }, [onApply]);

  return (
    <div className={styles.wrap}>
      <div className={styles.group}>
        <input
          className={`${styles.input}${invalid ? ` ${styles.inputInvalid}` : ''}`}
          type="tel"
          placeholder="Search phone (exact)..."
          title="Exact match — enter the full number with country code, e.g. +919876543210"
          value={input}
          onChange={(e) => { setInput(e.target.value); setInvalid(false); }}
          onKeyDown={handleKeyDown}
          onBlur={apply}
        />
        {value && (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={handleClear}
            title="Clear phone filter"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {invalid && (
        <p className={styles.error}>
          Enter a full number with country code, e.g. +919876543210.
        </p>
      )}
    </div>
  );
}
