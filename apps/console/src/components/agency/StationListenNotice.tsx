import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { LIVE_LISTEN_FLAG } from '../../utils/listen/liveListenFlag';
import { LISTEN_AGENT_NOTICE } from '../../utils/listen/listenCopy';
import styles from './StationListenNotice.module.css';

/**
 * The agent's standing line (`docs/listening.md` LS2), in the station header's info popover:
 * "Calls may be listened to by a supervisor for quality and training." Shown while the account
 * allows listening (`agency_live_listen_enabled`, the consent gate), on every call or none: there
 * is deliberately no live "Supervisor listening" indicator in this build.
 *
 * A disclosure, not a menu: one button that opens a note under it. Escape closes it and returns
 * focus to the button; a click outside closes it. Nothing here acts on a call, which is why it
 * sits in the header and not the action bar.
 */
export function StationListenNotice() {
  const on = useFeatureFlagEnabled(LIVE_LISTEN_FLAG);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent | MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  if (!on) return null;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="About this station"
        onClick={() => setOpen((was) => !was)}
        data-testid="station-info"
      >
        <Info size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <div id={panelId} className={styles.popover} role="note" data-testid="station-info-popover">
          <p className={styles.line}>{LISTEN_AGENT_NOTICE}</p>
        </div>
      ) : null}
    </div>
  );
}
