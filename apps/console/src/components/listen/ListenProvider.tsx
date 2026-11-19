import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useTenant } from '../../contexts/TenantContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { usePermission } from '../../hooks/usePermission';
import { useListenPlayback, type ListenPlayback } from '../../hooks/listen/useListenPlayback';
import { useListenSession } from '../../hooks/listen/useListenSession';
import { browserStorage } from '../../utils/browserStorage';
import { LIVE_LISTEN_FLAG } from '../../utils/listen/liveListenFlag';
import { LISTEN_CONFIRM, LISTEN_REFUSAL_FALLBACK, listenRefusalMessage } from '../../utils/listen/listenCopy';
import { LISTEN_AGENT_SILENCE_MS } from '../../utils/listen/listenPlayback';
import { listenTargetFor, type ListenCall } from '../../utils/listen/liveCallsTable';
import type { ListenSessionController } from '../../utils/listen/listenSessionController';
import type { ListenSessionState } from '../../utils/listen/listenSessionReducer';

/**
 * The one listen of this console shell (`docs/listening.md` §9). `ConsoleLayout` mounts it around
 * the shell's pages, keyed by the account, with the listening bar docked under them: a listen
 * carries on while the supervisor moves between pages, and ends when they leave the shell (this
 * unmounts) or switch account (the key changes).
 *
 * It owns the session (`useListenSession`), the audio (`useListenPlayback`), the first-use
 * confirmation (LS6, once per browser) and the toast for a refused grant. Pages reach it with
 * {@link useListen}.
 */

/** Where this browser remembers that the supervisor read "Listening is logged". */
export const LISTEN_CONFIRMED_KEY = 'magick-agency.listen.confirmed';

function confirmedHere(): boolean {
  try {
    return browserStorage()?.getItem(LISTEN_CONFIRMED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberConfirmed(): void {
  try {
    browserStorage()?.setItem(LISTEN_CONFIRMED_KEY, '1');
  } catch {
    /* blocked site data: asked again next time, which errs the right way */
  }
}

/** How often the bar checks the browser's audio and the agent's leg while live. */
const LISTEN_WATCH_MS = 500;

export interface ListenContextValue {
  /** The flag is on and the reader holds `agency.calls.listen`: Listen is offered. */
  canListen: boolean;
  state: ListenSessionState;
  controller: ListenSessionController;
  playback: ListenPlayback;
  /**
   * Listen to `call` (after the first-use confirmation, the first time in this browser): a Live
   * calls row, or a Live floor card's call, which carries only what a listen reads (`ListenCall`).
   */
  listen: (call: ListenCall, clockOffsetMs: number) => void;
  stop: () => void;
  /**
   * "Try again" after "Connection lost", or after a listen whose access could not be checked
   * (LS21): a gesture, so it also runs the audio again.
   */
  retry: () => void;
  /** "Turn sound on": a gesture lifts the autoplay policy. */
  resumeSound: () => void;
}

/**
 * The toast, where the shell has one (the app always does). A shell rendered without the
 * provider (a layout test) gets no toast rather than a crash: `useToast` throws outside it.
 */
function useOptionalToast(): ReturnType<typeof useToast>['showToast'] | null {
  try {
    return useToast().showToast;
  } catch {
    return null;
  }
}

/**
 * The flag map holds an answer (`ready`). While it loads (an account list reloaded moves it) or
 * after a failed read, every flag reads off, which is no answer at all; no provider is none either.
 */
function useFlagsAnswered(): boolean {
  try {
    return useFeatureFlags().status === 'ready';
  } catch {
    return false;
  }
}

const ListenContext = createContext<ListenContextValue | null>(null);

/** The shell's listen, or null outside it (a page rendered on its own, in a test). */
export function useListen(): ListenContextValue | null {
  return useContext(ListenContext);
}

export function ListenProvider({ children }: { children: ReactNode }) {
  const { tenantId, accountId } = useTenant();
  const flagOn = useFeatureFlagEnabled(LIVE_LISTEN_FLAG);
  const mayListen = usePermission('agency.calls.listen');
  const canListen = flagOn && mayListen;
  const flagTurnedOff = useFlagsAnswered() && !flagOn;
  const showToast = useOptionalToast();

  const playback = useListenPlayback();
  const { engine } = playback;
  const { state, controller } = useListenSession({
    tenantId,
    accountId,
    onAudio: (leg, frame) => engine.push(leg, frame),
    onAttach: () => engine.reset(),
  });

  // A refused first grant is a toast with the reason, and no bar. A call full of listeners counts
  // them from the row the listen was started from.
  const startedListeners = useRef<number | undefined>(undefined);
  const shownRefusal = useRef(state.refusalSeq);
  useEffect(() => {
    if (state.refusalSeq === shownRefusal.current) return;
    shownRefusal.current = state.refusalSeq;
    if (state.refusal) showToast?.(listenRefusalMessage(state.refusal, startedListeners.current), 'error');
  }, [state.refusalSeq, state.refusal, showToast]);

  // While live: is the browser running the audio, and is the agent's leg arriving?
  const live = state.phase === 'live';
  useEffect(() => {
    if (!live) {
      controller.reportAgentSilent(false);
      return;
    }
    const check = () => {
      controller.reportSound(engine.blocked);
      const silent = engine.silentFor('agent');
      controller.reportAgentSilent(silent !== null && silent > LISTEN_AGENT_SILENCE_MS);
    };
    check();
    const timer = setInterval(check, LISTEN_WATCH_MS);
    return () => clearInterval(timer);
  }, [live, controller, engine]);

  // A listen over (stopped, ended, lost): silence now, not the ~600 ms still queued, and the
  // context suspended rather than running for the shell's life. The next gesture resumes it.
  const audible = state.phase === 'connecting' || state.phase === 'live' || state.phase === 'reconnecting';
  useEffect(() => {
    if (!audible) engine.release();
  }, [audible, engine]);

  // The flag going off or the permission going away ends a listen here at once, and the bar says
  // which: the flag first, as it is what a supervisor cannot change. Only an answer turns the flag
  // off here: a flag map loading or unread reads every flag off, and ending the listen on it would
  // say "turned off" when nothing was (the server's re-check is the gate for that, LS10).
  useEffect(() => {
    if (flagTurnedOff) controller.withdraw('turned_off');
    else if (!mayListen) controller.withdraw('revoked');
  }, [flagTurnedOff, mayListen, controller]);

  const [pending, setPending] = useState<{ call: ListenCall; offset: number } | null>(null);

  const begin = useCallback(
    (call: ListenCall, offset: number) => {
      // A browser that cannot play the sound gets no grant, no session row and no bar.
      if (!engine.ensure()) {
        showToast?.(LISTEN_REFUSAL_FALLBACK.noAudio, 'error');
        return;
      }
      // Inside the click: the gesture lets the browser run the context.
      void engine.resume();
      // A call started from Live floor names no listeners: its refusal gives no count.
      startedListeners.current = call.listeners?.length;
      controller.start(listenTargetFor(call, offset));
    },
    [engine, controller, showToast],
  );

  const listen = useCallback(
    (call: ListenCall, offset: number) => {
      if (!canListen) return;
      if (confirmedHere()) begin(call, offset);
      else setPending({ call, offset });
    },
    [canListen, begin],
  );

  const stop = useCallback(() => controller.stop(), [controller]);
  const retry = useCallback(() => {
    void engine.resume();
    controller.retry();
  }, [engine, controller]);
  const resumeSound = useCallback(() => {
    void engine.resume().then(() => controller.reportSound(engine.blocked));
  }, [engine, controller]);

  const value = useMemo<ListenContextValue>(
    () => ({ canListen, state, controller, playback, listen, stop, retry, resumeSound }),
    [canListen, state, controller, playback, listen, stop, retry, resumeSound],
  );

  return (
    <ListenContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title={LISTEN_CONFIRM.title}
        message={LISTEN_CONFIRM.message}
        confirmLabel={LISTEN_CONFIRM.confirm}
        onConfirm={() => {
          const next = pending;
          setPending(null);
          // The flag or the permission may have gone while the dialog was open.
          if (!next || !canListen) return;
          rememberConfirmed();
          begin(next.call, next.offset);
        }}
        onCancel={() => setPending(null)}
      />
    </ListenContext.Provider>
  );
}
