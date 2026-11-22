import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { INBOUND_NOTICE_COPY, STATION_BLOCK_COPY, STATION_COPY } from '../utils/agency/stationCopy';
import { SIDE_COPY } from '../utils/agency/sideViewCopy';
import {
  dispositionInboundCall,
  getInboundCall,
  hangupInboundCall,
  listInboundCallCampaigns,
  markInboundCallDnc,
  setInboundCallCampaign,
  updateInboundCallNotes,
  type InboundRefusal,
  type InboundResult,
} from '../api/inbound';
import { errorCode } from '../utils/agencyErrors';
import { resyncCatalog } from '../utils/agencyCatalogSync';
import {
  EMPTY_DISPOSITION_FORM,
  blockReason,
  buildSubmitPayload,
  type DispositionBlockReason,
  type DispositionFormState,
} from '../utils/agencyDispositionForm';
import type { NotesStatus } from '../utils/agencyNotes';
import {
  INBOUND_PAD_DISABLED_COPY,
  inboundPhase,
  newerInboundCall,
  type InboundPhase,
} from '../utils/inbound/inboundCall';
import { useLatestRef } from './useLatestRef';
import { useCallNotesAutosave, type NotesSaveSettled } from './useCallNotesAutosave';
import type { ServerClock } from './useServerClock';
import type { StationConnection } from './agencyStation/types';
import type { AgencyDisposition } from '../types/agency';
import type { AgencyInboundCall, AgencyInboundCallCampaignOption } from '../types/inbound';

/**
 * The agent's inbound call (P2, `docs/inbound.md` §6), on top of a station someone else owns.
 *
 * The campaign station receives the `inbound_call` frames (`useAgencyStation`), and its audio
 * carries the call (`audioTarget`); this hook adds what the panel does with the call: the notes
 * autosave, the outcome, Hang up, Mute and Mark DNC, through the call routes
 * (`api/inbound.ts`). It is the soft phone's `useSoftphone` without a dial pad.
 *
 * ── Frames are the authority ─────────────────────────────────────────────────
 * The call on screen is the newest copy from the frame and the routes' answers
 * ({@link newerInboundCall}, the frame winning a tie). A reconnect asks the server for the call
 * held (`GET /inbound/calls/:id`): one that was requeued, or settled, while the socket was away
 * sends no frame into the new socket, and the answer is what retires the copy held. A refusal
 * that says the call is not this agent's any more (`inbound_call_not_found`) retires it too.
 */

/**
 * `work_required`: the account asks for a campaign on every call (`docs/call-log.md` §5) and
 * this one is filed under none; the agent chooses one before Save.
 */
export type InboundSaveBlock = DispositionBlockReason | 'call_live' | 'work_required';

/** Why Save cannot save yet, in the station's words (AS15). */
export const INBOUND_SAVE_BLOCK_COPY: Record<InboundSaveBlock, string> = {
  ...STATION_BLOCK_COPY,
  call_live: SIDE_COPY.saveOpensAfterCall,
  work_required: SIDE_COPY.chooseWorkToSave,
};

/** Why the server refused what the agent chose (`inbound_disposition_invalid`'s `reason`), in the station's words. */
export const INBOUND_DISPOSITION_RULE_COPY = {
  unknown_code: STATION_COPY.catalogChanged,
  note_required: STATION_BLOCK_COPY.note_required,
  datetime_required: STATION_BLOCK_COPY.datetime_required,
  invalid_callback_at: STATION_BLOCK_COPY.callback_in_past,
  promise_required: STATION_BLOCK_COPY.promise_required,
  invalid_promise_date: STATION_BLOCK_COPY.promise_date_invalid,
  invalid_promise_amount: STATION_BLOCK_COPY.promise_amount_invalid,
  promise_not_expected: 'This choice does not take a pay date. Clear the pay date, or choose the one that does.',
} as const;

export const INBOUND_MUTED_AT_CONNECT_COPY = SIDE_COPY.mutedAtAnswer;
export const INBOUND_HUNG_UP_EARLY_COPY = INBOUND_NOTICE_COPY.hungUpEarly;
export const INBOUND_REQUEUED_COPY = INBOUND_NOTICE_COPY.requeued;
/** The outcome window ended before an outcome was saved: the call was closed without one (`no_disposition`). */
export const INBOUND_OUTCOME_WINDOW_ENDED_COPY = INBOUND_NOTICE_COPY.windowEnded;
/** A supervisor closed the call before its window ended ("Close and make available"). */
export const INBOUND_CLOSED_BY_SUPERVISOR_COPY = INBOUND_NOTICE_COPY.closedBySupervisor;

/**
 * Why an answered call left the station with no outcome saved (settled, bridged, no code): its
 * outcome window ran out (the lapse), or a supervisor closed it first. The wire says only that it
 * closed with none; the window's end (`outcome_due_at`, on the server's clock) tells the two apart.
 */
export function closedWithoutOutcomeCopy(call: AgencyInboundCall, clock: ServerClock): string {
  return windowEnded(call, clock) ? INBOUND_OUTCOME_WINDOW_ENDED_COPY : INBOUND_CLOSED_BY_SUPERVISOR_COPY;
}

/** The call's outcome window has ended (its deadline reached on the server's clock). */
function windowEnded(call: AgencyInboundCall, clock: ServerClock): boolean {
  return clock.until(call.outcome_due_at) === 0;
}

export interface InboundCallAudio {
  muted: boolean;
  /** The uplink is open: there is a microphone to mute. */
  sending: boolean;
  toggleMute: () => void;
}

export interface UseInboundCallOptions {
  tenantId: string | undefined;
  accountId: string | undefined;
  /** The station's session: a call answered as another session's is not this panel's. */
  sessionId: string | null;
  connection: StationConnection;
  /** `UseAgencyStationResult.inboundCall`. */
  frameCall: AgencyInboundCall | null;
  clock: ServerClock;
  audio: InboundCallAudio;
  /** `agency.dnc.write`: Mark DNC is offered. */
  mayMarkDnc: boolean;
}

export interface InboundCallState {
  /** The call on the station (offered, connected, or owing its outcome), or null. */
  call: AgencyInboundCall | null;
  phase: InboundPhase | null;
  /**
   * The one thing to tell the agent about a call that has just left the station without an
   * outcome from them (the caller hung up first, it went back to the queue). Shown on the
   * station until the next call; null otherwise.
   */
  notice: string | null;

  catalog: AgencyDisposition[];
  form: DispositionFormState;
  setForm: (next: DispositionFormState) => void;
  padEnabled: boolean;
  padDisabledReason: string | null;
  padRejection: string | null;
  saveBlockAt: (now: number) => InboundSaveBlock | null;
  saving: boolean;
  saveOutcome: () => void;

  /**
   * The work the call is filed under at the end of the call (`docs/call-log.md` §5), for a caller
   * on no list: shown as "Filed under", with Change while the server says it can be moved.
   */
  filing: InboundFiling;

  notes: string;
  setNotes: (value: string) => void;
  notesEnabled: boolean;
  notesStatus: NotesStatus;

  hangupEnabled: boolean;
  hangup: () => void;
  hangupFailure: string | null;
  muted: boolean;
  muteEnabled: boolean;
  toggleMute: () => void;

  dncEnabled: boolean;
  dncConfirmOpen: boolean;
  openDnc: () => void;
  cancelDnc: () => void;
  confirmDnc: () => void;
  dncInFlight: boolean;
  dncOutcome: string | null;
  dncFailure: string | null;

  /** Assertive: the direct result of something the agent pressed, or must know before speaking. */
  announcement: string;
}

/** "Filed under" at the end of a call from a number on no list. */
export interface InboundFiling {
  /** Shown at all: the caller is on no list and the call is over. */
  shown: boolean;
  /** The work it is filed under; null: none yet. */
  name: string | null;
  campaignId: string | null;
  /** The call may be moved to another work (its outcome is not saved). */
  changeable: boolean;
  /** The account asks for a work on every call and this one has none: Save waits for it. */
  missing: boolean;
  /** The choices, once asked for; null before, and while they load. */
  options: AgencyInboundCallCampaignOption[] | null;
  /** The list is open (asked for), loading or loaded. */
  choosing: boolean;
  loading: boolean;
  /** A change is being saved. */
  changing: boolean;
  /** Why the list did not load, or the change did not save. */
  error: string | null;
  /** Said once after a change: what the agent can choose is the new work's. */
  notice: string | null;
  open: () => void;
  close: () => void;
  choose: (campaignId: string) => void;
}

export { NOTES_DEBOUNCE_MS } from './useCallNotesAutosave';
/** How long the station says why a call left it (`notice`). */
export const INBOUND_NOTICE_MS = 30_000;

/** One snapshot of a call, for "the server said THIS copy is over". */
function snapshotKey(call: AgencyInboundCall): string {
  return `${call.id}@${call.offered_at}@${call.state}@${call.settled_at ?? ''}`;
}

export function useInboundCall(options: UseInboundCallOptions): InboundCallState {
  const { tenantId, accountId, sessionId, connection, frameCall, clock, audio, mayMarkDnc } = options;

  // ── The call ──────────────────────────────────────────────────────────────
  const [httpCall, setHttpCall] = useState<AgencyInboundCall | null>(null);
  /** Snapshots the server said are no longer this station's, so a frame copy held from before is retired. */
  const [staleKeys, setStaleKeys] = useState<ReadonlySet<string>>(() => new Set());
  const adoptCall = useCallback((next: AgencyInboundCall | null | undefined) => {
    if (!next) return;
    setHttpCall((current) => newerInboundCall(current, next));
  }, []);
  const retire = useCallback((held: AgencyInboundCall) => {
    setStaleKeys((current) => new Set([...current, snapshotKey(held)]));
  }, []);
  /** Why a call left the station without the agent's outcome (see {@link InboundCallState.notice}). */
  const [notice, setNotice] = useState<string | null>(null);

  const fresh = (candidate: AgencyInboundCall | null) =>
    candidate && !staleKeys.has(snapshotKey(candidate)) ? candidate : null;
  const held = newerInboundCall(fresh(frameCall), fresh(httpCall));
  /**
   * The work the agent just filed the call under (`docs/call-log.md` §5), until the copy held
   * says so itself. Moving a call changes neither its state nor an instant, so the frame's copy
   * (the authority on a tie) would otherwise show the old work until the server's frame lands.
   * It stops applying once the copy held is under any other work than the one it was moved from.
   */
  const [refiled, setRefiled] = useState<{ callId: string; fromCampaignId: string | null; call: AgencyInboundCall } | null>(null);
  const newest = held && refiled && refiled.callId === held.id && (held.campaign?.campaign_id ?? null) === refiled.fromCampaignId
    ? { ...held, campaign: refiled.call.campaign, catalog_source: refiled.call.catalog_source, disposition_catalog: refiled.call.disposition_catalog }
    : held;
  const phase = inboundPhase(newest);
  const call = phase !== null ? newest : null;
  const heldRef = useLatestRef(newest);
  const clockRef = useLatestRef(clock);

  /**
   * Ask the server about the call held. Its answer is adopted when it is still this session's;
   * a call answered as another session's, or refused `inbound_call_not_found`, retires the copy
   * held when the question was asked (a newer frame arriving meanwhile has another key and
   * survives). Any other failure keeps what is held: it is not evidence either way.
   */
  const reconcileSeq = useRef(0);
  const reconcile = useCallback(() => {
    const held = heldRef.current;
    if (!held || inboundPhase(held) === null || !tenantId || !accountId) return;
    const seq = ++reconcileSeq.current;
    // A call still on offer that the server no longer holds for us went back to the queue while
    // the socket was away (its `queued` frame went to the old socket): the agent is told so, as
    // the frame would have told them. The copy that leaves no longer says why, so it is said here.
    const leaveOffered = () => {
      retire(held);
      if (inboundPhase(held) === 'offered') setNotice(INBOUND_REQUEUED_COPY);
    };
    getInboundCall(held.id, tenantId, accountId)
      .then((answer) => {
        if (seq !== reconcileSeq.current) return;
        if (sessionId && answer.session_id && answer.session_id !== sessionId) leaveOffered();
        else adoptCall(answer);
      })
      .catch((err: unknown) => {
        if (seq !== reconcileSeq.current) return;
        if (errorCode(err) === 'inbound_call_not_found') leaveOffered();
      });
  }, [heldRef, tenantId, accountId, sessionId, adoptCall, retire]);

  /** A reconnect (not the first open) asks about the call held — see the module note. */
  const everOpenRef = useRef(false);
  const prevConnectionRef = useRef<StationConnection>(connection);
  useEffect(() => {
    const prev = prevConnectionRef.current;
    prevConnectionRef.current = connection;
    if (connection !== 'open') return;
    if (everOpenRef.current && prev !== 'open') reconcile();
    everOpenRef.current = true;
  }, [connection, reconcile]);

  // ── Draft ─────────────────────────────────────────────────────────────────
  const [notes, setNotesState] = useState('');
  const [form, setFormState] = useState<DispositionFormState>(EMPTY_DISPOSITION_FORM);
  const [catalogOverride, setCatalogOverride] = useState<{ callId: string; catalog: AgencyDisposition[] } | null>(null);
  const [padRejection, setPadRejection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hangupFailure, setHangupFailure] = useState<string | null>(null);
  const [dncConfirmOpen, setDncConfirmOpen] = useState(false);
  const [dncInFlight, setDncInFlight] = useState(false);
  const [dncOutcome, setDncOutcome] = useState<string | null>(null);
  const [dncFailure, setDncFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** The agent edited the notes on this call (so blank on screen means cleared, not never typed). */
  const notesTouchedRef = useRef(false);
  // "Filed under" (docs/call-log.md §5): the list of works, asked for when the agent opens it.
  const [filingFor, setFilingFor] = useState<string | null>(null);
  const [filingOptions, setFilingOptions] = useState<AgencyInboundCallCampaignOption[] | null>(null);
  const [filingLoading, setFilingLoading] = useState(false);
  const [filingChanging, setFilingChanging] = useState(false);
  const [filingError, setFilingError] = useState<string | null>(null);
  const [filingNotice, setFilingNotice] = useState<{ callId: string; text: string } | null>(null);

  const catalog = call && catalogOverride?.callId === call.id ? catalogOverride.catalog : (call?.disposition_catalog ?? []);

  // ── A call arriving, and a call leaving ──────────────────────────────────
  const hydratedForRef = useRef<string | null>(null);
  const prevCallRef = useRef<AgencyInboundCall | null>(null);
  useEffect(() => {
    const prev = prevCallRef.current;
    prevCallRef.current = call;
    if (call && hydratedForRef.current !== call.id) {
      hydratedForRef.current = call.id;
      notesTouchedRef.current = false;
      // A call we have not typed into takes what the server holds (a reload, a reconnect).
      setNotesState(call.notes ?? '');
      setFormState({ ...EMPTY_DISPOSITION_FORM, selectedCode: call.disposition_code });
      setCatalogOverride(null);
      setPadRejection(null);
      setHangupFailure(null);
      setDncOutcome(null);
      setDncFailure(null);
      setDncConfirmOpen(false);
      setNotice(null);
      resetStamps();
    }
    if (!call && prev) {
      hydratedForRef.current = null;
      notesTouchedRef.current = false;
      cancelSave();
      setNotesState('');
      setFormState(EMPTY_DISPOSITION_FORM);
      setCatalogOverride(null);
      setPadRejection(null);
      setHangupFailure(null);
      setDncConfirmOpen(false);
      clearSaveState();
      // Why it left, when the agent did not save its outcome: the copy that left with it.
      const last = heldRef.current && heldRef.current.id === prev.id ? heldRef.current : prev;
      if (last.settled_at !== null && last.bridged_at === null) setNotice(INBOUND_HUNG_UP_EARLY_COPY);
      else if (last.settled_at !== null && last.disposition_code === null) setNotice(closedWithoutOutcomeCopy(last, clockRef.current));
      else if (last.state === 'queued') setNotice(INBOUND_REQUEUED_COPY);
    }
    // Keyed on the call's identity and presence, not the object: every frame is a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.id, call === null]);

  /** The notice is about the call that just left; it does not outstay the next minute. */
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), INBOUND_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Connected with the microphone muted: the one thing the agent must know before they speak. */
  const prevPhaseRef = useRef<InboundPhase | null>(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (phase === 'connected' && prev !== 'connected' && audio.muted) setAnnouncement(INBOUND_MUTED_AT_CONNECT_COPY);
    // Keyed on the phase: the mute state is read at the moment the caller is connected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Notes autosave ────────────────────────────────────────────────────────
  const notesRef = useLatestRef(notes);
  const sendNotes = useCallback(
    (target: AgencyInboundCall) =>
      tenantId && accountId ? updateInboundCallNotes(target.id, notesRef.current, tenantId, accountId) : null,
    [notesRef, tenantId, accountId],
  );
  const settleNotes = useCallback(
    (result: InboundResult<AgencyInboundCall>, sentAt: number): NotesSaveSettled => {
      if (result.ok) {
        adoptCall(result.value);
        // The row carries no `updated_at`: the stamp shown is the moment this save succeeded.
        return { ok: true, updatedAt: new Date(sentAt).toISOString() };
      }
      const terminal = result.refusal.code === 'inbound_call_not_found' || result.refusal.code === 'inbound_outcome_already_saved';
      return { ok: false, terminal, retry: !terminal };
    },
    [adoptCall],
  );
  const {
    status: notesStatusLine,
    scheduleSave,
    cancelSave,
    markKeystroke,
    resetStamps,
    clearSaveState,
  } = useCallNotesAutosave({ call, notes, send: sendNotes, settle: settleNotes });

  const setNotes = useCallback(
    (value: string) => {
      setNotesState(value);
      notesTouchedRef.current = true;
      markKeystroke();
      scheduleSave();
    },
    [markKeystroke, scheduleSave],
  );

  const notesEnabled = call !== null;

  // ── The outcome ───────────────────────────────────────────────────────────
  /** The pad opens with the caller on the line, as the soft phone's does; Save opens when the call ends. */
  const padEnabled = phase === 'connected' || phase === 'outcome';
  const setForm = useCallback((next: DispositionFormState) => {
    setFormState(next);
    setPadRejection(null);
  }, []);

  // ── Filed under (docs/call-log.md §5) ─────────────────────────────────────
  const filingShown = call !== null && phase === 'outcome' && !call.match
    && (Boolean(call.campaign) || call.campaign_required === true || call.campaign_changeable === true);
  const filingChangeable = filingShown && call?.campaign_changeable === true;
  const filingMissing = call !== null && phase === 'outcome' && call.campaign_required === true && !call.campaign;
  const filingChoosing = call !== null && filingFor === call.id;
  const openFiling = useCallback(async () => {
    const target = call;
    if (!target || !tenantId || !accountId || filingLoading) return;
    setFilingFor(target.id);
    setFilingError(null);
    setFilingLoading(true);
    try {
      setFilingOptions(await listInboundCallCampaigns(target.id, tenantId, accountId));
    } catch {
      setFilingOptions(null);
      setFilingError(SIDE_COPY.worksDidNotLoad);
    } finally {
      setFilingLoading(false);
    }
  }, [call, tenantId, accountId, filingLoading]);
  const closeFiling = useCallback(() => {
    setFilingFor(null);
    setFilingError(null);
  }, []);
  const chooseFiling = useCallback(async (campaignId: string) => {
    const target = call;
    if (!target || !tenantId || !accountId || filingChanging || !campaignId) return;
    if (campaignId === target.campaign?.campaign_id) {
      setFilingFor(null);
      return;
    }
    setFilingChanging(true);
    setFilingError(null);
    const result = await setInboundCallCampaign(target.id, campaignId, tenantId, accountId);
    setFilingChanging(false);
    if (!result.ok) {
      if (result.refusal.code === 'inbound_outcome_already_saved' || result.refusal.code === 'inbound_call_not_found') reconcile();
      const text = inboundCallRefusalWords(result.refusal);
      setFilingError(text);
      setAnnouncement(text);
      return;
    }
    adoptCall(result.value);
    setRefiled({ callId: target.id, fromCampaignId: target.campaign?.campaign_id ?? null, call: result.value });
    // What could be chosen was the old work's: the choice made from it is cleared with it.
    setFormState(EMPTY_DISPOSITION_FORM);
    setCatalogOverride(null);
    setPadRejection(null);
    setFilingFor(null);
    const text = SIDE_COPY.choicesChanged(result.value.campaign?.campaign_name ?? '');
    setFilingNotice({ callId: target.id, text });
    setAnnouncement(text);
  }, [call, tenantId, accountId, filingChanging, adoptCall, reconcile]);
  const fullForm = useMemo(() => ({ ...form, notes }), [form, notes]);
  const saveBlockAt = useCallback(
    (now: number): InboundSaveBlock | null => {
      const formBlock = blockReason(catalog, fullForm, now);
      if (formBlock === 'no_selection') return 'no_selection';
      if (phase !== 'outcome') return 'call_live';
      // The server refuses the save (`campaign_required`); say what is missing before it is sent.
      if (filingMissing) return 'work_required';
      return formBlock;
    },
    [catalog, fullForm, phase, filingMissing],
  );

  const savingRef = useRef(false);
  const saveOutcome = useCallback(async () => {
    const target = call;
    if (!target || savingRef.current || !tenantId || !accountId) return;
    const now = clock.now();
    if (saveBlockAt(now) !== null) return;
    const payload = buildSubmitPayload(catalog, fullForm, now);
    if (!payload) return;
    cancelSave();
    savingRef.current = true;
    setSaving(true);
    setPadRejection(null);
    // Notes the agent cleared go as `''` (the debounced PATCH that would have cleared them was
    // cancelled just above); untouched blank notes stay absent, so a save never clears what
    // another window wrote. The soft phone's rule.
    const notesField = payload.notes ? { notes: payload.notes } : notesTouchedRef.current ? { notes: '' } : {};
    const result = await dispositionInboundCall(
      target.id,
      {
        code: payload.disposition_code,
        ...notesField,
        ...(payload.callback_at ? { callback_at: payload.callback_at } : {}),
        ...(payload.promise_date ? { promise_date: payload.promise_date } : {}),
        ...(payload.promise_amount ? { promise_amount: payload.promise_amount } : {}),
      },
      tenantId,
      accountId,
    );
    savingRef.current = false;
    setSaving(false);
    if (result.ok) {
      adoptCall(result.value.call);
      setAnnouncement(SIDE_COPY.savedAnnounce);
      return;
    }
    const message = dispositionRefusalCopy(result.refusal, { windowEnded: windowEnded(target, clock) });
    const { refusal } = result;
    if (refusal.code === 'inbound_disposition_invalid' && refusal.allowedCodes?.length) {
      setCatalogOverride({ callId: target.id, catalog: resyncCatalog(catalog, refusal.allowedCodes) });
    }
    if (refusal.code === 'inbound_outcome_already_saved' || refusal.code === 'inbound_call_not_found') reconcile();
    // The account began asking for a work on every call while this one was open: read the call
    // again, so "Filed under" asks for it.
    if (refusal.code === 'campaign_required') reconcile();
    setPadRejection(message);
    setAnnouncement(SIDE_COPY.notSaved(message));
  }, [call, tenantId, accountId, clock, saveBlockAt, catalog, fullForm, adoptCall, reconcile, cancelSave]);

  // ── Call controls ─────────────────────────────────────────────────────────
  /**
   * Hang up only once the caller is connected. Before that the panel is up for the 1.5 s the
   * agent has to read it, and a hang-up then would end a customer's call unheard.
   */
  const hangupEnabled = phase === 'connected';
  const hangup = useCallback(async () => {
    const target = call;
    if (!target || inboundPhase(target) !== 'connected' || !tenantId || !accountId) return;
    setHangupFailure(null);
    const result = await hangupInboundCall(target.id, tenantId, accountId);
    if (result.ok) {
      adoptCall(result.value);
      return;
    }
    if (result.refusal.code === 'inbound_call_not_found') {
      reconcile();
      return;
    }
    setHangupFailure(`${SIDE_COPY.endCallFailed} ${inboundCallRefusalWords(result.refusal)}`);
  }, [call, tenantId, accountId, adoptCall, reconcile]);

  const muteEnabled = audio.sending && phase === 'connected';

  const dncEnabled = mayMarkDnc && call !== null && call.from_e164 !== null && phase !== 'offered';
  const openDnc = useCallback(() => {
    if (!dncEnabled || dncInFlight || dncOutcome !== null) return;
    setDncFailure(null);
    setDncConfirmOpen(true);
  }, [dncEnabled, dncInFlight, dncOutcome]);
  const cancelDnc = useCallback(() => {
    if (dncInFlight) return;
    setDncConfirmOpen(false);
  }, [dncInFlight]);
  const confirmDnc = useCallback(async () => {
    const target = call;
    if (!target || !tenantId || !accountId) return;
    setDncInFlight(true);
    const result = await markInboundCallDnc(target.id, undefined, tenantId, accountId);
    setDncInFlight(false);
    setDncConfirmOpen(false);
    if (result.ok) {
      setDncOutcome(SIDE_COPY.stoppedCalls);
      setAnnouncement(SIDE_COPY.stoppedCalls);
      return;
    }
    const text = `${SIDE_COPY.stopFailed} ${inboundCallRefusalWords(result.refusal)}`;
    setDncFailure(text);
    setAnnouncement(text);
  }, [call, tenantId, accountId]);

  return {
    call,
    phase,
    notice,
    catalog,
    form,
    setForm,
    padEnabled,
    padDisabledReason: padEnabled ? null : INBOUND_PAD_DISABLED_COPY,
    padRejection,
    saveBlockAt,
    saving,
    saveOutcome: () => void saveOutcome(),
    filing: {
      shown: filingShown,
      name: call?.campaign?.campaign_name || null,
      campaignId: call?.campaign?.campaign_id ?? null,
      changeable: filingChangeable,
      missing: filingMissing,
      options: filingChoosing ? filingOptions : null,
      choosing: filingChoosing,
      loading: filingChoosing && filingLoading,
      changing: filingChanging,
      error: filingChoosing || filingMissing ? filingError : null,
      notice: call && filingNotice?.callId === call.id ? filingNotice.text : null,
      open: () => void openFiling(),
      close: closeFiling,
      choose: (id: string) => void chooseFiling(id),
    },
    notes,
    setNotes,
    notesEnabled,
    notesStatus: notesStatusLine,
    hangupEnabled,
    hangup: () => void hangup(),
    hangupFailure,
    muted: audio.muted,
    muteEnabled,
    toggleMute: audio.toggleMute,
    dncEnabled,
    dncConfirmOpen,
    openDnc,
    cancelDnc,
    confirmDnc: () => void confirmDnc(),
    dncInFlight,
    dncOutcome,
    dncFailure,
    announcement,
  };
}

/**
 * What the agent's call refusals say, keyed on the code, in the station's words (AS15). Any code the
 * agent's call does not expect, and one the console does not know, gets a safe line of ours: never
 * the server's sentence.
 */
export const INBOUND_CALL_REFUSAL_WORDS: Partial<Record<InboundRefusal['code'], string>> = {
  inbound_disabled: 'Calls from customers are turned off for this account.',
  inbound_call_live: 'Finish this call first. Choose what happened and press Save.',
  inbound_call_not_found: 'We cannot find this call. It may be closed already.',
  inbound_call_not_dispositionable: 'You can choose what happened only after you have talked to the customer.',
  inbound_disposition_invalid: 'That did not save. Check what you chose, the note and the time.',
  inbound_outcome_already_saved: 'This call is saved already.',
  // Every call must be filed under a work (docs/call-log.md §5).
  campaign_required: SIDE_COPY.chooseWorkToSave,
  inbound_campaign_fixed: 'This customer is on a list already, so the call stays where it is.',
  inbound_campaign_not_allowed: 'You cannot file calls under that work. Choose another.',
};

export function inboundCallRefusalWords(refusal: InboundRefusal): string {
  return INBOUND_CALL_REFUSAL_WORDS[refusal.code] ?? STATION_COPY.somethingWentWrong;
}

/**
 * What the agent chose, refused, in the station's words: the rule when the server named one.
 * "Already saved" once the call's window has ended (`windowEnded`) is the lapse closing it, not a
 * save someone made: it says the time ran out.
 */
export function dispositionRefusalCopy(refusal: InboundRefusal, opts: { windowEnded?: boolean } = {}): string {
  if (refusal.code === 'inbound_outcome_already_saved' && opts.windowEnded) return INBOUND_OUTCOME_WINDOW_ENDED_COPY;
  if (refusal.code === 'inbound_disposition_invalid' && refusal.reason) return INBOUND_DISPOSITION_RULE_COPY[refusal.reason];
  return inboundCallRefusalWords(refusal);
}
