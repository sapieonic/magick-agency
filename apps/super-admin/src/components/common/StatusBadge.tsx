import {
  type CSSProperties,
  type ReactNode,
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
} from 'react';
import {
  Check,
  X,
  Clock,
  Phone,
  AlertTriangle,
  Loader,
  PhoneOff,
  Ban,
  Send,
  Eye,
  Pause,
  Play,
} from 'lucide-react';
import styles from './StatusBadge.module.css';

/** Small icon that appears before status label for color-blind accessibility */
const STATUS_ICONS: Record<string, ReactNode> = {
  'completed': <Check size={10} />,
  'failed': <X size={10} />,
  'no answer': <PhoneOff size={10} />,
  'busy': <Phone size={10} />,
  'switched off': <Ban size={10} />,
  'timeout': <Clock size={10} />,
  'cancelled': <X size={10} />,
  'canceled': <X size={10} />,
  'queued': <Clock size={10} />,
  'initiating': <Loader size={10} />,
  'ringing': <Phone size={10} />,
  'in progress': <Play size={10} />,
  'scheduled': <Clock size={10} />,
  'executing': <Loader size={10} />,
  'partially failed': <AlertTriangle size={10} />,
  'active': <Play size={10} />,
  'paused': <Pause size={10} />,
  'pending': <Clock size={10} />,
  'initiated': <Loader size={10} />,
  'sending': <Send size={10} />,
  'sent': <Check size={10} />,
  'delivered': <Check size={10} />,
  'read': <Eye size={10} />,
  'undelivered': <X size={10} />,
  'success': <Check size={10} />,
  'untested': <Clock size={10} />,
  'inactive': <Pause size={10} />,
  'revoked': <Ban size={10} />,
};

const STATUS_TOOLTIPS: Record<string, string> = {
  'queued': 'Waiting to be processed by the system',
  'initiating': 'The system is setting up the call',
  'ringing': 'The phone is ringing, waiting for the recipient to answer',
  'in progress': 'Call is currently active and ongoing',
  'completed': 'Successfully finished',
  'failed': 'Could not be completed due to an error',
  'no answer': 'The recipient did not pick up the phone',
  'busy': 'The recipient\'s phone line was occupied',
  'switched off': 'Phone was switched off or not reachable',
  'timeout': 'The connection attempt took too long',
  'cancelled': 'Was manually cancelled before completion',
  'canceled': 'Was manually cancelled before completion',
  'scheduled': 'Set to run at a future date and time',
  'executing': 'Currently being processed',
  'partially failed': 'Some items succeeded but others failed',
  'active': 'Currently running and operational',
  'paused': 'Temporarily stopped, can be resumed',
  'pending': 'Waiting to be picked up',
  'initiated': 'Has been started and is being set up',
  'sending': 'Message is being sent to the recipient',
  'sent': 'Message has been sent to the network',
  'delivered': 'Message was successfully received by the recipient',
  'read': 'Message was opened and read by the recipient',
  'undelivered': 'Message could not be delivered to the recipient',
  'success': 'The connectivity test passed',
  'untested': 'No connectivity test has been run yet',
  'inactive': 'Disabled — not in use',
  'revoked': 'Permanently revoked and no longer usable',
};

interface StatusBadgeProps {
  label: string;
  color?: string;
  tooltip?: string;
  /**
   * Raw backend status (e.g. `switched_off`) used only to resolve the icon and
   * the fallback tooltip. Pass this when `label` is already humanized plain text
   * so the correct icon still appears. When omitted, icon/tooltip resolve from
   * `label` exactly as before (back-compatible).
   */
  status?: string;
}

export function StatusBadge({ label, color, tooltip, status }: StatusBadgeProps) {
  const resolvedColor = color ?? 'var(--accent)';

  /* Tint and border are derived from the colour it was GIVEN, whatever form that
     takes. There used to be a `startsWith('var(')` branch here that swapped in
     `--accent-subtle` and a hardcoded violet border, so every caller passing a
     token got a green/amber/red label sitting in a PURPLE pill — recurring
     schedules, super-admin usage and the agency campaign badges all did, and
     moving the catalogs/documents status maps onto tokens would have added two
     more pages to that list. `color-mix()` accepts a `var()` perfectly well, so
     the branch bought nothing; it was never needed. */
  const style: CSSProperties = {
    color: resolvedColor,
    backgroundColor: `color-mix(in srgb, ${resolvedColor} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${resolvedColor} 25%, transparent)`,
  };

  // Icon/tooltip resolution keys off the raw `status` when provided (because the
  // visible `label` may now be humanized plain text), otherwise off the label.
  const iconKey = (status ?? label).toLowerCase().replace(/_/g, ' ');
  const resolvedTooltip = tooltip ?? STATUS_TOOLTIPS[iconKey] ?? null;
  const statusIcon = STATUS_ICONS[iconKey] ?? null;

  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [tipStyle, setTipStyle] = useState<CSSProperties>({});
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    if (!visible) return;
    const wrapper = wrapperRef.current;
    const tip = tooltipRef.current;
    if (!wrapper || !tip) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pad = 8;

    // Vertical: prefer above, fall back to below
    let top: string;
    if (wrapperRect.top - tipRect.height - 6 < pad) {
      top = `calc(100% + 6px)`;     // below
    } else {
      top = `auto`;
    }
    const bottom = top === 'auto' ? `calc(100% + 6px)` : 'auto';

    // Horizontal: center, but clamp to viewport
    const wrapperCenter = wrapperRect.left + wrapperRect.width / 2;
    let left = wrapperCenter - tipRect.width / 2;

    // Clamp left edge
    if (left < pad) left = pad;
    // Clamp right edge
    if (left + tipRect.width > window.innerWidth - pad) {
      left = window.innerWidth - pad - tipRect.width;
    }

    // Convert to offset relative to wrapper
    const offsetLeft = left - wrapperRect.left;

    setTipStyle({
      top,
      bottom,
      left: `${offsetLeft}px`,
      transform: 'none',
    });
  }, [visible]);

  const showTooltip = useCallback(() => {
    setVisible(true);
  }, []);

  const hideTooltip = useCallback(() => {
    setVisible(false);
  }, []);

  const badgeContent = (
    <>
      {statusIcon && <span className={styles.statusIcon} aria-hidden="true">{statusIcon}</span>}
      {label}
    </>
  );

  if (resolvedTooltip) {
    return (
      <span
        className={styles.wrapper}
        ref={wrapperRef}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
      >
        <span className={styles.badge} style={style}>
          {badgeContent}
        </span>
        <span
          ref={tooltipRef}
          className={`${styles.tooltip} ${visible ? styles.tooltipVisible : ''}`}
          style={tipStyle}
        >
          {resolvedTooltip}
        </span>
      </span>
    );
  }

  return (
    <span className={styles.badge} style={style}>
      {badgeContent}
    </span>
  );
}
