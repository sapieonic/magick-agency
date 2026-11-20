import { useEffect, useRef, useState } from 'react';
import { DOUBLE_KEY_MS } from '../../../components/agency/HoldToConfirmButton';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { isTextEntryTarget } from '../../../utils/keyboardTarget';

/**
 * AS11: `E` then `E` stops a call while it rings (Call coming, 03), with no button on the screen.
 *
 * On a call (04) End call is `HoldToConfirmButton`, which owns `E` `E` there; Call coming has no
 * button at all (spec §2: "none"), so the keys live here, the same gesture with the same window
 * (`DOUBLE_KEY_MS`) as before the redesign, when the hang-up button was on screen while a call
 * rang. Like every single-key shortcut it is ignored in a text field, with a modifier, or while a
 * dialog over the station owns the keyboard (`suspended`, or a handler that already took the key).
 *
 * One stop per ringing call: a new attempt id re-arms it. `armed` is true between the two presses,
 * so the screen can say what the second press does.
 */
export function useRingingStop({
  attemptId,
  enabled,
  suspended,
  onStop,
}: {
  /** The ringing call's attempt id; null when no call is ringing. */
  attemptId: string | null;
  /** Call coming is on screen with a call to stop. */
  enabled: boolean;
  suspended: boolean;
  onStop: () => void;
}): { armed: boolean } {
  const [armed, setArmed] = useState(false);
  const live = useLatestRef({ suspended, onStop });
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    setArmed(false);
    if (!enabled || attemptId === null) return undefined;
    let windowTimer: ReturnType<typeof setTimeout> | null = null;
    let first = false;
    const disarm = () => {
      first = false;
      if (windowTimer !== null) clearTimeout(windowTimer);
      windowTimer = null;
      setArmed(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (first) disarm();
        return;
      }
      if (event.key !== 'e' && event.key !== 'E') return;
      if (event.defaultPrevented || live.current.suspended) return;
      if (isTextEntryTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (firedFor.current === attemptId) return;
      event.preventDefault();
      if (first) {
        disarm();
        firedFor.current = attemptId;
        live.current.onStop();
        return;
      }
      first = true;
      setArmed(true);
      windowTimer = setTimeout(disarm, DOUBLE_KEY_MS);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', disarm);
      if (windowTimer !== null) clearTimeout(windowTimer);
    };
  }, [attemptId, enabled, live]);

  return { armed };
}
