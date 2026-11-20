import { useState } from 'react';
import { useDoubleKey } from '../../../hooks/useDoubleKey';

/**
 * AS11: `E` then `E` stops a call while it rings (Call coming, 03), with no button on the screen.
 *
 * On a call (04) End call is `HoldToConfirmButton`; Call coming has no button at all (spec §2:
 * "none"), so the keys live here. Both read `useDoubleKey`, so the gesture is the same on both
 * screens: the same window, a held key's repeat is not a second press, it is ignored in a text
 * field, with a modifier, or while a dialog over the station owns the keyboard (`suspended`, or a
 * handler that already took the key), and Escape, the window losing focus or going to type calls
 * it off.
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
  const [stoppedFor, setStoppedFor] = useState<string | null>(null);
  const { armed } = useDoubleKey(
    () => {
      setStoppedFor(attemptId);
      onStop();
    },
    {
      enabled: enabled && attemptId !== null && stoppedFor !== attemptId,
      suspended,
      resetKey: attemptId,
    },
  );
  return { armed };
}
