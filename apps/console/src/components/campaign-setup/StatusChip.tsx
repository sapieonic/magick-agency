import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, MinusCircle, XCircle } from 'lucide-react';
import styles from './StatusChip.module.css';

export type StatusChipTone = 'success' | 'warning' | 'muted' | 'info' | 'danger';

const TONE_ICONS: Record<StatusChipTone, ReactNode> = {
  success: <CheckCircle2 size={15} strokeWidth={2.25} />,
  warning: <AlertTriangle size={15} strokeWidth={2.25} />,
  muted: <MinusCircle size={15} strokeWidth={2.25} />,
  info: <Info size={15} strokeWidth={2.25} />,
  danger: <XCircle size={15} strokeWidth={2.25} />,
};

export interface StatusChipProps {
  tone: StatusChipTone;
  /** Left out: the tone's own icon. `null`: no icon. */
  icon?: ReactNode;
  children: ReactNode;
  /** A trailing link or button, e.g. "Download". */
  action?: ReactNode;
  testId?: string;
}

/** A rounded chip on its tone's tint: "1,240 customers ready", "12 rows have a bad phone number". */
export function StatusChip({ tone, icon, children, action, testId }: StatusChipProps) {
  const shown = icon === undefined ? TONE_ICONS[tone] : icon;
  return (
    <span className={styles.chip} data-tone={tone} data-testid={testId}>
      {shown != null ? (
        <span className={styles.icon} aria-hidden="true">
          {shown}
        </span>
      ) : null}
      <span className={styles.text}>{children}</span>
      {action != null ? <span className={styles.action}>{action}</span> : null}
    </span>
  );
}

export interface StatusChipRowProps {
  children: ReactNode;
  /** Announce changes politely (the chips after a file is checked). */
  live?: boolean;
  testId?: string;
}

/** Chips in a wrapping row. */
export function StatusChipRow({ children, live = false, testId }: StatusChipRowProps) {
  return (
    <div className={styles.row} aria-live={live ? 'polite' : undefined} data-testid={testId}>
      {children}
    </div>
  );
}
