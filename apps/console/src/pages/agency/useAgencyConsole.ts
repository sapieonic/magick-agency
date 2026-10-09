import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  setAgentAvailable,
  setAgentBreak,
  cancelQueuedBreak,
  submitDisposition,
  saveAttemptNotes,
} from '../../api/agency';
import {
  useAgencyStation,
  type DiagnosticEntry,
  type UseAgencyStationResult,
} from '../../hooks/useAgencyStation';
import { useAgencyAudio, type AgencyAudioState } from '../../hooks/useAgencyAudio';
import { useAgencyCues, type CueFlash } from '../../hooks/useAgencyCues';
import type { CuePrefs } from '../../utils/agencyCuePrefs';
import { useServerClock, type ServerClock } from '../../hooks/useServerClock';
import {
  EMPTY_DISPOSITION_FORM,
  blockReason,
  buildSubmitPayload,
  findDisposition,
  type DispositionFormState,
  type DispositionBlockReason,
} from '../../utils/agencyDispositionForm';
import { confirmationCopy, handleSubmitResponse } from '../../utils/agencyDispositionSubmit';
import { advisoryAgentState, describeDiscard } from '../../utils/agencyStaleResponse';
import {
  notesStatus,
  notesStorageKey,
  sweepStaleNoteKeys,
  type NotesStatus,
} from '../../utils/agencyNotes';
import { resyncCatalog, selectionAfterResync, numberKeysRemapped } from '../../utils/agencyCatalogSync';
import { CATALOG_CHANGED_COPY, NUMBER_KEY_COUNT } from '../../components/agency/DispositionPad';
import { BREAK_REJECTED_COPY } from '../../components/agency/BreakMenu';
import {
  trackAgencyDispositionSubmitted,
  trackAgencyDispositionFailed,
  trackAgencyWaitingForDialer,
  trackAgencyPresenceChanged,
  trackAgencyPresenceRefused,
  trackAgencyBreakRequested,
  trackAgencyBreakRejected,
  trackAgencyQueuedBreakResolved,
  trackAgencyNotesSaveFailed,
  trackAgencyStaleResponseDiscarded,
} from '../../analytics/events';
import type {
  AgencyActionErrorResponse,
  AgencyAgentState,
  AgencyBreakReason,
  AgencyDisposition,
  AgencyDispositionResponse,
  AgencySessionBootstrap,
} from '../../types/agency';

/**
 * The Agent Console's wiring, extracted from the page so the state machine is
 * testable without a DOM and the page stays markup.
 *
 * Everything here is composition of already-tested primitives. The value it adds is
 * the *sequencing* — which is where the remaining Phase 2 traps live, since each one
 * is an ordering or lifecycle rule that no individual module can enforce alone.
 */

/** Debounce for the notes autosave. */
export const NOTES_DEBOUNCE_MS = 2000;
/** How long we wait for `agent_state` before reconciling from the response. */
export const AGENT_STATE_RECONCILE_MS = 3000;

/**
 * The copy for a disposition submitted with no `agent_state` following it.
 *
 * Exported so the test names the string once: a copy assertion written out by hand
 * in the test is a test of the test.
 */
export const WAITING_FOR_DIALER_COPY = 'Saved — waiting for the dialer to move you on';

const NOTES_DISABLED_COPY = 'Notes open when a call connects.';
const PAD_DISABLED_COPY = 'available when connected';

const AGENT_STATES: readonly AgencyAgentState[] = [
  'offline',
  'available',
  'reserved',
  'on_call',
  'wrapup',
  'break',
];

/**
 * The advisory `agent_state` off a disposition response, read defensively.
 *
 * `AgencyDispositionResponse` types `agent_state` as required, but's row
 * has an explicit *"if that is also absent"* arm — so the absence has to be
 * representable at runtime or that arm is unreachable and its copy is dead. A body
 * missing the field, or carrying a state outside the union, yields `null` and the
 * console falls to the waiting treatment rather than reconciling from a value it
 * cannot interpret.
 */
function readAdvisory(
  body: unknown,
): Pick<AgencyDispositionResponse, 'attempt_id' | 'agent_state'> | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const attemptId = record['attempt_id'];
  const state = record['agent_state'];
  if (typeof attemptId !== 'string') return null;
  if (typeof state !== 'string' || !AGENT_STATES.includes(state as AgencyAgentState)) return null;
  return { attempt_id: attemptId, agent_state: state as AgencyAgentState };
}

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
  block: DispositionBlockReason | null;
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

  /** Non-blocking line in the idle slot after the next call completes. */
  lostDispositionNotice: string | null;
  announcement: string;
}

/**
 * Read the agency error envelope off whatever `apiFetch` threw.
 *
 * **`details`, not `body`.** `ApiError` (`src/api/client.ts`) carries `statusCode`
 * and `details`; there is no `body` field on it and never was. Reading `body` made
 * every agency failure look like an empty 400 in production: the 409
 * disposition-required refusal never surfaced the API's message, and
 * `unknown_disposition_code` / `unknown_break_reason` never delivered their
 * `allowed_codes`, which is the only way the console can resync a stale catalog.
 * `dncFailureCopy` in `utils/agencyDncCopy.ts` already read `details` — this file
 * was the one disagreeing.
 */
function errorBody(err: unknown): AgencyActionErrorResponse | null {
  if (!err || typeof err !== 'object') return null;
  const body = (err as { details?: unknown }).details;
  if (body && typeof body === 'object' && 'code' in body) return body as AgencyActionErrorResponse;
  return null;
}

/** The HTTP status off an `ApiError`. `statusCode`, for the same reason as above. */
function errorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : null;
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
   * would miss the `bridged` that matters most, the first one — while the
   * diagnostics buffer it logs into belongs to the station that does not exist
   * yet. The ref below is what breaks that circle, pointed at the station's buffer
   * one line after it is created.
   *
   * `CueDispatcher` and `WebAudioCueSink` were built and tested with **no caller
   * at all** until this line: `cues` was simply omitted here, so an agent on a
   * power dialer heard nothing when a call connected.
   */
  const cueDiagnostics = useRef<DiagnosticEntry[] | null>(null);
  const cues = useAgencyCues(cueDiagnostics);

  const station = useAgencyStation(bootstrap, {
    tenantId,
    accountId,
    audio: audio.sink,
    cues: cues.dispatcher,
  });
  cueDiagnostics.current = station.diagnostics;
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

  const clock = useServerClock(clockOffsetMs);

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
   * `live` is cleared by `released` and by nothing else. A **terminal** close
   * never touches it — `useAgencyStation`'s `onclose` sets `session_gone` (4404)
   * or `superseded` (4409) and returns — and the page renders a message rather
   * than unmounting. So on the ordinary "agent opens the console in a second
   * tab" path, tab 1 sat there with `live` still set, still capturing, for as
   * long as the tab existed: microphone held, recording indicator lit, and the
   * only control offered was Mute, which does not release the device.
   *
   * Terminal and **not** `reconnecting`: a reconnect is the case the uplink is
   * built to survive (`sendMedia` reads the socket ref at send time), and
   * dropping the microphone on a wifi blip would turn a recoverable gap into a
   * re-prompt mid-conversation.
   */
  /**
   * `disconnected` is included, and it is the one arm worth arguing. The comment
   * above turns on "terminal and not `reconnecting`", and `disconnected` is
   * terminal in exactly that sense: the console has stopped retrying and is
   * waiting for the agent — so holding the microphone open on it is precisely the
   * defect this predicate was written to fix.
   *
   * It is **not** the wifi blip the exclusion protects, but not for the reason an
   * earlier version of this comment gave. It claimed "30 s of silence or a minute
   * of flapping"; the flap arm has no minimum duration — six proven-live sockets
   * can die inside a few seconds — and the heartbeat arm now refuses to fire at
   * all while a call is live (`useAgencyStation`'s give-up guard). So what makes
   * this safe is that neither arm can be reached by a recoverable gap on a live
   * call, not that either takes a long time.
   */
  const stationIsGone =
    connection === 'session_gone' || connection === 'superseded' || connection === 'disconnected';
  /**
   * The narrower question the disposition pad asks: is there another authority for
   * this session that our write could collide with?
   *
   * `stationIsGone` is the right test for MEDIA — no audio may flow on a socket
   * that is not there — and the wrong one for the pad, which is HTTP and does not
   * need the socket at all. The three states differ in the way that decides it:
   *
   *  * `superseded` — another window holds the session, has its own pad, and ours
   *    may still *land*, racing theirs. That is's hazard. Lock.
   *  * `session_gone` — the API says the session does not exist, so the write would
   *    404 and a disabled control is the honest rendering of that. Lock.
   *  * `disconnected` — our socket died and NOTHING replaced it. There is no rival
   *    pad, the routes still work, and the agent may be mid-wrap-up with a
   *    countdown running. Locking here puts the only artefact of the call behind a
   *    control disabled for a reason that does not apply, and makes submitting a
   *    required disposition conditional on reconnecting inside a time-limited
   *    window. Leave it usable.
   *
   * This is the ordinary case rather than a corner, which is what makes it worth
   * the split: the heartbeat hold defers its give-up until `released` clears
   * `live`, so `disconnected` arrives at the START of wrap-up more often than at
   * any other moment in a shift.
   */
  const padHasRival = connection === 'session_gone' || connection === 'superseded';

  useEffect(() => {
    audio.sync({
      attemptId: stationIsGone ? null : (live?.attempt.attempt_id ?? null),
      bridged: !stationIsGone && live?.bridgedAt != null,
      send: station.sendMedia,
    });
    // `audio.sync` and not `audio`: the hook returns a fresh object each render,
    // so depending on the whole thing would re-run this on every repaint of the
    // console. `sync` itself is memoized and stable for the shift.
  }, [audio.sync, stationIsGone, live?.attempt.attempt_id, live?.bridgedAt, station.sendMedia]);

  const [catalog, setCatalog] = useState<AgencyDisposition[]>([]);
  const [breakReasons, setBreakReasons] = useState<AgencyBreakReason[]>([]);
  const [form, setFormState] = useState<DispositionFormState>(EMPTY_DISPOSITION_FORM);
  const [padRejection, setPadRejection] = useState<string | null>(null);
  const [keysRemapped, setKeysRemapped] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** Synchronous companion to `submitting` — see the guard at the top of `submit`. */
  const submitInFlight = useRef(false);
  /**
   * Analytics-only bookkeeping: which input picked the code about to be
   * submitted. Set by the page via `noteCodeSelectionMethod` when a number key
   * fires, read at fire time in `submit()`, and reset to `'click'` whenever a
   * new attempt resets the form — a ref rather than state because nothing here
   * renders off it.
   */
  const selectionMethodRef = useRef<'number_key' | 'click'>('click');
  const [dispositionSubmitted, setDispositionSubmitted] = useState(false);
  const [waitingForDialer, setWaitingForDialer] = useState<string | null>(null);
  const [lostDispositionNotice, setLostDispositionNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const [notes, setNotes] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [lastKeystrokeAt, setLastKeystrokeAt] = useState<number | null>(null);
  const [lastSaveSucceededAt, setLastSaveSucceededAt] = useState<number | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [notesInFlight, setNotesInFlight] = useState(false);
  const [notesFailure, setNotesFailure] = useState<'retryable' | 'terminal' | null>(null);
  const [notesForeignWrite, setNotesForeignWrite] = useState(false);

  const [presenceBusy, setPresenceBusy] = useState(false);
  const [presenceRefusal, setPresenceRefusal] = useState<string | null>(null);
  const [breakBusy, setBreakBusy] = useState(false);
  const [breakRejection, setBreakRejection] = useState<string | null>(null);
  const [pendingBreakCode, setPendingBreakCode] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const [breakAlreadyStarted, setBreakAlreadyStarted] = useState(false);

  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The save the debounce is holding, tagged with the attempt it belongs to. */
  const pendingNotes = useRef<{ attemptId: string; hydrated: boolean; value: string } | null>(null);
  const notesRef = useRef({ notes, hydrated, attemptId: currentAttemptId });
  notesRef.current = { notes, hydrated, attemptId: currentAttemptId };

  /**
   * The reconciliation window's view of the station, read at **fire time**.
   *
   * A ref rather than a closure variable, and the distinction is the whole point:
   * `submit`'s closure captures whatever `station` was at the render that built the
   * callback, so a check written against it compares the state 3s from now against
   * a value that is already stale — and it fails *open*, announcing "waiting for
   * the dialer" while the dialer has in fact already moved the agent on.
   */
  const stationRef = useRef(station);
  stationRef.current = station;

  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!bootstrap) return;
    setCatalog(bootstrap.disposition_catalog);
    // What bootstrap advertises IS the accepted set: the API serves its six built-ins
    // when the campaign configures none, so this is never empty in practice.
    setBreakReasons(bootstrap.break_reasons);
  }, [bootstrap]);

  /**
   * **Sweep note keys older than 24h at boot.** 200 calls a day against a
   * never-pruned namespace eventually trips the storage quota, and a quota error
   * mid-shift surfaces as "notes stopped saving" with no explanation anywhere.
   */
  useEffect(() => {
    try {
      sweepStaleNoteKeys(window.localStorage, Date.now());
    } catch {
      // A storage failure at boot must not stop the console opening.
    }
  }, []);

  // ── Notes lifecycle, keyed by attempt ─────────────────────────────────────
  /**
   * Hydration. **Nothing may autosave before this completes** — a save racing the
   * restore step sends `''` and clears the server copy, and the agent then watches
   * their notes vanish from a field they were reading.
   */
  useEffect(() => {
    setHydrated(false);
    setNotesForeignWrite(false);
    setNotesFailure(null);
    setLastKeystrokeAt(null);
    setLastSaveSucceededAt(null);
    setLastUpdatedAt(null);

    if (currentAttemptId === null) {
      setNotes('');
      return;
    }

    let restored = '';
    try {
      const raw = window.localStorage.getItem(notesStorageKey(currentAttemptId));
      if (raw) restored = (JSON.parse(raw) as { notes?: string }).notes ?? '';
    } catch {
      restored = '';
    }
    setNotes(restored);
    setHydrated(true);
  }, [currentAttemptId]);

  /** A new attempt resets the form. The catalog rejection goes with it. */
  useEffect(() => {
    setFormState(EMPTY_DISPOSITION_FORM);
    setPadRejection(null);
    setKeysRemapped(false);
    setDispositionSubmitted(false);
    // Analytics-only: the next code picked on this attempt starts as 'click'
    // until a number key says otherwise.
    selectionMethodRef.current = 'click';
    /**
     * The waiting line is about the attempt that just ended. Carried into the next
     * one it would lock a pad the agent needs for a customer already talking.
     *
     * This clears a line **already rendered**; it deliberately does not cancel the
     * pending timer, which guard (1) below refuses on its own. Doing both would
     * leave that guard unable to fail — and a guard that cannot fail reads as a
     * defended property when the defence is somewhere else entirely.
     */
    setWaitingForDialer(null);
  }, [currentAttemptId]);

  /**
   * **`agent_state` is the authority, so its arrival ends the wait** — whatever it
   * says. Keyed on `since` as well as the state because a transition always moves
   * `since`, while two frames for the same state do not, and only a transition is
   * evidence the dialer acted.
   */
  useEffect(() => {
    setWaitingForDialer(null);
    // The refusal described the state we were in. A transition retires it, and
    // leaving it on screen would tell an agent who is now available that they
    // still owe a disposition.
    setPresenceRefusal(null);
  }, [agentState, agentStateSince]);

  useEffect(
    () => () => {
      if (reconcileTimer.current !== null) clearTimeout(reconcileTimer.current);
    },
    [],
  );

  /**
   * The debounced save, keyed on the attempt that was on screen **when the agent
   * typed** — never the one live when the timer fires.
   *
   * Reading `notesRef.current.attemptId` here instead was cross-contact
   * contamination on a replace-semantics endpoint: a timer armed during attempt A
   * that fires after a new `reserved` for B sent A's closed-over text to B's notes
   * route, overwriting whatever B had. `hydrated` travels in the snapshot for the
   * same reason — it describes A's load, not B's.
   *
   * The UI setters are then guarded, because a late save for A must not paint its
   * result over the notes status line the agent is reading about B.
   */
  const flushNotes = useCallback(
    async (pending: { attemptId: string; hydrated: boolean; value: string }) => {
      const { attemptId, hydrated: wasHydrated, value } = pending;
      const stillCurrent = () => notesRef.current.attemptId === attemptId;

      if (stillCurrent()) setNotesInFlight(true);
      try {
        // The guard lives INSIDE the client: there is no argument shape here that
        // sends an unchecked empty string. `agent_edit` is the only provenance the
        // field can produce, and it is what licenses a real clear.
        const outcome = await saveAttemptNotes(
          { hydrated: wasHydrated, notes: value, editSource: 'agent_edit', attemptId },
          tenantId,
          accountId,
        );
        if (!outcome.saved) return;
        if (!stillCurrent()) return;
        setLastSaveSucceededAt(Date.now());
        setLastUpdatedAt(outcome.response.updated_at);
        setNotesFailure(null);
        // Computed against what was SENT, never the live field — the client hands
        // back the answer so there is nothing here to compare wrongly.
        setNotesForeignWrite(outcome.foreignWrite);
      } catch {
        if (stillCurrent()) setNotesFailure('terminal');
        // `failure` is always 'terminal' here: this function has no retryable
        // failure state today — the field is reserved for one it doesn't
        // currently implement. `foreign_write` is always false for the same
        // reason: a foreign write is a successful save that also flags someone
        // else wrote first, not a failure, so it is never reported from this
        // catch.
        if (stillCurrent() && bootstrap) {
          trackAgencyNotesSaveFailed({
            campaign_id: bootstrap.campaign_id,
            failure: 'terminal',
            foreign_write: false,
          });
        }
      } finally {
        if (stillCurrent()) setNotesInFlight(false);
      }
    },
    [tenantId, accountId, bootstrap],
  );

  const onNotesEdit = useCallback(
    (value: string) => {
      setNotes(value);
      setLastKeystrokeAt(Date.now());
      // The local buffer is the failure buffer, not the durability story: invisible
      // when things work, and what makes the two failure rows honest.
      const attemptId = notesRef.current.attemptId;
      if (attemptId !== null) {
        try {
          window.localStorage.setItem(
            notesStorageKey(attemptId),
            JSON.stringify({ notes: value, at: Date.now() }),
          );
        } catch {
          // Quota. The server save is still attempted.
        }
      }
      if (notesTimer.current !== null) clearTimeout(notesTimer.current);
      if (attemptId === null) return;
      // Snapshot, not a live read — see `flushNotes`.
      const pending = { attemptId, hydrated: notesRef.current.hydrated, value };
      pendingNotes.current = pending;
      notesTimer.current = setTimeout(() => {
        pendingNotes.current = null;
        void flushNotes(pending);
      }, NOTES_DEBOUNCE_MS);
    },
    [flushNotes],
  );

  /**
   * A new attempt **flushes** the pending save rather than cancelling it.
   *
   * Cancelling would silently drop whatever the agent typed in the last
   * `NOTES_DEBOUNCE_MS` of the previous call — the one moment they are most likely
   * to be writing the outcome down. The snapshot carries the old attempt id, so the
   * write lands on the call it was written about.
   */
  useEffect(() => {
    const pending = pendingNotes.current;
    if (pending === null || pending.attemptId === currentAttemptId) return;
    if (notesTimer.current !== null) clearTimeout(notesTimer.current);
    notesTimer.current = null;
    pendingNotes.current = null;
    void flushNotes(pending);
  }, [currentAttemptId, flushNotes]);

  useEffect(
    () => () => {
      if (notesTimer.current !== null) clearTimeout(notesTimer.current);
    },
    [],
  );

  // ── Disposition ───────────────────────────────────────────────────────────
  /**
   * Frame-bound, : `bridged` opens the pad, and it stays open through a
   * `released` that requires a disposition. Nothing here reads `status`/`ended`.
   *
   * ── Three routes in, one latch out ──────────────────────────────────────────
   * The wrap-up unlock used to rest solely on `agent_state{state:'wrapup'}`, a
   * frame the API did not emit at all until this week. When it was missing the pad
   * greyed out the instant the call ended and stayed grey — `/available` then 409s
   * `attempt_not_dispositionable` and the agent is stuck until the sweep closes
   * the attempt, so **every disposition on a `requires_disposition` campaign was
   * lost that way**. One frame should not be able to do that again, so wrap-up is
   * derived from three independent sources and any one of them suffices:
   *
   *  (a) `agent_state` says `wrapup` — the frame path, now that the API sends it;
   *  (b) the `released` frame said `requires_disposition` — available *before*
   *      `agent_state` on the API's own ordering (`released` → `agent_state` →
   *      `wrapup`), so it opens the pad a tick earlier and survives that frame
   *      going missing entirely;
   *  (c) a wrap-up anchor exists and requires a disposition — the only route a
   *      socket that reconnected mid-wrap-up has, because `ready.active_wrapup`
   *      arrives with no attempt payload and no `released` behind it.
   *
   * ── Why they cannot disagree into a stuck pad ───────────────────────────────
   * A pad that never locks is a different bug, not a fix, so the three routes
   * share their OFF switches rather than each owning one. (a) and (b) are both
   * gated on `retainedAttempt`, and (c) on `wrapup`, and **all three fields are
   * cleared by every frame that can end a wrap-up**:
   *
   *   - `agent_state` with `state !== 'wrapup'` ('s single authority),
   *   - `reserved` (a new reservation always wins),
   *   - **`ready` with `state !== 'wrapup'`** — and this third one was missing.
   *
   * That omission was a real unlock over a closed window, not a theoretical one.
   * `released{requires_disposition:true}` → socket drops → the wrap-up lapses
   * server-side → the API emits `agent_state{available}` into the dead socket →
   * reconnect. `ready` restored `agentState` and touched nothing else, so (a) went
   * off while (b) stayed **on** — pad enabled, `currentAttemptId` still the
   * finished attempt. The agent wrote up a call into a window the API had closed and
   * the submit 409'd. Since `ready` is a full-state snapshot the fix belongs
   * there, not in a fourth condition here; see the `ready` handler in
   * `useAgencyStation`.
   *
   * `missedRelease` is deliberately NOT a fourth route, and the reasoning is the
   * same one that makes the `ready` reconciliation necessary: it reports a call
   * that ended while the socket was away. When that call's wrap-up is still open
   * the API sends `active_wrapup` alongside it and (c) fires on its own; when it is
   * not, the API will refuse the disposition — so a pad unlocked from a
   * `missedRelease` would invite the agent to write into a window that has already
   * closed, which is exactly what the stale (b) was doing.
   */
  const inWrapupByState = retainedAttempt !== null && agentState === 'wrapup';
  const inWrapupByRelease =
    retainedAttempt !== null && release !== null && release.requires_disposition;
  const inWrapupByAnchor = wrapup !== null && wrapup.requiresDisposition;
  /**
   * ── A LOST STATION LOCKS THE PAD ───────────────────────────────────────────
   *
   * asks for the console behind the supersede screen to be inert, and says
   * why in one line: *"so there is no chance of the agent typing a note into a
   * dead tab."* Until this guard, `live` was cleared only by `released` — which a
   * terminal close never delivers — so a superseded window kept a fully enabled
   * disposition pad and a live notes autosave for a call it could no longer hear.
   *
   * That is worse than losing the note, because both routes are **HTTP**: the
   * session is still alive in the winning window, so the write may well *land*,
   * from a tab the product has declared dead, racing the other window's own pad.
   * Neither "lost" nor "saved" is an answer anyone would sign off.
   *
   * Newly reachable rather than theoretical: the API only started sending `4409` in
   * this same change, so `superseded` was previously almost unreachable.
   */
  const padUnlocked =
    !padHasRival
    && (Boolean(live?.bridgedAt) || inWrapupByState || inWrapupByRelease || inWrapupByAnchor);
  const padEnabled = padUnlocked && waitingForDialer === null;
  /**
   * **Notes track the window, not the lock.** The lock exists to stop a
   * second submit; the notes route is still accepted through wrap-up, and closing
   * the field would strand the agent's only artefact of the call behind a control
   * that was disabled for an unrelated reason.
   */
  const notesEnabled = padUnlocked;

  /**
   * Criterion (c)'s client half, **over the notes the submit will actually send**.
   *
   * The note lives in `notes` (written by `onNotesEdit`, the only thing that can
   * emit an agent edit) while the rest of the form lives in `form` — and `form.notes`
   * has no writer at all. So this used to be computed over a field that was
   * permanently `''`: for any `requires_note` code the block was `note_required`
   * forever, which meant **Save could never enable**, the stated reason "This
   * disposition needs a note" stayed on screen after the note was typed, and the
   * page's `Ctrl+Enter` was refused. What made it survive is that `NotesField` owns
   * its own `Ctrl+Enter` and calls `submit()` directly, and `submit()` already merges
   * the two the way this now does — so the one path an agent takes from inside the
   * field worked, and the button beside it did not.
   *
   * Merged identically to `buildSubmitPayload`'s own view (`notes || form.notes`), so
   * the visible block and the guard that builds the request cannot disagree; a
   * whitespace-only note fails `noteSatisfied`'s trim in both, which is what keeps the
   * client's rule the same rule the API enforces at `disposition.ts`.
   */
  const block = useMemo(
    () => blockReason(catalog, { ...form, notes: notes || form.notes }, clock.now),
    [catalog, form, notes, clock.now],
  );

  const notesStatusLine = useMemo(
    () =>
      notesStatus({
        notes,
        lastKeystrokeAt,
        lastSaveSucceededAt,
        lastUpdatedAt,
        inFlight: notesInFlight,
        failure: notesFailure,
        acceptingWrites: notesEnabled,
      }),
    [notes, lastKeystrokeAt, lastSaveSucceededAt, lastUpdatedAt, notesInFlight, notesFailure, notesEnabled],
  );

  const submit = useCallback(() => {
    /**
     * **The synchronous half of "double-submit is prevented twice".**
     *
     * `submitting` and `dispositionSubmitted` below are React state: both are set
     * inside this call and neither is readable by a *second call in the same task*.
     * One `Ctrl+Enter` inside the notes field is exactly that task — `NotesField`
     * owns the key and calls `submit()`, the event then bubbles to the page's window
     * handler which calls it again — so the two state guards let both requests go
     * out, and the API records whichever lands second against an attempt the first has
     * already dispositioned.
     *
     * A ref is the only guard that can see the first call from inside the second.
     * Released in the same `finally` that clears `submitting`, so a failed submit is
     * retryable exactly as before.
     */
    if (submitInFlight.current) return;
    if (submitting) return;
    /**
     *'s second half of "double-submit is prevented twice": a second success
     * for an attempt already recorded is **ignored rather than sent**. The first
     * half is the disabled button, and it is not enough on its own — `Ctrl+Enter`
     * reaches this function without going near the button.
     */
    if (dispositionSubmitted) return;
    const attemptId = currentAttemptId;
    if (attemptId === null) return;

    // Notes typed into the field travel with the disposition too, so a submit
    // never loses an un-flushed edit.
    const payload = buildSubmitPayload(catalog, { ...form, notes: notes || form.notes }, clock.now);
    if (payload === null) return;

    // Captured at submit time. `AgencyActionErrorResponse` carries NO `attempt_id`,
    // so the failing path — the one that leaks — has nothing in its body to key off.
    const inFlight = { attemptId };
    submitInFlight.current = true;
    setSubmitting(true);

    void (async () => {
      let raw: { status: number; body: unknown };
      try {
        const response = await submitDisposition(attemptId, payload, tenantId, accountId);
        raw = { status: 200, body: response };
      } catch (err) {
        const body = errorBody(err);
        raw = { status: errorStatus(err) ?? 400, body: body ?? {} };
      } finally {
        submitInFlight.current = false;
        setSubmitting(false);
      }

      // ONE door, and the stale guard is inside it, in front of the classifier.
      const outcome = handleSubmitResponse(inFlight, raw, notesRef.current.attemptId);

      switch (outcome.kind) {
        case 'discarded':
          // Never shown to the agent while they are on the next call: an alert about
          // customer A is worse than the loss it reports. It surfaces as one
          // non-blocking line in the idle slot after B completes.
          station.diagnostics.push({
            at: Date.now(),
            attemptId: inFlight.attemptId,
            event: 'disposition_discarded',
            detail: describeDiscard(inFlight, notesRef.current.attemptId, outcome.reason),
          });
          setLostDispositionNotice("The last call's disposition wasn't saved.");
          // `outcome.reason` is already the closed `StaleDiscardReason` union
          // (`'attempt_changed' | 'attempt_id_mismatch'`) — a direct pass-through,
          // never a guess.
          trackAgencyStaleResponseDiscarded({ surface: 'disposition', reason: outcome.reason });
          return;

        case 'saved': {
          setDispositionSubmitted(true);
          setPadRejection(null);

          if (bootstrap) {
            const submittedDisposition = findDisposition(catalog, payload.disposition_code);
            trackAgencyDispositionSubmitted({
              campaign_id: bootstrap.campaign_id,
              code_index: catalog.findIndex((d) => d.code === payload.disposition_code),
              is_success: submittedDisposition?.is_success ?? false,
              terminal: submittedDisposition?.terminal ?? false,
              suppress: submittedDisposition?.suppress ?? false,
              requires_note: submittedDisposition?.requires_note ?? false,
              requires_datetime: submittedDisposition?.requires_datetime ?? false,
              has_note: Boolean((notes || form.notes).trim()),
              scheduled_callback: outcome.nextAttemptAt != null,
              selection_method: selectionMethodRef.current,
              // `AgencyStationReleasedFrame` carries no timestamp of its own, so
              // `releasedAt` is the station hook's client-side stamp of when it
              // last saw a `released` frame — 0 when this attempt was never
              // released through this session (e.g. a required disposition
              // recovered via `ready.active_wrapup` after a reconnect, where the
              // hook never saw the `released` frame itself).
              seconds_to_submit:
                releasedAt !== null ? Math.max(0, Math.round((Date.now() - releasedAt) / 1000)) : 0,
            });
          }

          /**
           *'s "disposition submitted, no `agent_state` follows" row.
           *
           * The response's `agent_state` **races the socket by design** and is read
           * only through `advisoryAgentState()`, which refuses to hand it over once
           * the socket has spoken or once the attempt has moved on. Assigning it
           * unconditionally overwrites a fresh `reserved` with a stale `available`
           * and drops the panel for a customer who is already talking.
           *
           * Note what this does NOT do: it never writes the hint into the rail's
           * state. **`agent_state` remains the sole authority for the rail and for
           * wrap-up ending** ('s "Never by" column, which excludes this
           * response explicitly). The hint's licensed use is the queued-break case
           * names — the post-submit state may be `break`, not `available`,
           * and the pill's subject is gone once it is.
           *
           * **Two fire-time guards, and each one catches a case the other cannot.**
           * A third — refusing to arm unless the station still held the attempt —
           * was written and then removed: every scenario that would have tripped it
           * is already caught below, and a guard that cannot fail reads to a
           * reviewer as a property being defended when it is not.
           */
          const stateAtSave = {
            state: stationRef.current.agentState,
            since: stationRef.current.agentStateSince,
          };
          if (reconcileTimer.current !== null) clearTimeout(reconcileTimer.current);
          reconcileTimer.current = setTimeout(() => {
            reconcileTimer.current = null;
            const now = stationRef.current;

            /**
             * (1) The station is on a different attempt. Catches a `reserved` that
             * arrives **without** an accompanying `agent_state` — the console must
             * not depend on the two frames travelling together, and without this the
             * next customer's pad locks under a line about the previous one.
             */
            if (now.currentAttemptId !== inFlight.attemptId) return;

            /**
             * (2) An `agent_state` did follow. Catches the ordinary case where the
             * save lands mid-call and the release plus wrap-up frames arrive inside
             * the window: the attempt is unchanged, so (1) sees nothing, but a frame
             * demonstrably followed and the socket is the authority.
             */
            if (now.agentState !== stateAtSave.state || now.agentStateSince !== stateAtSave.since) {
              return;
            }

            /**
             * **The line is rendered in BOTH arms.**
             *
             * reads "reconcile from the response's `agent_state`; **if that
             * is also absent**, rail: …", which an earlier revision of this file
             * took as forbidding the copy in the reconcile arm. The agent cannot
             * tell "reconciled, still waiting" from "the frame never arrived" —
             * both are a wrap-up rail holding a saved disposition — so suppressing
             * it there produces exactly the dead end the copy exists to prevent.
             * The clause specifies the fallback, not a prohibition.
             *
             * **Placement and duplication are the coordinator's ruling, pending
             * designer ratification** (the string itself is the designer's). Called
             * out rather than blended into the spec citation so the judgement is
             * attributable: does not say this in as many words.
             */
            if (bootstrap) trackAgencyWaitingForDialer({ campaign_id: bootstrap.campaign_id });
            setWaitingForDialer(WAITING_FOR_DIALER_COPY);

            const advisory = readAdvisory(raw.body);
            const hint =
              advisory === null
                ? null
                : advisoryAgentState(inFlight, advisory, now.currentAttemptId, false);
            // Reconciliation, and only this: the queued break was promoted, so the
            // pill has no subject left. The rail is untouched.
            if (hint === 'break') setPendingBreakCode(null);
          }, AGENT_STATE_RECONCILE_MS);

          /**
           * **Cleared on a successful DISPOSITION submit — not on a successful note
           * save.** The note save is the more tempting hook and it is the wrong one:
           * the local copy exists precisely to survive a failed note save, so
           * clearing it there would throw away the buffer at the moment it is
           * needed.
           */
          try {
            window.localStorage.removeItem(notesStorageKey(inFlight.attemptId));
          } catch {
            /* nothing to do */
          }
          /**
           * the callback copy's confirmation, and the reason it is not a flat "Disposition
           * saved.": when the disposition scheduled a callback, the time the API
           * actually booked is the one thing the agent needs back — and
           * `confirmationCopy` is where the "we", never "I" rule lives. It had
           * **zero callers** until this line, so the shared-pool mitigation existed, was
           * tested, and never reached a screen.
           */
          setAnnouncement(
            confirmationCopy({
              dispositionLabel:
                findDisposition(catalog, payload.disposition_code)?.label ??
                payload.disposition_code,
              nextAttemptAt: outcome.nextAttemptAt,
              // The asked-for time,
              // so a callback moved into calling hours says so.
              callbackRequestedAt: outcome.callbackRequestedAt,
            }),
          );
          return;
        }

        case 'conflict':
          setPadRejection(
            outcome.recordedCode
              ? `This call is already recorded as ${findDisposition(catalog, outcome.recordedCode)?.label ?? outcome.recordedCode}.`
              : 'This call already has a different outcome recorded.',
          );
          if (bootstrap) {
            trackAgencyDispositionFailed({
              campaign_id: bootstrap.campaign_id,
              kind: 'conflict',
              // `DispositionOutcome`'s `conflict` variant carries no error code —
              // only `recordedCode`, which is a disposition code and not sendable.
              code: null,
              catalog_resynced: false,
              keys_remapped: false,
            });
          }
          return;

        case 'rejected': {
          let keysRemappedNow = false;
          if (outcome.code === 'unknown_disposition_code' && outcome.allowedCodes) {
            // One round trip. Never "contact support" while `allowed_codes` is
            // present — that copy is for errors with no recovery path.
            const next = resyncCatalog(catalog, outcome.allowedCodes);
            keysRemappedNow = numberKeysRemapped(catalog, next, NUMBER_KEY_COUNT);
            setKeysRemapped(keysRemappedNow);
            setCatalog(next);
            // null, never a neighbouring index: a highlight that looks unchanged
            // over a different value is how the wrong outcome gets recorded.
            setFormState((f) => ({ ...f, selectedCode: selectionAfterResync(f.selectedCode, next) }));
            setPadRejection(CATALOG_CHANGED_COPY);
          } else {
            setPadRejection(outcome.message);
          }
          // Nothing clears the notes on any error path.
          setAnnouncement(outcome.message);
          if (bootstrap) {
            trackAgencyDispositionFailed({
              campaign_id: bootstrap.campaign_id,
              kind: 'rejected',
              code: outcome.code,
              catalog_resynced: outcome.code === 'unknown_disposition_code' && Boolean(outcome.allowedCodes),
              keys_remapped: keysRemappedNow,
            });
          }
          return;
        }
      }
    })();
  }, [
    submitting,
    dispositionSubmitted,
    currentAttemptId,
    catalog,
    form,
    notes,
    clock.now,
    tenantId,
    station.diagnostics,
    bootstrap,
    releasedAt,
  ]);

  // ── Presence and break ────────────────────────────────────────────────────
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
    setBreakAlreadyStarted(false);
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
    [bootstrap, tenantId, accountId, audio.preflight, cues.unlock],
  );

  const requestBreak = useCallback(
    async (code: string) => {
      if (!bootstrap) return;
      setBreakBusy(true);
      setBreakRejection(null);
      setBreakAlreadyStarted(false);
      try {
        const response = await setAgentBreak(bootstrap.session_id, code, tenantId, accountId);
        /**
         * **`break_reason`, not `pending_break_reason`** — the mirror carried the
         * wrong name and the API has never sent it on this body, so this read
         * `undefined` every time and the `?? code` fallback quietly carried the
         * pill. It worked only because the code was already in hand here; nothing
         * else on this path would have been so lucky.
         *
         * No longer the ONE place a queued break is rendered from, either: the
         * socket now carries `pending_state` on `agent_state`, and the effect below
         * lets a frame correct or contradict whatever this response said. The
         * response stays because it is the fastest answer to the agent's own click
         * — a pill that waits for the next transition frame would look like the
         * click did nothing.
         */
        setPendingBreakCode(response.pending_state ? (response.break_reason ?? code) : null);
        trackAgencyBreakRequested({
          campaign_id: bootstrap.campaign_id,
          reason_index: breakReasons.findIndex((r) => r.code === code),
          is_paid: breakReasons.find((r) => r.code === code)?.is_paid ?? null,
          queued: Boolean(response.pending_state),
          agent_state: agentState,
          // `requestBreak` is only ever invoked from a `BreakMenu` reason click —
          // the `B` shortcut only opens the menu, it does not select a reason.
          method: 'click',
        });
      } catch (err) {
        const body = errorBody(err);
        if (body?.code === 'unknown_break_reason' && body.allowed_codes) {
          const next = resyncCatalog(breakReasons, body.allowed_codes);
          // `boundCount: 0` — the break menu binds no number keys, so it can never
          // warn about a remap.
          setKeysRemapped((prev) => prev || numberKeysRemapped(breakReasons, next, 0));
          setBreakReasons(next);
          setBreakRejection(BREAK_REJECTED_COPY);
          trackAgencyBreakRejected({
            campaign_id: bootstrap.campaign_id,
            code: 'unknown_break_reason',
            catalog_resynced: true,
          });
        } else {
          setBreakRejection(body?.message ?? 'That break could not be started.');
          trackAgencyBreakRejected({ campaign_id: bootstrap.campaign_id, code: 'other', catalog_resynced: false });
        }
      } finally {
        setBreakBusy(false);
      }
    },
    [bootstrap, tenantId, accountId, breakReasons, agentState],
  );

  const cancelBreak = useCallback(async () => {
    if (!bootstrap || cancelling) return;
    setCancelling(true);
    setCancelFailed(false);
    try {
      const response = await cancelQueuedBreak(bootstrap.session_id, tenantId, accountId);
      // No optimism: the pill stays until the response says the queue is empty. A
      // pill that vanishes on click and reappears on a 500 teaches the agent to
      // distrust it.
      setPendingBreakCode(response.pending_state ? (response.break_reason ?? null) : null);
      if (!response.pending_state) {
        // The break was actually cancelled here, not merely restated by an
        // already-empty queue — this call is the one that emptied it.
        trackAgencyQueuedBreakResolved({ campaign_id: bootstrap.campaign_id, outcome: 'cancelled' });
      }
    } catch (err) {
      const body = errorBody(err);
      if (body?.code === 'break_already_applied') {
        /**
         * **Not an error path at all.** The queued break was promoted to a real one
         * — the ordinary outcome, because a break applies at the end of wrap-up and
         * that is exactly when the agent is finishing their disposition and reaching
         * for the ✕.
         *
         * "Try again" is the one thing we must not say: retrying can never succeed,
         * because its subject no longer exists. The pill goes, the rail moves to
         * `break` on `agent_state` as always, and the recovery offered is
         * `End break` — which we do NOT call on their behalf. They asked to cancel
         * a queued break; turning that into "end the break you are now on" is a
         * different decision that may not be what they want.
         */
        setPendingBreakCode(null);
        setBreakAlreadyStarted(true);
        setAnnouncement('Your break already started.');
        trackAgencyQueuedBreakResolved({ campaign_id: bootstrap.campaign_id, outcome: 'already_applied' });
      } else {
        // The break is still queued, which is the truth, and pressing ✕ again is
        // the right next action.
        setCancelFailed(true);
        setAnnouncement("Couldn't cancel. Try again.");
        trackAgencyQueuedBreakResolved({ campaign_id: bootstrap.campaign_id, outcome: 'cancel_failed' });
      }
    } finally {
      setCancelling(false);
    }
  }, [bootstrap, tenantId, accountId, cancelling]);

  /**
   * **Every authoritative frame restates the queue, and this trusts it.**
   *
   * The pill used to be fed only by the HTTP responses above, which made a queued
   * break invisible — and therefore uncancellable — to any console that did not
   * itself issue the request: a supervisor-queued break, a second window, or the
   * agent's own break followed by a socket blip. The API carries `pending_state` on
   * the frames for exactly that reason — on `agent_state`, and now on `ready` too.
   *
   * Keyed on the statement counter and not on the code, because **absence is the
   * signal**. `/break/cancel` emits an `agent_state` with the pending fields
   * omitted precisely to say the queue is now empty, so this must be able to write
   * `null` — and it can only tell "the API says nothing is queued" from "no frame has
   * spoken yet" by watching a marker that moves on every statement. Depending on
   * the code alone would make the clearing case a no-op, because it is already null.
   *
   * **`agentStateSince` was that marker and could not stay.** `ready` carries no
   * `since` — deliberately, since a reconnect is not a transition and the API will not
   * invent the instant a break was queued — so a reconnect restating the queue never
   * moved it. Two consequences, both real: after a page reload mid-wrap-up
   * `agentStateSince` is `null` and the guard rejected the only frame that could
   * have restored the pill, so an agent about to be pulled out of the pool was shown
   * nothing; and with no `agent_state` since the reload, a `ready` reporting an
   * empty queue could not take a stale pill down either.
   *
   * The HTTP response still wins the instant after a click (it lands first and the
   * agent needs immediate feedback); the frames then confirm or correct it, which
   * is the same "socket is the authority" ordering the rail follows.
   */
  useEffect(() => {
    if (station.pendingBreakStatements === 0) return;
    setPendingBreakCode(station.pendingBreakCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.pendingBreakStatements]);

  /** The queued break resolved itself the moment `agent_state` moved to `break`. */
  useEffect(() => {
    if (agentState === 'break') {
      setPendingBreakCode(null);
      setCancelFailed(false);
    }
  }, [agentState]);

  const labelFor = (code: string | null) =>
    code === null ? null : (breakReasons.find((r) => r.code === code)?.label ?? code);

  return {
    station,
    clock,
    audio,
    cueFlash: cues.cueFlash,
    connectFlashAttemptId: cues.connectFlashAttemptId,
    cuePrefs: cues.prefs,
    setCuePrefs: cues.setPrefs,
    catalog,
    breakReasons,
    breakReasonLabel: labelFor(station.breakReasonCode),
    form,
    setForm: setFormState,
    block,
    padEnabled,
    // A disabled control always carries a *true* stated reason. "available when
    // connected" is a lie once the pad is locked because the save landed and the
    // dialer has gone quiet.
    padDisabledReason: padEnabled ? null : (waitingForDialer ?? PAD_DISABLED_COPY),
    padRejection,
    keysRemapped,
    submitting,
    dispositionSubmitted,
    submit,
    noteCodeSelectionMethod: (method: 'number_key' | 'click') => {
      selectionMethodRef.current = method;
    },
    waitingForDialer,
    notes,
    onNotesEdit,
    notesStatusLine,
    notesForeignWrite,
    notesEnabled,
    notesDisabledReason: notesEnabled ? null : NOTES_DISABLED_COPY,
    presenceBusy,
    presenceRefusal,
    goAvailable: (method?: 'shortcut' | 'click') => void goAvailable(method),
    endBreak: (method?: 'shortcut' | 'click') => void goAvailable(method, 'end_break'),
    requestBreak: (code: string) => void requestBreak(code),
    breakRejection,
    breakBusy,
    pendingBreakLabel: labelFor(pendingBreakCode),
    cancelBreak: () => void cancelBreak(),
    cancelling,
    cancelFailed,
    breakAlreadyStarted,
    lostDispositionNotice,
    announcement,
  };
}
