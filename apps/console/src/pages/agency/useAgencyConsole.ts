import { useCallback, useEffect, useRef, useState } from 'react';
import { setAgentAvailable } from '../../api/agency';
import { useAgencyStation, type UseAgencyStationResult } from '../../hooks/useAgencyStation';
import { DiagnosticsLog } from '../../utils/agencyDiagnostics';
import { errorBody } from '../../utils/agencyErrors';
import { useAgencyAudio, type AgencyAudioState } from '../../hooks/useAgencyAudio';
import { useAgencyCues, type CueFlash } from '../../hooks/useAgencyCues';
import type { CuePrefs } from '../../utils/agencyCuePrefs';
import { useServerClock, type ServerClock } from '../../hooks/useServerClock';
import { audioTarget } from '../../utils/softphone/audioTarget';
import { SOFTPHONE_BREAK_REASON, SOFTPHONE_BREAK_REASON_LABEL } from '../../types/softphone';
import { useAgencyNotes } from '../../hooks/useAgencyNotes';
import { useBreakQueue } from '../../hooks/useBreakQueue';
import { useDispositionSubmit } from '../../hooks/useDispositionSubmit';
import { NOTES_DISABLED_COPY, PAD_DISABLED_COPY, padGate } from '../../utils/agencyPadGate';
import type { DispositionFormState, DispositionBlockReason } from '../../utils/agencyDispositionForm';
import type { NotesStatus } from '../../utils/agencyNotes';
import { trackAgencyPresenceChanged, trackAgencyPresenceRefused } from '../../analytics/events';
import type { AgencyBreakReason, AgencyDisposition, AgencySessionBootstrap } from '../../types/agency';

/**
 * The Agent Console's wiring, extracted from the page so the state machine is
 * testable without a DOM and the page stays markup.
 *
 * Everything here is composition of already-tested primitives. The value it adds is
 * the *sequencing* — which is where the remaining Phase 2 traps live, since each one
 * is an ordering or lifecycle rule that no individual module can enforce alone.
 *
 * The pieces: the station (`useAgencyStation`), the pad gate (`utils/agencyPadGate`),
 * the notes (`useAgencyNotes`), the disposition (`useDispositionSubmit`) and the
 * break queue (`useBreakQueue`). Presence — Go available / End break — is the one
 * flow still written here, because it is where the audio and cue unlocks ride.
 */

// Re-exported at their old home: tests and callers name them from this module.
export { NOTES_DEBOUNCE_MS } from '../../hooks/useAgencyNotes';
export { AGENT_STATE_RECONCILE_MS, WAITING_FOR_DIALER_COPY } from '../../hooks/useDispositionSubmit';

export interface AgencyConsoleState {
  station: UseAgencyStationResult;
  clock: ServerClock;
  /**
   * The agent's two-way audio. Exposed whole rather than flattened because the
   * page renders three of its fields (mute, mic state, the failure notice) and
   * a fourth exists only to be called from the console's own effect.
   */
  audio: AgencyAudioState;
  /**
   * The cue that must be shown **visually** because the audible one could not carry
   * it — a muted console, or an `AudioContext` the browser will not run.
   *
   * Not redundancy for a hearing agent with working sound: for anyone else this is
   * the whole channel, which is why it fires *before* the audio in the dispatcher,
   * why it carries the attempt id rather than a bare boolean, and why it names
   * **which** cue. All three get a visual, told apart by count, direction and
   * duration (`VISUAL_CUE_SPECS`) — a single shared flash would tell the agent that
   * something happened and not what, which is what this fixes.
   */
  cueFlash: CueFlash | null;
  /**
   * The connect half of `cueFlash`. Connect, and only connect, additionally lights
   * the whole console shell.
   */
  connectFlashAttemptId: string | null;
  /** The agent's cue settings, and the setter behind the Sound & flash popover. */
  cuePrefs: CuePrefs;
  setCuePrefs: (next: CuePrefs) => void;

  /** Live catalog — bootstrap's, or an `allowed_codes` rebuild. */
  catalog: AgencyDisposition[];
  breakReasons: AgencyBreakReason[];
  breakReasonLabel: string | null;

  form: DispositionFormState;
  setForm: (next: DispositionFormState) => void;
  /** See `DispositionSubmitState.blockAt` — evaluated at the reader's own present. */
  blockAt: (now: number) => DispositionBlockReason | null;
  blockChangesWithTime: boolean;
  padEnabled: boolean;
  padDisabledReason: string | null;
  padRejection: string | null;
  keysRemapped: boolean;
  submitting: boolean;
  dispositionSubmitted: boolean;
  submit: () => void;
  /**
   * Tells the hook whether the code about to be submitted was picked with a
   * number key or with a click — local, analytics-only bookkeeping read by
   * `submit()` at fire time and reset to `'click'` whenever a new attempt
   * resets the form.
   */
  noteCodeSelectionMethod: (method: 'number_key' | 'click') => void;
  /**
   * set only after `AGENT_STATE_RECONCILE_MS` of silence following a
   * saved disposition, and only when the response carried no usable advisory
   * state. Non-null means the pad is locked so the same attempt cannot be
   * submitted twice into the gap.
   */
  waitingForDialer: string | null;

  notes: string;
  onNotesEdit: (value: string) => void;
  notesStatusLine: NotesStatus;
  notesForeignWrite: boolean;
  notesEnabled: boolean;
  notesDisabledReason: string | null;

  presenceBusy: boolean;
  /**
   * The API's refusal of a presence change, stated. Non-null is a *response* the
   * agent can act on — most importantly 409 `attempt_not_dispositionable`, the
   * refusal that makes a required disposition mandatory — never an error banner.
   */
  presenceRefusal: string | null;
  /** `method` is analytics-only — which input triggered the change. */
  goAvailable: (method?: 'shortcut' | 'click') => void;
  endBreak: (method?: 'shortcut' | 'click') => void;
  requestBreak: (code: string) => void;
  breakRejection: string | null;
  breakBusy: boolean;
  pendingBreakLabel: string | null;
  cancelBreak: () => void;
  cancelling: boolean;
  cancelFailed: boolean;
  breakAlreadyStarted: boolean;
  /** The queued break is the soft-phone switch (SP7): the pill says "Switching after this call". */
  pendingSoftphone: boolean;
  /** Switch this campaign session to the soft phone (`POST /sessions/:id/softphone`). */
  requestSoftphone: () => void;
  softphoneRejection: string | null;

  /** Non-blocking line in the idle slot after the next call completes. */
  lostDispositionNotice: string | null;
  announcement: string;
}

export function useAgencyConsole(
  bootstrap: AgencySessionBootstrap | null,
  tenantId: string | undefined,
  accountId: string | undefined,
): AgencyConsoleState {
  /**
   * **Declared before the station, and it has to be.** The station needs the
   * audio sink at construction (a sink handed in later would miss the frames
   * that arrive first), while the audio lifecycle is driven from station state
   * that does not exist yet. The sink is stable and the gates are pushed in
   * afterwards through `sync`, which is what breaks the circle.
   */
  const audio = useAgencyAudio(bootstrap?.campaign_id);

  /**
   * **The connect cue, declared here for the same reason as the audio sink.** The
   * station needs the dispatcher at construction — a dispatcher handed in later
   * would miss the `bridged` that matters most, the first one. The diagnostics log
   * both of them write to is created here, ahead of either, and handed to both:
   * that is what breaks the circle (it used to be the station's own state array,
   * reached through a ref pointed at it after the fact and pushed into in place).
   *
   * `CueDispatcher` and `WebAudioCueSink` were built and tested with **no caller
   * at all** until this line: `cues` was simply omitted here, so an agent on a
   * power dialer heard nothing when a call connected.
   */
  const diagnosticsRef = useRef<DiagnosticsLog | null>(null);
  if (diagnosticsRef.current === null) diagnosticsRef.current = new DiagnosticsLog();
  const diagnostics = diagnosticsRef.current;
  const cues = useAgencyCues(diagnostics);

  const station = useAgencyStation(bootstrap, {
    tenantId,
    accountId,
    audio: audio.sink,
    cues: cues.dispatcher,
    diagnostics,
  });
  const {
    agentState,
    agentStateSince,
    connection,
    live,
    retainedAttempt,
    release,
    releasedAt,
    wrapup,
    currentAttemptId,
    clockOffsetMs,
  } = station;

  /**
   * Stable for a given offset, and it does not repaint anything: the timers that
   * count run their own repaint (see `useServerClock`), so this hook — and the
   * page it drives — re-renders on frames and actions, not four times a second.
   */
  const clock = useServerClock(clockOffsetMs);

  const gate = padGate({
    connection,
    agentState,
    live,
    retainedAttempt,
    release,
    wrapup,
  });
  const { stationIsGone, notesEnabled } = gate;

  /**
   * The audio gates (§ `useAgencyAudio`). Keyed on `live`'s two fields and
   * nothing else:
   *
   * - **`attempt_id`** arms the microphone. `live` is set by `reserved`, so the
   *   mic opens ~4s before the customer can answer and `getUserMedia` is not on
   *   the critical path of somebody saying "hello".
   * - **`bridgedAt`** opens the uplink, and it is `bridged`'s field alone.
   *   Deriving this from `agentState === 'on_call'` or from a bridge `status`
   *   frame would put the agent's voice on the wire before audio is actually
   *   flowing to their socket — the same class of mistake as firing the connect
   *   cue on `answered`.
   *
   * `retainedAttempt` is deliberately absent: wrap-up keeps the *panel* up, not
   * the call. A console still capturing through wrap-up would hold the mic while
   * the agent types a note about the customer who has hung up.
   *
   * ── The third input: a station that is never coming back ────────────────────
   * `stationIsGone`, from the pad gate — see `utils/agencyPadGate` for why
   * `disconnected` is in it and `reconnecting` is not.
   */
  /*
   * ── The soft phone rides the same gates ─────────────────────────────────────
   * A campaign session switched to the soft phone (SP7) places its calls on THIS
   * socket, so the same microphone and playback serve them: `audioTarget` arms on
   * a manual call's dial and opens the uplink on its `bridged_at`, exactly as it
   * does for an attempt's `reserved` and `bridged`. One `sync`, one owner — a
   * second effect syncing the soft phone would fight this one for the mic.
   */
  const target = audioTarget({ stationIsGone, live, manualCall: station.manualCall });
  useEffect(() => {
    audio.sync({
      attemptId: target.id,
      bridged: target.bridged,
      send: station.sendMedia,
    });
    // `audio.sync` and not `audio`: the hook returns a fresh object each render,
    // so depending on the whole thing would re-run this on every repaint of the
    // console. `sync` itself is memoized and stable for the shift.
  }, [audio.sync, target.id, target.bridged, station.sendMedia]);

  const [announcement, setAnnouncement] = useState('');
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [presenceRefusal, setPresenceRefusal] = useState<string | null>(null);

  /**
   * The refusal described the state we were in. A transition retires it, and
   * leaving it on screen would tell an agent who is now available that they
   * still owe a disposition. Keyed on `since` as well, for the same reason the
   * dialer wait is (`useDispositionSubmit`): only a transition is evidence.
   */
  useEffect(() => {
    setPresenceRefusal(null);
  }, [agentState, agentStateSince]);

  const notes = useAgencyNotes({
    bootstrap,
    tenantId,
    accountId,
    currentAttemptId,
    acceptingWrites: notesEnabled,
  });

  /**
   * The break queue writes to the pad's remap warning, and the submit clears the
   * queue on a promoted break — so each is handed the other's stable setter
   * through a ref, and neither has to be declared first.
   */
  const keysRemappedSink = useRef<(remapped: boolean) => void>(() => {});
  const onBreakKeysRemapped = useCallback(
    (remapped: boolean) => keysRemappedSink.current(remapped),
    [],
  );
  const breaks = useBreakQueue({
    bootstrap,
    tenantId,
    accountId,
    agentState,
    stationPendingBreakCode: station.pendingBreakCode,
    stationPendingBreakStatements: station.pendingBreakStatements,
    onKeysRemapped: onBreakKeysRemapped,
    announce: setAnnouncement,
  });

  const disposition = useDispositionSubmit({
    bootstrap,
    tenantId,
    accountId,
    station,
    clock,
    diagnostics,
    notes: notes.notes,
    notesRef: notes.currentRef,
    announce: setAnnouncement,
    onBreakPromoted: breaks.clearQueuedBreak,
  });
  keysRemappedSink.current = disposition.noteKeysRemapped;

  const padEnabled = gate.padUnlocked && disposition.waitingForDialer === null;

  // ── Presence ──────────────────────────────────────────────────────────────
  const goAvailable = useCallback(
    async (
      method: 'shortcut' | 'click' = 'click',
      action: 'go_available' | 'end_break' = 'go_available',
    ) => {
    if (!bootstrap) return;
    /**
     * **The microphone pre-flight, on the shift's one reliable user gesture.**
     *
     * Every browser gates `getUserMedia`'s prompt and an `AudioContext`'s ability
     * to make sound on a user gesture, and "Go available" is the only click an
     * agent reliably makes while *not* on a call. Probing here means a blocked
     * microphone is discovered with nobody on the line; probing at `bridged`
     * would mean discovering it while a customer says hello into a console that
     * cannot hear them and cannot be heard.
     *
     * Fire-and-forget, and deliberately *before* the request rather than after
     * its success: the two are independent, and an agent whose presence change
     * is refused for an outstanding disposition still needs to know their
     * microphone is blocked.
     */
    audio.preflight();
    /**
     * **The cue's `AudioContext` unlocks on the same click, and it has to.** Every
     * browser refuses to make sound from a context that was not created inside a
     * user gesture, and this is the shift's one reliable click with nobody on the
     * line. Unlocking at `bridged` instead would mean discovering the refusal
     * during the call the cue exists to announce — and the agent would never know,
     * because a cue that does not play is indistinguishable from one that has not
     * fired yet. Idempotent, and beside `preflight()` because they are the same
     * bargain with the same gesture.
     */
    cues.unlock();
    setPresenceBusy(true);
    breaks.clearBreakAlreadyStarted();
    setPresenceRefusal(null);
    try {
      await setAgentAvailable(bootstrap.session_id, tenantId, accountId);
      trackAgencyPresenceChanged({ campaign_id: bootstrap.campaign_id, action, method });
    } catch (err) {
      /**
       * **A refusal here is a response, not an error state.**
       *
       * The API's `/sessions/:id/available` answers **409 `attempt_not_dispositionable`**
       * while a required disposition is outstanding (`agency.routes.ts`), and
       * that refusal is the entire mechanism making a disposition mandatory —
       * collapse "I'm ready" into "I'm done writing up" and an agent skips every
       * one. The server forwards it unchanged rather than mirroring the rule, and the
       * code survives the error mask, so it arrives here intact.
       *
       * Swallowing it — which this handler did — is the worst of the options: the
       * agent presses the control, nothing happens, nothing is said, and the only
       * reading available to them is that the product is broken. The remedy is one
       * sentence and the API already wrote it.
       *
       * The `message` is shown as received rather than as console copy: no spec string exists for this
       * path ( requires *a* stated reason and does not supply one), and
       * inventing normative copy is the designer's call, not mine. It reads
       * correctly today — "Submit a disposition for your last call before going
       * available." — and `no_station` likewise.
       */
      const body = errorBody(err);
      setPresenceRefusal(
        body?.message ?? 'That didn’t go through. Try again in a moment.',
      );
      trackAgencyPresenceRefused({ campaign_id: bootstrap.campaign_id, action, code: body?.code ?? null });
    } finally {
      setPresenceBusy(false);
    }
    },
    [bootstrap, tenantId, accountId, audio.preflight, cues.unlock, breaks.clearBreakAlreadyStarted],
  );

  const labelFor = (code: string | null) =>
    code === null
      ? null
      : code === SOFTPHONE_BREAK_REASON
        // Reserved: never in a campaign's `break_reasons`, so it has no catalog label.
        ? SOFTPHONE_BREAK_REASON_LABEL
        : (breaks.breakReasons.find((r) => r.code === code)?.label ?? code);

  return {
    station,
    clock,
    audio,
    cueFlash: cues.cueFlash,
    connectFlashAttemptId: cues.connectFlashAttemptId,
    cuePrefs: cues.prefs,
    setCuePrefs: cues.setPrefs,
    catalog: disposition.catalog,
    breakReasons: breaks.breakReasons,
    breakReasonLabel: labelFor(station.breakReasonCode),
    form: disposition.form,
    setForm: disposition.setForm,
    blockAt: disposition.blockAt,
    blockChangesWithTime: disposition.blockChangesWithTime,
    padEnabled,
    // A disabled control always carries a *true* stated reason. "available when
    // connected" is a lie once the pad is locked because the save landed and the
    // dialer has gone quiet.
    padDisabledReason: padEnabled ? null : (disposition.waitingForDialer ?? PAD_DISABLED_COPY),
    padRejection: disposition.padRejection,
    keysRemapped: disposition.keysRemapped,
    submitting: disposition.submitting,
    dispositionSubmitted: disposition.dispositionSubmitted,
    submit: disposition.submit,
    noteCodeSelectionMethod: disposition.noteCodeSelectionMethod,
    waitingForDialer: disposition.waitingForDialer,
    notes: notes.notes,
    onNotesEdit: notes.onNotesEdit,
    notesStatusLine: notes.statusLine,
    notesForeignWrite: notes.foreignWrite,
    notesEnabled,
    notesDisabledReason: notesEnabled ? null : NOTES_DISABLED_COPY,
    presenceBusy,
    presenceRefusal,
    goAvailable: (method?: 'shortcut' | 'click') => void goAvailable(method),
    endBreak: (method?: 'shortcut' | 'click') => void goAvailable(method, 'end_break'),
    requestBreak: breaks.requestBreak,
    breakRejection: breaks.breakRejection,
    breakBusy: breaks.breakBusy,
    pendingBreakLabel: labelFor(breaks.pendingBreakCode),
    cancelBreak: breaks.cancelBreak,
    cancelling: breaks.cancelling,
    cancelFailed: breaks.cancelFailed,
    breakAlreadyStarted: breaks.breakAlreadyStarted,
    pendingSoftphone: breaks.pendingBreakCode === SOFTPHONE_BREAK_REASON,
    requestSoftphone: breaks.requestSoftphone,
    softphoneRejection: breaks.softphoneRejection,
    lostDispositionNotice: disposition.lostDispositionNotice,
    announcement,
  };
}
