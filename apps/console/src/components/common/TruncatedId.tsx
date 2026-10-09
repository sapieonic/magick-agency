import { useState } from 'react';
import { Check } from 'lucide-react';
import { truncateId } from '../../utils/format';
import styles from './TruncatedId.module.css';

interface TruncatedIdProps {
  /** The full identifier. Shown truncated; copied and announced in full. */
  value: string;
  /** What this id IS, for the accessible name — e.g. "API key ID". */
  label: string;
  /** Extra class for the host page's own typography (mono, muted, …). */
  className?: string;
  'data-testid'?: string;
}

/**
 * A truncated identifier that is still reachable without a mouse.
 *
 * ── Why this is not a `<span title={id}>` ─────────────────────────────────
 * That was the previous shape on both audit surfaces, and it puts the full
 * value in exactly one place: a hover tooltip. Keyboard users cannot reach it,
 * touch users have no hover, and `title` is announced inconsistently across
 * screen readers — so the identifier was effectively sighted-mouse-only.
 *
 * That matters more here than it would on a decorative tooltip, because the id
 * is the WHOLE point of the cell: an `api_key` audit row names a credential so
 * a reviewer can look it up and revoke it, and the truncated prefix is not
 * enough to do either.
 *
 * So it is a real control: focusable, activatable by keyboard and touch, with
 * an `aria-label` carrying the full value and copy-to-clipboard as the action —
 * the id's actual use is being pasted into a key list, not being read aloud.
 * `title` stays for the mouse case it already served.
 *
 * Clipboard failure is swallowed, matching {@link CopyableField}: the API is
 * absent in insecure contexts and some embedded webviews, and the full value is
 * still in the accessible name, which is the part this component exists for.
 */
export function TruncatedId({ value, label, className, ...rest }: TruncatedIdProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available (insecure context, embedded webview).
    }
  };

  return (
    <button
      type="button"
      className={`${styles.id} ${className ?? ''}`}
      onClick={handleCopy}
      title={value}
      aria-label={copied ? `${label} ${value} copied` : `${label} ${value}. Activate to copy.`}
      data-testid={rest['data-testid']}
    >
      <span className={styles.text}>{truncateId(value)}</span>
      {copied && <Check size={12} aria-hidden="true" className={styles.check} />}
    </button>
  );
}
