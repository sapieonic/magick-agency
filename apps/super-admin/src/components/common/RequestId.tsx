import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import styles from './RequestId.module.css';

interface RequestIdProps {
  /** The server-side correlation id to display and copy. */
  requestId: string;
  /** Visual tone — `error` matches a danger surface, `neutral` is muted. */
  tone?: 'error' | 'neutral';
}

/**
 * A compact, copy-to-clipboard chip for a support correlation id. Shown on
 * masked/generic errors so users can quote the id to support. Reused by both
 * `ErrorAlert` and `Toast`.
 */
export function RequestId({ requestId, tone = 'neutral' }: RequestIdProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(requestId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable (e.g. insecure context) — the id is
      // still selectable as text, so degrade silently.
    }
  }, [requestId]);

  return (
    <span className={`${styles.chip} ${tone === 'error' ? styles.error : ''}`}>
      <span className={styles.label}>Request ID</span>
      <code className={styles.id}>{requestId}</code>
      <button
        type="button"
        className={styles.copyButton}
        onClick={handleCopy}
        title="Copy request ID"
        aria-label={copied ? 'Request ID copied' : 'Copy request ID'}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </button>
    </span>
  );
}
