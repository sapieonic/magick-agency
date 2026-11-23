import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import styles from './AdvancedFold.module.css';

export interface AdvancedFoldProps {
  /** e.g. "Advanced settings (most campaigns don't need these)". */
  summary: ReactNode;
  /** Controlled: the parent decides, e.g. forces it open while a field inside needs fixing. */
  open?: boolean;
  /** Uncontrolled starting state. */
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  id?: string;
  testId?: string;
}

/**
 * The folded Advanced section (CS13): `<details>/<summary>` in a bordered box with a turning caret.
 * The summary's click (a tap, Enter or Space) is taken over so a controlled `open` is the only
 * truth: the fold changes only when the parent says so. A fold the browser opens itself (find in
 * page) is reported through `onToggle`.
 *
 * The click listener is a native one on the summary, not React's `onClick`: React listens at the
 * root, after the event has bubbled through `<details>`, which some DOMs toggle there already.
 */
export function AdvancedFold({
  summary,
  open,
  defaultOpen = false,
  onToggle,
  children,
  id,
  testId,
}: AdvancedFoldProps) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : ownOpen;

  function request(next: boolean) {
    if (!controlled) setOwnOpen(next);
    onToggle?.(next);
  }

  const summaryRef = useRef<HTMLElement>(null);
  const toggleRef = useRef(() => {});
  toggleRef.current = () => request(!isOpen);

  useEffect(() => {
    const summaryEl = summaryRef.current;
    if (!summaryEl) return;
    const onClick = (event: Event) => {
      event.preventDefault();
      toggleRef.current();
    };
    summaryEl.addEventListener('click', onClick);
    return () => summaryEl.removeEventListener('click', onClick);
  }, []);

  function onNativeToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const domOpen = event.currentTarget.open;
    if (domOpen !== isOpen) request(domOpen);
  }

  return (
    <details
      className={styles.fold}
      id={id}
      open={isOpen}
      onToggle={onNativeToggle}
      data-testid={testId}
    >
      <summary className={styles.summary} ref={summaryRef}>
        <ChevronRight className={styles.caret} size={16} strokeWidth={2.5} aria-hidden="true" />
        <span className={styles.summaryText}>{summary}</span>
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
