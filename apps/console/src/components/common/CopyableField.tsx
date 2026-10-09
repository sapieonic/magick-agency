import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import styles from './CopyableField.module.css';

interface CopyableFieldProps {
  label: string;
  value: string;
  mono?: boolean;
  /**
   * Compact single-line layout (label, value, and copy button share one row)
   * for tight spaces like a page header or a list card. Default is the
   * stacked block used for reference panels (e.g. Tenant ID / Account ID).
   */
  inline?: boolean;
}

/** Read-only identity field with a copy button (e.g. Tenant ID, Account ID, Prompt ID). */
export function CopyableField({ label, value, mono = false, inline = false }: CopyableFieldProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  const copyButtonLabel = copied ? `${label} copied` : `Copy ${label}`;

  if (inline) {
    return (
      <span className={styles.inlineField}>
        <span className={styles.inlineLabel}>{label}</span>
        <span className={`${styles.inlineValue} ${mono ? styles.mono : ''}`}>
          {value || '--'}
        </span>
        <button
          type="button"
          className={styles.inlineCopyButton}
          onClick={handleCopy}
          disabled={!value}
          title={`Copy ${label}`}
          aria-label={copyButtonLabel}
        >
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        </button>
      </span>
    );
  }

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldValueRow}>
        <span className={`${styles.fieldValue} ${mono ? styles.mono : ''}`}>
          {value || '--'}
        </span>
        <button
          type="button"
          className={styles.copyButton}
          onClick={handleCopy}
          disabled={!value}
          title={`Copy ${label}`}
          aria-label={copyButtonLabel}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
