import { useRef, type MutableRefObject } from 'react';

/**
 * A ref that always holds the value from the **latest render**.
 *
 * For a callback or listener that must keep one identity for its whole life —
 * a window `keydown` bound once, a socket handler, a timer armed several
 * renders ago — but still read today's value when it fires. Without it the
 * callback either closes over the render that built it (stale) or lists the
 * value as a dependency and is rebuilt, re-bound or re-armed whenever it moves.
 *
 * Assigned during render, which is the point: the ref is current by the time any
 * effect or event handler from this render can run. It is never a substitute for
 * state — nothing re-renders when it changes.
 */
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
