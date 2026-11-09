import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  dispositionInboundCall,
  getInboundCall,
  hangupInboundCall,
  markInboundCallDnc,
  updateInboundCallNotes,
  type InboundRefusal,
} from '../api/inbound';
import { errorCode } from '../utils/agencyErrors';
import { resyncCatalog } from '../utils/agencyCatalogSync';
import {
  DISPOSITION_BLOCK_COPY,
  EMPTY_DISPOSITION_FORM,
  blockReason,
  buildSubmitPayload,
  type DispositionBlockReason,
  type DispositionFormState,
} from '../utils/agencyDispositionForm';
import { notesStatus, type NotesStatus } from '../utils/agencyNotes';
import { formatDialNumber } from '../utils/softphone/phoneInput';
import { INBOUND_REFUSAL_COPY, inboundRefusalCopy } from '../utils/inbound/inboundCopy';
import {
  INBOUND_PAD_DISABLED_COPY,
  inboundPhase,
  newerInboundCall,
  type InboundPhase,
} from '../utils/inbound/inboundCall';
import { useLatestRef } from './useLatestRef';
import type { ServerClock } from './useServerClock';
import type { StationConnection } from './agencyStation/types';
import type { AgencyDisposition } from '../types/agency';
import type { AgencyInboundCall } from '../types/inbound';

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

export type InboundSaveBlock = DispositionBlockReason | 'call_live';

export const INBOUND_SAVE_BLOCK_COPY: Record<InboundSaveBlock, string> = {
  ...DISPOSITION_BLOCK_COPY,
  no_selection: 'Pick an outcome to save this call.',
  note_required: 'This outcome needs a note.',
  datetime_required: 'This outcome needs a callback time.',
  call_live: 'Save unlocks when the call ends.',
};

/** Why the server refused an outcome (`inbound_disposition_invalid`'s `reason`), in words. */
export const INBOUND_DISPOSITION_RULE_COPY = {
  unknown_code: 'The outcome list for this call changed. Pick one of these.',
  note_required: INBOUND_SAVE_BLOCK_COPY.note_required,
  datetime_required: INBOUND_SAVE_BLOCK_COPY.datetime_required,
  invalid_callback_at: 'That callback time can’t be used. Pick a time in the future.',
} as const;

export const INBOUND_MUTED_AT_CONNECT_COPY = 'You are muted. The caller can’t hear you — press M to unmute.';
export const INBOUND_HUNG_UP_EARLY_COPY = 'The caller hung up before you were connected.';
export const INBOUND_REQUEUED_COPY = 'The call went back to the queue while your station was away.';

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

export const NOTES_DEBOUNCE_MS = 700;
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

  const fresh = (candidate: AgencyInboundCall | null) =>
    candidate && !staleKeys.has(snapshotKey(candidate)) ? candidate : null;
  const newest = newerInboundCall(fresh(frameCall), fresh(httpCall));
  const phase = inboundPhase(newest);
  const call = phase !== null ? newest : null;
  const heldRef = useLatestRef(newest);

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
    getInboundCall(held.id, tenantId, accountId)
      .then((answer) => {
        if (seq !== reconcileSeq.current) return;
        if (sessionId && answer.session_id && answer.session_id !== sessionId) retire(held);
        else adoptCall(answer);
      })
      .catch((err: unknown) => {
        if (seq !== reconcileSeq.current) return;
        if (errorCode(err) === 'inbound_call_not_found') retire(held);
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
  const [notice, setNotice] = useState<string | null>(null);
  /** The agent edited the notes on this call (so blank on screen means cleared, not never typed). */
  const notesTouchedRef = useRef(false);

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
      notesSaveRef.current = { lastKeystrokeAt: null, lastSaveSucceededAt: null, lastUpdatedAt: null };
    }
    if (!call && prev) {
      hydratedForRef.current = null;
      notesTouchedRef.current = false;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setNotesState('');
      setFormState(EMPTY_DISPOSITION_FORM);
      setCatalogOverride(null);
      setPadRejection(null);
      setHangupFailure(null);
      setDncConfirmOpen(false);
      setNotesMeta((m) => ({ ...m, inFlight: false, failure: null }));
      // Why it left, when the agent did not save its outcome: the copy that left with it.
      const last = heldRef.current && heldRef.current.id === prev.id ? heldRef.current : prev;
      if (last.settled_at !== null && last.bridged_at === null) setNotice(INBOUND_HUNG_UP_EARLY_COPY);
      else if (last.state === 'queued') setNotice(INBOUND_REQUEUED_COPY);
    }
    // Keyed on the call's identity and presence, not the object: every frame is a new object.
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
  }, [phase]);

  // ── Notes autosave ────────────────────────────────────────────────────────
  const notesSaveRef = useRef<{ lastKeystrokeAt: number | null; lastSaveSucceededAt: number | null; lastUpdatedAt: string | null }>({
    lastKeystrokeAt: null,
    lastSaveSucceededAt: null,
    lastUpdatedAt: null,
  });
  const [notesMeta, setNotesMeta] = useState<{ inFlight: boolean; failure: 'retryable' | 'terminal' | null; tick: number }>({
    inFlight: false,
    failure: null,
    tick: 0,
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesRef = useLatestRef(notes);
  const callRef = useLatestRef(call);

  const flushSave = useCallback(async () => {
    saveTimerRef.current = null;
    const target = callRef.current;
    if (!target || !tenantId || !accountId) return;
    const text = notesRef.current;
    const sentAt = Date.now();
    setNotesMeta((m) => ({ ...m, inFlight: true }));
    const result = await updateInboundCallNotes(target.id, text, tenantId, accountId);
    if (callRef.current?.id !== target.id) return;
    if (result.ok) {
      // The row carries no `updated_at`: the stamp shown is the moment this save succeeded.
      notesSaveRef.current = {
        ...notesSaveRef.current,
        lastSaveSucceededAt: sentAt,
        lastUpdatedAt: new Date(sentAt).toISOString(),
      };
      setNotesMeta((m) => ({ inFlight: false, failure: null, tick: m.tick + 1 }));
      adoptCall(result.value);
      return;
    }
    const terminal = result.refusal.code === 'inbound_call_not_found' || result.refusal.code === 'inbound_outcome_already_saved';
    setNotesMeta((m) => ({ inFlight: false, failure: terminal ? 'terminal' : 'retryable', tick: m.tick + 1 }));
    if (!terminal) saveTimerRef.current = setTimeout(() => void flushSave(), NOTES_DEBOUNCE_MS * 4);
  }, [callRef, notesRef, tenantId, accountId, adoptCall]);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
  }, []);

  const setNotes = useCallback(
    (value: string) => {
      setNotesState(value);
      notesTouchedRef.current = true;
      notesSaveRef.current = { ...notesSaveRef.current, lastKeystrokeAt: Date.now() };
      setNotesMeta((m) => ({ ...m, tick: m.tick + 1 }));
      if (!callRef.current) return;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => void flushSave(), NOTES_DEBOUNCE_MS);
    },
    [callRef, flushSave],
  );

  const notesEnabled = call !== null;
  const notesStatusLine = notesStatus({
    notes,
    lastKeystrokeAt: notesSaveRef.current.lastKeystrokeAt,
    lastSaveSucceededAt: notesSaveRef.current.lastSaveSucceededAt,
    lastUpdatedAt: notesSaveRef.current.lastUpdatedAt,
    inFlight: notesMeta.inFlight,
    failure: notesMeta.failure,
    acceptingWrites: notesEnabled,
  });

  // ── The outcome ───────────────────────────────────────────────────────────
  /** The pad opens with the caller on the line, as the soft phone's does; Save opens when the call ends. */
  const padEnabled = phase === 'connected' || phase === 'outcome';
  const setForm = useCallback((next: DispositionFormState) => {
    setFormState(next);
    setPadRejection(null);
  }, []);
  const fullForm = useMemo(() => ({ ...form, notes }), [form, notes]);
  const saveBlockAt = useCallback(
    (now: number): InboundSaveBlock | null => {
      const formBlock = blockReason(catalog, fullForm, now);
      if (formBlock === 'no_selection') return 'no_selection';
      if (phase !== 'outcome') return 'call_live';
      return formBlock;
    },
    [catalog, fullForm, phase],
  );

  const savingRef = useRef(false);
  const saveOutcome = useCallback(async () => {
    const target = call;
    if (!target || savingRef.current || !tenantId || !accountId) return;
    const now = clock.now();
    if (saveBlockAt(now) !== null) return;
    const payload = buildSubmitPayload(catalog, fullForm, now);
    if (!payload) return;
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
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
      },
      tenantId,
      accountId,
    );
    savingRef.current = false;
    setSaving(false);
    if (result.ok) {
      adoptCall(result.value.call);
      setAnnouncement('Outcome saved.');
      return;
    }
    const message = dispositionRefusalCopy(result.refusal);
    const { refusal } = result;
    if (refusal.code === 'inbound_disposition_invalid' && refusal.allowedCodes?.length) {
      setCatalogOverride({ callId: target.id, catalog: resyncCatalog(catalog, refusal.allowedCodes) });
    }
    if (refusal.code === 'inbound_outcome_already_saved' || refusal.code === 'inbound_call_not_found') reconcile();
    setPadRejection(message);
    setAnnouncement(`The outcome wasn’t saved. ${message}`);
  }, [call, tenantId, accountId, clock, saveBlockAt, catalog, fullForm, adoptCall, reconcile]);

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
    setHangupFailure(`We couldn’t end the call — you may still be connected. ${inboundRefusalCopy(result.refusal)}`);
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
      const where = result.value.scope === 'campaign' && target.match
        ? `for ${target.match.campaign_name}`
        : 'for this account';
      const text = `${formatDialNumber(result.value.phone_e164)} is on the Do Not Call list ${where}.`;
      setDncOutcome(text);
      setAnnouncement(text);
      return;
    }
    const text = `We couldn’t add the number to Do Not Call. ${inboundRefusalCopy(result.refusal)}`;
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

/** An outcome refused, in the console's words: the rule when the server named one. */
export function dispositionRefusalCopy(refusal: InboundRefusal): string {
  if (refusal.code === 'inbound_disposition_invalid') {
    return refusal.reason ? INBOUND_DISPOSITION_RULE_COPY[refusal.reason] : INBOUND_REFUSAL_COPY.inbound_disposition_invalid;
  }
  return inboundRefusalCopy(refusal);
}
