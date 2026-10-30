import { useEffect, type MutableRefObject } from 'react';
import type { AgencyAgentState } from '../types/agency';

/**
 * Leaving the page — the prompt, the close, and the cancel.
 *
 * ── Two events, because they answer two different questions ────────────────
 * `beforeunload` fires when the browser is *asking*, and the agent may still
 * say no. `pagehide` fires when the page is actually going away. Closing the
 * socket in the first is the defect this split exists to fix, and it was ours:
 * the handler prompted and then closed the socket **synchronously, before the
 * dialog was even shown**. An agent mid-call who pressed Ctrl-W and then chose
 * *Stay* — the exact outcome the prompt exists to produce — was left on a live
 * page with no socket, no heartbeat and no media path. `onclose` took the
 * deliberate-teardown branch, so nothing retried; the API expired the lease into
 * `agent_disconnected`; and the health pill has no `'idle'` arm, so the console
 * read "Connecting" while the customer sat on dead air. The damage landed
 * whether or not the browser ever showed the dialog.
 *
 * So: **`beforeunload` only prompts, and touches nothing.** `pagehide` does the
 * close, which is where that reasoning still holds — an unloading tab
 * that told the API nothing leaves a customer on dead air until the heartbeat
 * grace expires, and `pagehide` is the last point at which we can say so.
 *
 * ── The prompt itself ──────────────────────────────────────────────────────
 * `preventDefault()` asks for the "leave site?" dialog while a customer is on
 * the line, is about to be (`reserved` — the bridge is already coming), or is
 * still owed a disposition (`wrapup`). It is only ever a request: a browser
 * honours it after a user gesture and none of them let a page word it. Safari,
 * and Firefox before 131, ignore `preventDefault()` alone, so `returnValue` is
 * set too — the value is never displayed, it exists only to be set.
 *
 * State is read off `agentStateRef`, not `agentState`: the listener is bound
 * with the callbacks' identities, not the state's, and closing over the
 * render-time value would arm the prompt with whatever state was in effect at
 * mount — `offline`, for the whole shift.
 *
 * ── `pageshow` is the other way back from a closed socket ──────────────────
 * A page put into the back/forward cache gets `pagehide` and can be restored
 * later. Restored, it is alive with a socket we closed and a retired
 * generation that suppresses retries — the same dead console by a different
 * route. A `persisted` restore therefore reconnects, and `reconnect()` claims a fresh
 * generation so the unload close cannot undo it. It mints a token rather than
 * replaying bootstrap's spent one, so the restore no longer costs a `4401` and
 * a retry lap the way it did.
 *
 * Split out of `useAgencyStation`, which supplies the two acts: retiring its
 * socket (`onPageHide`) and reattaching (`onRestore`). Both must be stable —
 * the listeners are re-bound whenever either changes identity.
 */
export function useStationUnloadGuard({
  agentStateRef,
  busyRef,
  onPageHide,
  onRestore,
}: {
  /** The agent state as of the last frame — see `useAgencyStation`. */
  agentStateRef: MutableRefObject<AgencyAgentState>;
  /** A customer on the line that the agent state does not show (a soft-phone call, during `break`). */
  busyRef?: MutableRefObject<boolean>;
  /** Close the station socket: the page is going away. */
  onPageHide: () => void;
  /** Reattach after a back/forward-cache restore. */
  onRestore: () => void;
}): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      const state = agentStateRef.current;
      const busy = busyRef?.current === true;
      if (!busy && state !== 'reserved' && state !== 'on_call' && state !== 'wrapup') return;
      event.preventDefault();
      event.returnValue = '';
    };

    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      onRestore();
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [agentStateRef, busyRef, onPageHide, onRestore]);
}
