import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isTextEntryTarget } from '../utils/keyboardTarget';
import { useLatestRef } from './useLatestRef';

/** The `E`,`E` window: the second press must land within it. Fixed, like the hold's 500 ms. */
export const DOUBLE_KEY_MS = 1500;

export interface DoubleKeyOptions {
  /** Listen at all. False takes the listener away and disarms. */
  enabled: boolean;
  /**
   * Something over the screen owns the keyboard (a dialog over the station). Read when a key
   * arrives, so it never re-binds; turning it on also disarms. While suspended no key counts,
   * Escape included: the dialog's Escape is its own.
   */
  suspended?: boolean;
  /**
   * Where the keydown listener lives: the window (a page-wide shortcut), or one element (a
   * control whose shortcut is heard only with focus on it). A ref is read once the element has
   * mounted.
   */
  scope?: 'window' | RefObject<HTMLElement | null>;
  /** The thing the gesture acts on (a call's attempt id). A new one disarms. */
  resetKey?: unknown;
  /**
   * Escape, or the window losing focus. They call off this gesture, and any other the caller
   * runs beside it (the button's pointer hold), so this is called whether or not `E` was pressed.
   */
  onCallOff?: () => void;
}

/**
 * `E` then `E` within {@link DOUBLE_KEY_MS}: the keyboard's way to end a call, in one place for
 * every screen that has it (On a call's `HoldToConfirmButton`, Call coming's `useRingingStop`),
 * so the two cannot drift apart.
 *
 * - The first `E` arms (`armed` is true, so the screen can say what the second press does); a
 *   second inside the window fires `onFire` once; after the window a press arms afresh.
 * - A held key's auto-repeat is not a second press: the OS repeats a resting finger after about
 *   500 ms, well inside the window, and that must not end a customer's call.
 * - Like every single-key shortcut it is ignored in a text field (`isTextEntryTarget`) and with
 *   Ctrl, Cmd or Alt, and so is a key another handler has already taken (`defaultPrevented`).
 * - Calls it off: Escape, the window losing focus, and focus moving into a text field while
 *   armed. An agent who has gone to type is no longer ending a call.
 */
export function useDoubleKey(
  onFire: () => void,
  { enabled, suspended = false, scope = 'window', resetKey, onCallOff }: DoubleKeyOptions,
): { armed: boolean; disarm: () => void } {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useLatestRef({ onFire, onCallOff, suspended });

  const disarm = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    armedRef.current = false;
    setArmed(false);
  }, []);

  useEffect(() => {
    if (suspended) disarm();
  }, [suspended, disarm]);

  useEffect(() => {
    disarm();
    if (!enabled) return undefined;
    const target: Window | HTMLElement | null = scope === 'window' ? window : scope.current;
    if (!target) return undefined;

    const callOff = () => {
      disarm();
      live.current.onCallOff?.();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (live.current.suspended) return;
      if (event.key === 'Escape') {
        callOff();
        return;
      }
      if (isTextEntryTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== 'e' && event.key !== 'E') return;
      if (event.repeat || event.defaultPrevented) return;
      event.preventDefault();
      if (armedRef.current) {
        disarm();
        live.current.onFire();
        return;
      }
      armedRef.current = true;
      setArmed(true);
      timer.current = setTimeout(disarm, DOUBLE_KEY_MS);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (armedRef.current && isTextEntryTarget(event.target)) disarm();
    };

    target.addEventListener('keydown', onKeyDown as EventListener);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('blur', callOff);
    return () => {
      target.removeEventListener('keydown', onKeyDown as EventListener);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('blur', callOff);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [enabled, scope, resetKey, disarm, live]);

  return { armed, disarm };
}
