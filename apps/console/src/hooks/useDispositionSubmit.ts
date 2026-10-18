import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { submitDisposition } from '../api/agency';
import {
  trackAgencyDispositionSubmitted,
  trackAgencyDispositionFailed,
  trackAgencyWaitingForDialer,
  trackAgencyStaleResponseDiscarded,
} from '../analytics/events';
import {
  EMPTY_DISPOSITION_FORM,
  blockReason,
  buildSubmitPayload,
  findDisposition,
  type DispositionFormState,
  type DispositionBlockReason,
} from '../utils/agencyDispositionForm';
import { confirmationCopy, handleSubmitResponse } from '../utils/agencyDispositionSubmit';
import { advisoryAgentState, describeDiscard } from '../utils/agencyStaleResponse';
import { resyncCatalog, selectionAfterResync, numberKeysRemapped } from '../utils/agencyCatalogSync';
import { errorBody, errorStatus } from '../utils/agencyErrors';
import { notesStorageKey } from '../utils/agencyNotes';
import type { DiagnosticsSink } from '../utils/agencyDiagnostics';
import { CATALOG_CHANGED_COPY, NUMBER_KEY_COUNT } from '../components/agency/DispositionPad';
import { useLatestRef } from './useLatestRef';
import type { ServerClock } from './useServerClock';
import type { UseAgencyStationResult } from './useAgencyStation';
import type {
  AgencyAgentState,
  AgencyDisposition,
  AgencyDispositionResponse,
  AgencySessionBootstrap,
} from '../types/agency';

/**
 * The disposition pad's state and its one submit path: the catalog (and its
 * `allowed_codes` resync), the form, the block reason, the double-submit guards,
 * the stale-response door and the "no `agent_state` follows" reconciliation.
 *
 * Split out of `useAgencyConsole`, which still owns WHETHER the pad is open (the
 * pad gate) and composes this with the notes and the station.
 */

/** How long we wait for `agent_state` before reconciling from the response. */
export const AGENT_STATE_RECONCILE_MS = 3000;

/**
 * The copy for a disposition submitted with no `agent_state` following it.
 *
 * Exported so the test names the string once: a copy assertion written out by hand
 * in the test is a test of the test.
 */
export const WAITING_FOR_DIALER_COPY = 'Saved — waiting for the dialer to move you on';

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

export interface DispositionSubmitState {
  /** Live catalog — bootstrap's, or an `allowed_codes` rebuild. */
  catalog: AgencyDisposition[];
  form: DispositionFormState;
  setForm: (next: DispositionFormState) => void;
  /**
   * Why submit is blocked at the instant `now`, or null. A function of the present
   * rather than a value, because one reason (`callback_in_past`) changes with time
   * alone: the reader passes the time it is rendering or firing at.
   */
  blockAt: (now: number) => DispositionBlockReason | null;
  /**
   * True while the block reason can change with nothing but the clock (a
   * datetime-bearing code is selected). The Save control repaints on its own tick
   * exactly then; nothing above it does.
   */
  blockChangesWithTime: boolean;
  padRejection: string | null;
  keysRemapped: boolean;
  /** A break-reason resync's remap folds into the same warning. */
  noteKeysRemapped: (remapped: boolean) => void;
  submitting: boolean;
  dispositionSubmitted: boolean;
  submit: () => void;
  noteCodeSelectionMethod: (method: 'number_key' | 'click') => void;
  waitingForDialer: string | null;
  lostDispositionNotice: string | null;
}

export function useDispositionSubmit(options: {
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | undefined;
  accountId: string | undefined;
  station: UseAgencyStationResult;
  clock: ServerClock;
  diagnostics: DiagnosticsSink;
  /** The field's text, and the attempt it belongs to — `useAgencyNotes`. */
  notes: string;
  notesRef: MutableRefObject<{ notes: string; hydrated: boolean; attemptId: string | null }>;
  announce: (text: string) => void;
  /** The response's advisory says the queued break was promoted. */
  onBreakPromoted: () => void;
}): DispositionSubmitState {
  const { bootstrap, tenantId, accountId, station, clock, diagnostics, notes, notesRef, announce, onBreakPromoted } =
    options;
  const { agentState, agentStateSince, currentAttemptId, releasedAt } = station;

  const [catalog, setCatalog] = useState<AgencyDisposition[]>([]);
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

  /**
   * The reconciliation window's view of the station, read at **fire time**.
   *
   * A ref rather than a closure variable, and the distinction is the whole point:
   * `submit`'s closure captures whatever `station` was at the render that built the
   * callback, so a check written against it compares the state 3s from now against
   * a value that is already stale — and it fails *open*, announcing "waiting for
   * the dialer" while the dialer has in fact already moved the agent on.
   */
  const stationRef = useLatestRef(station);

  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!bootstrap) return;
    setCatalog(bootstrap.disposition_catalog);
  }, [bootstrap]);

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
  }, [agentState, agentStateSince]);

  useEffect(
    () => () => {
      if (reconcileTimer.current !== null) clearTimeout(reconcileTimer.current);
    },
    [],
  );

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
  /**
   * **The one block reason that changes with time is `callback_in_past`**, and it
   * exists only while a datetime-bearing code is selected: the picked time can
   * slide into the past with nobody touching anything, and the Save button has to
   * disable when it does.
   *
   * This hook does NOT repaint for it. It runs in the console root, and a tick
   * here re-rendered the whole console four times a second for as long as a
   * callback code was selected. So the block is handed out as a function of the
   * present: the Save control (`StationActionBar`) evaluates it on its own tick
   * while `blockChangesWithTime` says it must, and the shortcut and `submit`
   * evaluate it with `clock.now()` at fire time.
   */
  const blockChangesWithTime = findDisposition(catalog, form.selectedCode)?.requires_datetime === true;
  const blockAt = useCallback(
    (now: number) => blockReason(catalog, { ...form, notes: notes || form.notes }, now),
    [catalog, form, notes],
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
    // never loses an un-flushed edit. The present is read HERE, at fire time —
    // not off the render that built this callback, which nothing now rebuilds on
    // a clock.
    const payload = buildSubmitPayload(catalog, { ...form, notes: notes || form.notes }, clock.now());
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
          diagnostics.push({
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
            if (hint === 'break') onBreakPromoted();
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
          announce(
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
          announce(outcome.message);
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
    clock,
    tenantId,
    /**
     * Listed, and it was not. The 250ms repaint at the console root rebuilt this
     * callback four times a second, so a stale `accountId` never survived long
     * enough to be sent; with that repaint gone a submit after an account change
     * went out under the previous account.
     */
    accountId,
    diagnostics,
    bootstrap,
    releasedAt,
    notesRef,
    stationRef,
    announce,
    onBreakPromoted,
  ]);

  const noteKeysRemapped = useCallback((remapped: boolean) => {
    setKeysRemapped((prev) => prev || remapped);
  }, []);

  const noteCodeSelectionMethod = useCallback((method: 'number_key' | 'click') => {
    selectionMethodRef.current = method;
  }, []);

  return {
    catalog,
    form,
    setForm: setFormState,
    blockAt,
    blockChangesWithTime,
    padRejection,
    keysRemapped,
    noteKeysRemapped,
    submitting,
    dispositionSubmitted,
    submit,
    noteCodeSelectionMethod,
    waitingForDialer,
    lostDispositionNotice,
  };
}
