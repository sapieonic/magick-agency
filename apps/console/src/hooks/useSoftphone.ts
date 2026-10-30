import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  dispositionManualCall,
  getSoftphoneBootstrap,
  hangupManualCall,
  listManualCalls,
  markManualCallDnc,
  placeManualCall,
  updateManualCall,
  type SoftphoneDncListedRefusal,
  type SoftphoneOutsideHoursRefusal,
  type SoftphoneRefusal,
} from '../api/softphone';
import {
  trackAgencySoftphoneCallPlaced,
  trackAgencySoftphoneCallRefused,
  trackAgencySoftphoneDncMarked,
  trackAgencySoftphoneHangup,
  trackAgencySoftphoneOutcomeSaved,
  trackAgencySoftphoneOverrideConfirmed,
} from '../analytics/events';
import { resyncCatalog } from '../utils/agencyCatalogSync';
import {
  DISPOSITION_BLOCK_COPY,
  EMPTY_DISPOSITION_FORM,
  blockReason,
  buildSubmitPayload,
  type DispositionBlockReason,
  type DispositionFormState,
} from '../utils/agencyDispositionForm';
import { CATALOG_CHANGED_COPY } from '../components/agency/DispositionPad';
import { notesStatus, type NotesStatus } from '../utils/agencyNotes';
import {
  appendDialKey,
  deleteLastDialChar,
  dialBlockReason,
  formatDialNumber,
  normalisePastedNumber,
  sanitiseDialInput,
  type DialBlockReason,
} from '../utils/softphone/phoneInput';
import {
  isCallLive,
  isCallUnsettled,
  newerCall,
  phaseAnnouncement,
  softphonePhase,
  type SoftphonePhase,
} from '../utils/softphone/callState';
import {
  cleanFieldValues,
  sameFieldValues,
  validateCallFieldValues,
  type CallFieldValue,
} from '../utils/softphone/callFields';
import {
  describeDncRefusal,
  describeHoursRefusal,
  withOverride,
  type OverrideDescription,
  type OverrideKind,
} from '../utils/softphone/overrides';
import { refusalCopy, SOFTPHONE_REFUSAL_COPY } from '../utils/softphone/refusalCopy';
import { RingbackTone } from '../utils/softphone/ringback';
import type { ServerClock } from './useServerClock';
import { useLatestRef } from './useLatestRef';
import type { StationConnection } from './agencyStation/types';
import type { AgencyDisposition } from '../types/agency';
import type {
  AgencyCallField,
  AgencyCallFieldValues,
  AgencyManualCall,
  AgencyManualCallOverridesRequest,
  AgencySoftphoneBootstrap,
  AgencySoftphoneCampaign,
} from '../types/softphone';

/**
 * The soft phone's state machine, on top of a station connection someone else
 * owns (`docs/softphone.md` §7).
 *
 * ── Two hosts, one hook ──────────────────────────────────────────────────────
 * `/dialer/phone` opens a soft-phone session and connects the station socket for
 * it; the campaign station, switched to the soft phone (SP7), keeps its own
 * session and socket. Either way the socket, the microphone and the playback
 * belong to the HOST — this hook never opens a socket or touches `getUserMedia`.
 * It reads the host's `manual_call` frames and connection, calls the soft-phone
 * routes, and hands the host's audio the one thing it cannot know: the call.
 *
 * ── Frames are the authority ─────────────────────────────────────────────────
 * The call on screen is the newest copy from three sources — the `manual_call`
 * frame, the HTTP answers (`POST /calls`, the hang-up, the outcome, the PATCH),
 * and `GET /bootstrap` on load and after every reconnect — compared by
 * `newerCall`, the frame winning a tie. A reconnect re-reads the bootstrap
 * because a call that settled while the socket was away sends no frame into the
 * new one: the bootstrap's `call: null` is what retires the copy we still hold.
 */

export interface SoftphoneAudio {
  muted: boolean;
  sending: boolean;
  toggleMute: () => void;
  /** Resume both audio contexts — called from the Call click, the one sure user gesture. */
  resume: () => void;
}

export interface UseSoftphoneOptions {
  tenantId: string | undefined;
  accountId: string | undefined;
  /** The agent's own user id: scopes the recent-calls list to them, supervisor or not. */
  userId: string | null;
  /** The live session the calls are placed from. */
  sessionId: string | null;
  connection: StationConnection;
  /** `UseAgencyStationResult.manualCall`. */
  frameCall: AgencyManualCall | null;
  clock: ServerClock;
  audio: SoftphoneAudio;
  /** Log calls to this campaign by default (the station's campaign, SP7). */
  presetCampaignId?: string | null;
  /** Which host this is, for copy and analytics. */
  surface: 'softphone_page' | 'station';
  /** The agent's cue volume (0–100), for the ringback. */
  cueVolume?: number;
  /** False holds every request (a host still opening its session). */
  enabled?: boolean;
  /** Injectable for tests. */
  ringback?: RingbackTone;
}

export interface OverridePrompt {
  kind: OverrideKind;
  description: OverrideDescription;
  /** The overrides already given in this dial — kept when the second refusal arrives. */
  overrides: AgencyManualCallOverridesRequest;
  refusal: SoftphoneDncListedRefusal | SoftphoneOutsideHoursRefusal;
}

export type SaveBlock = DispositionBlockReason | 'call_live' | 'fields_required';

export const SAVE_BLOCK_COPY: Record<SaveBlock, string> = {
  ...DISPOSITION_BLOCK_COPY,
  no_selection: 'Pick an outcome to save this call.',
  call_live: 'Save unlocks when the call ends.',
  fields_required: 'Fill in the required call details first.',
};

export const SOFTPHONE_NOTES_DISABLED_COPY = 'Notes open when a call starts.';
export const SOFTPHONE_PAD_DISABLED_COPY = 'Outcomes open when the customer answers.';

export interface SoftphoneState {
  bootstrap: AgencySoftphoneBootstrap | null;
  bootstrapError: string | null;
  reloadBootstrap: () => void;

  /** The session's unsettled call (live, or ended and owing an outcome), or null. */
  call: AgencyManualCall | null;
  phase: SoftphonePhase;
  /** The last call that finished, for the Ready rail. */
  lastCall: AgencyManualCall | null;

  // ── Dial pad ──
  number: string;
  numberDisplay: string;
  setNumber: (raw: string) => void;
  pressKey: (key: string) => void;
  backspace: () => void;
  pasteNumber: (raw: string) => void;
  dialBlock: DialBlockReason | null;
  canDial: boolean;
  /** Why Call is unavailable beyond the number itself (not connected, a call in progress). */
  dialUnavailableReason: string | null;
  placing: boolean;
  dialError: string | null;
  dial: () => void;

  // ── Log to / caller ID ──
  taggableCampaigns: AgencySoftphoneCampaign[];
  /** The draft's tag before dialling; the call's tag once dialled. */
  tagCampaignId: string | null;
  setTagCampaignId: (id: string | null) => void;
  /** The campaign the screen is about: the call's tag, else the draft's. */
  campaign: AgencySoftphoneCampaign | null;
  callerIdOptions: string[];
  callerId: string | null;
  setCallerId: (id: string) => void;
  /** Whether the tag and caller ID may still change (nothing dialled yet). */
  setupEditable: boolean;

  // ── Call details ──
  fields: AgencyCallField[];
  fieldValues: AgencyCallFieldValues;
  setFieldValue: (key: string, value: CallFieldValue) => void;
  fieldErrors: Record<string, string>;

  // ── Outcome ──
  catalog: AgencyDisposition[];
  form: DispositionFormState;
  setForm: (next: DispositionFormState, method?: 'number_key' | 'click') => void;
  padEnabled: boolean;
  padDisabledReason: string | null;
  padRejection: string | null;
  saveBlockAt: (now: number) => SaveBlock | null;
  saving: boolean;
  saveOutcome: () => void;

  // ── Notes ──
  notes: string;
  setNotes: (value: string) => void;
  notesEnabled: boolean;
  notesStatus: NotesStatus;

  // ── Call controls ──
  hangup: () => void;
  hangupFailure: string | null;
  muted: boolean;
  muteEnabled: boolean;
  toggleMute: () => void;
  dncConfirmOpen: boolean;
  openDnc: () => void;
  cancelDnc: () => void;
  confirmDnc: () => void;
  dncInFlight: boolean;
  dncOutcome: string | null;
  dncFailure: string | null;
  dncEnabled: boolean;

  // ── Overrides ──
  overridePrompt: OverridePrompt | null;
  overrideSubmitting: boolean;
  overrideError: string | null;
  confirmOverride: (note: string) => void;
  cancelOverride: () => void;

  // ── Recent calls ──
  recent: AgencyManualCall[];
  recentLoading: boolean;
  recentError: string | null;
  redial: (call: AgencyManualCall) => void;
  /** Moves when the Call button should take focus (a redial filled the pad). */
  focusCallToken: number;

  /** Polite: the call's state. */
  phaseAnnouncement: string;
  /** Assertive: the direct result of something the agent just pressed. */
  announcement: string;
}

const NOTES_DEBOUNCE_MS = 700;
const RECENT_LIMIT = 8;

function callKey(call: AgencyManualCall): string {
  return `${call.id}@${call.updated_at}`;
}

function noteBucket(note: string): 'under_50' | '50_200' | 'over_200' {
  const n = note.trim().length;
  if (n < 50) return 'under_50';
  if (n <= 200) return '50_200';
  return 'over_200';
}

export function useSoftphone(options: UseSoftphoneOptions): SoftphoneState {
  const {
    tenantId,
    accountId,
    userId,
    sessionId,
    connection,
    frameCall,
    clock,
    audio,
    presetCampaignId = null,
    surface,
    cueVolume = 70,
    enabled = true,
  } = options;

  const ringbackRef = useRef<RingbackTone | null>(options.ringback ?? null);
  if (ringbackRef.current === null) ringbackRef.current = new RingbackTone();
  const ringback = ringbackRef.current;

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  const [bootstrap, setBootstrap] = useState<AgencySoftphoneBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [httpCall, setHttpCall] = useState<AgencyManualCall | null>(null);
  /** Snapshots a bootstrap said are over (`call: null`), so a frame copy held from before is retired. */
  const [staleKeys, setStaleKeys] = useState<ReadonlySet<string>>(() => new Set());
  const bootstrapSeq = useRef(0);
  const heldCallRef = useRef<AgencyManualCall | null>(null);

  const adoptCall = useCallback((call: AgencyManualCall | null | undefined) => {
    if (!call) return;
    setHttpCall((current) => newerCall(current, call));
  }, []);

  const loadBootstrap = useCallback(() => {
    if (!enabled || !tenantId || !accountId) return;
    const seq = ++bootstrapSeq.current;
    // What we hold at the moment we ask: if the answer says there is no call, THIS
    // snapshot is the one it contradicts. A newer frame arriving meanwhile has a
    // different key and survives.
    const heldAtAsk = heldCallRef.current;
    getSoftphoneBootstrap(tenantId, accountId)
      .then((next) => {
        if (seq !== bootstrapSeq.current) return;
        setBootstrap(next);
        setBootstrapError(null);
        if (next.call) {
          adoptCall(next.call);
        } else if (heldAtAsk && isCallUnsettled(heldAtAsk)) {
          setStaleKeys((current) => new Set([...current, callKey(heldAtAsk)]));
        }
      })
      .catch((err: unknown) => {
        if (seq !== bootstrapSeq.current) return;
        setBootstrapError(err instanceof Error ? err.message : 'We couldn’t load the soft phone.');
      });
  }, [enabled, tenantId, accountId, adoptCall]);

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  /** A reconnect (not the first open) re-reads the bootstrap — see the module note. */
  const everOpenRef = useRef(false);
  const prevConnectionRef = useRef<StationConnection>(connection);
  useEffect(() => {
    const prev = prevConnectionRef.current;
    prevConnectionRef.current = connection;
    if (connection !== 'open') return;
    if (everOpenRef.current && prev !== 'open') loadBootstrap();
    everOpenRef.current = true;
  }, [connection, loadBootstrap]);

  // ── The call ──────────────────────────────────────────────────────────────
  const live = (candidate: AgencyManualCall | null) =>
    candidate && !staleKeys.has(callKey(candidate)) ? candidate : null;
  const newest = newerCall(live(frameCall), live(httpCall));
  const call = isCallUnsettled(newest) ? newest : null;
  heldCallRef.current = newest;
  const phase = softphonePhase(call);

  // ── Draft ─────────────────────────────────────────────────────────────────
  const [number, setNumberState] = useState('');
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [callerDraft, setCallerDraft] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<AgencyCallFieldValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notes, setNotesState] = useState('');
  const [form, setFormState] = useState<DispositionFormState>(EMPTY_DISPOSITION_FORM);
  const [catalogOverride, setCatalogOverride] = useState<{ callId: string; catalog: AgencyDisposition[] } | null>(null);
  const [padRejection, setPadRejection] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [dialError, setDialError] = useState<string | null>(null);
  const [overridePrompt, setOverridePrompt] = useState<OverridePrompt | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [hangupFailure, setHangupFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dncConfirmOpen, setDncConfirmOpen] = useState(false);
  const [dncInFlight, setDncInFlight] = useState(false);
  const [dncOutcome, setDncOutcome] = useState<string | null>(null);
  const [dncFailure, setDncFailure] = useState<string | null>(null);
  const [recent, setRecent] = useState<AgencyManualCall[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [lastCall, setLastCall] = useState<AgencyManualCall | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusCallToken, setFocusCallToken] = useState(0);
  const entryRef = useRef<'typed' | 'pasted' | 'redial'>('typed');
  const selectionMethodRef = useRef<'number_key' | 'click'>('click');
  const presetAppliedRef = useRef(false);

  const taggableCampaigns = useMemo(() => bootstrap?.taggable_campaigns ?? [], [bootstrap]);
  const fields = useMemo(() => bootstrap?.call_fields ?? [], [bootstrap]);
  /**
   * Whether the field set is known. Until the bootstrap lands, `fields` is `[]`
   * because nothing has said what it is — not because the account has none — and
   * `fields` on the wire REPLACES the stored values (`cleanFieldValues`). So no
   * request carries `fields` before this is true: the server keeps what it holds
   * when the key is absent, and the values come back to the form when the set
   * arrives (the re-hydration below).
   */
  const fieldsKnown = bootstrap !== null;
  const fieldSetRef = useLatestRef({ known: fieldsKnown, fields });
  /** The agent typed into a call field since the call's values were last taken from the server. */
  const fieldsTouchedRef = useRef(false);

  // The station's campaign, preselected once the list that can confirm it arrives.
  useEffect(() => {
    if (presetAppliedRef.current || !bootstrap || !presetCampaignId) return;
    presetAppliedRef.current = true;
    if (bootstrap.taggable_campaigns.some((c) => c.campaign_id === presetCampaignId)) setTagDraft(presetCampaignId);
  }, [bootstrap, presetCampaignId]);

  const setupEditable = call === null && !placing;
  const tagCampaignId = call ? (call.tag?.campaign_id ?? null) : tagDraft;
  const campaign = tagCampaignId ? (taggableCampaigns.find((c) => c.campaign_id === tagCampaignId) ?? null) : null;
  const callerIdOptions = useMemo(
    () => (tagDraft ? (taggableCampaigns.find((c) => c.campaign_id === tagDraft)?.caller_ids ?? []) : (bootstrap?.untagged.caller_ids ?? [])),
    [tagDraft, taggableCampaigns, bootstrap],
  );
  const draftCampaign = tagDraft ? (taggableCampaigns.find((c) => c.campaign_id === tagDraft) ?? null) : null;
  const defaultCallerId = draftCampaign
    ? (draftCampaign.caller_ids[0] ?? null)
    : (bootstrap?.untagged.default_caller_id && callerIdOptions.includes(bootstrap.untagged.default_caller_id)
        ? bootstrap.untagged.default_caller_id
        : (callerIdOptions[0] ?? null));
  const draftCallerId = callerDraft && callerIdOptions.includes(callerDraft) ? callerDraft : defaultCallerId;
  const callerId = call ? call.caller_id : draftCallerId;

  const baseCatalog: AgencyDisposition[] = call?.tag
    ? (taggableCampaigns.find((c) => c.campaign_id === call.tag!.campaign_id)?.disposition_catalog
      ?? bootstrap?.untagged.disposition_catalog
      ?? [])
    : (bootstrap?.untagged.disposition_catalog ?? []);
  const catalog = call && catalogOverride?.callId === call.id ? catalogOverride.catalog : baseCatalog;

  // ── A call arriving, and a call settling ─────────────────────────────────
  const hydratedForRef = useRef<string | null>(null);
  const prevCallRef = useRef<AgencyManualCall | null>(null);
  useEffect(() => {
    const prev = prevCallRef.current;
    prevCallRef.current = call;
    if (call && hydratedForRef.current !== call.id) {
      hydratedForRef.current = call.id;
      fieldsTouchedRef.current = false;
      // A call we did not place from this screen (a reload, a reconnect, a second
      // window): take what the server holds. One we placed already matches the draft.
      // (Before the field set is known this compares against nothing; the
      // re-hydration below takes the server's values when the set arrives.)
      setFieldValues((current) => (sameFieldValues(fields, current, call.fields) ? current : { ...call.fields }));
      setNotesState((current) => (current.trim() === '' ? (call.notes ?? '') : current));
      setNumberState((current) => current || call.destination_e164);
      setFormState({ ...EMPTY_DISPOSITION_FORM, selectedCode: call.disposition_code });
      setPadRejection(null);
      setHangupFailure(null);
      setDncOutcome(null);
      setDncFailure(null);
      setDialError(null);
    }
    if (!call && prev) {
      // Settled (outcome saved, lapsed, or an unanswered call closed): back to Ready.
      hydratedForRef.current = null;
      fieldsTouchedRef.current = false;
      setLastCall(newest && newest.id === prev.id ? newest : prev);
      setNumberState('');
      setFieldValues({});
      setFieldErrors({});
      setNotesState('');
      setFormState(EMPTY_DISPOSITION_FORM);
      setCatalogOverride(null);
      setPadRejection(null);
      setHangupFailure(null);
      setCallerDraft(null);
      entryRef.current = 'typed';
      notesSaveRef.current = { lastKeystrokeAt: null, lastSaveSucceededAt: null, lastUpdatedAt: null };
      setNotesMeta((m) => ({ ...m, inFlight: false, failure: null }));
      loadRecent();
    }
    // `newest` is read for the settled copy only; the effect is keyed on the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.id, call === null]);

  /**
   * The field set arriving after the call (a reload where the `manual_call` frame
   * beats `GET /bootstrap`, or the station's SP7 path, whose bootstrap only starts
   * once the session reads as on the soft phone): the form was hydrated against
   * no fields, so take the server's values again — unless the agent has typed
   * into a field since, which is newer than any copy we hold.
   */
  const callForFieldsRef = useLatestRef(call);
  const fieldsWereKnownRef = useRef(fieldsKnown);
  useEffect(() => {
    const wasKnown = fieldsWereKnownRef.current;
    fieldsWereKnownRef.current = fieldsKnown;
    if (wasKnown || !fieldsKnown) return;
    const current = callForFieldsRef.current;
    if (!current || fieldsTouchedRef.current) return;
    setFieldValues({ ...current.fields });
  }, [fieldsKnown, callForFieldsRef]);

  // ── Recent calls ──────────────────────────────────────────────────────────
  const recentSeq = useRef(0);
  const loadRecent = useCallback(() => {
    if (!enabled || !tenantId || !accountId) return;
    const seq = ++recentSeq.current;
    setRecentLoading(true);
    listManualCalls({ limit: RECENT_LIMIT, ...(userId ? { agent_user_id: userId } : {}) }, tenantId, accountId)
      .then((page) => {
        if (seq !== recentSeq.current) return;
        setRecent(page.rows);
        setRecentError(null);
      })
      .catch((err: unknown) => {
        if (seq !== recentSeq.current) return;
        setRecentError(err instanceof Error ? err.message : 'We couldn’t load your recent calls.');
      })
      .finally(() => {
        if (seq === recentSeq.current) setRecentLoading(false);
      });
  }, [enabled, tenantId, accountId, userId]);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  // ── Ringback ──────────────────────────────────────────────────────────────
  useEffect(() => {
    ringback.setVolume(cueVolume);
  }, [ringback, cueVolume]);
  useEffect(() => {
    ringback.setMuted(audio.muted);
  }, [ringback, audio.muted]);
  useEffect(() => {
    if (phase === 'ringing') ringback.start();
    else ringback.stop();
  }, [ringback, phase]);
  useEffect(() => () => ringback.stop(), [ringback]);

  // ── Announcements ─────────────────────────────────────────────────────────
  const [politeAnnouncement, setPoliteAnnouncement] = useState('');
  const announcedPhaseRef = useRef<SoftphonePhase>('ready');
  useEffect(() => {
    if (announcedPhaseRef.current === phase) return;
    announcedPhaseRef.current = phase;
    setPoliteAnnouncement(phaseAnnouncement(phase, phase === 'ready' ? (lastCall ?? newest) : call));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Dial ──────────────────────────────────────────────────────────────────
  const setNumber = useCallback((raw: string) => {
    entryRef.current = 'typed';
    setNumberState(sanitiseDialInput(raw));
    setDialError(null);
  }, []);
  const pressKey = useCallback((key: string) => {
    entryRef.current = 'typed';
    setNumberState((current) => appendDialKey(current, key));
    setDialError(null);
  }, []);
  const backspace = useCallback(() => setNumberState((current) => deleteLastDialChar(current)), []);
  const countryCode = bootstrap?.default_country_code ?? '+91';
  const pasteNumber = useCallback(
    (raw: string) => {
      entryRef.current = 'pasted';
      setNumberState(normalisePastedNumber(raw, countryCode));
      setDialError(null);
    },
    [countryCode],
  );

  const dialBlock = dialBlockReason(number);
  const dialUnavailableReason =
    connection !== 'open'
      ? 'Wait until your phone is connected.'
      : !bootstrap || !sessionId
        ? 'Loading the soft phone…'
        : call
          ? phase === 'outcome'
            ? 'Save this call’s outcome before you dial again.'
            : 'A call is in progress.'
          : callerIdOptions.length === 0
            ? 'There’s no caller ID to call from. Ask your supervisor to assign a number.'
            : null;
  const canDial = dialUnavailableReason === null && dialBlock === null && !placing;

  const place = useCallback(
    async (overrides: AgencyManualCallOverridesRequest) => {
      if (!sessionId || !tenantId || !accountId) return;
      setPlacing(true);
      setDialError(null);
      setOverrideError(null);
      const cleanFields = cleanFieldValues(fields, fieldValues);
      const result = await placeManualCall(
        {
          session_id: sessionId,
          to: number,
          ...(draftCallerId ? { caller_id: draftCallerId } : {}),
          campaign_id: tagDraft,
          ...(Object.keys(cleanFields).length > 0 ? { fields: cleanFields } : {}),
          ...(overrides.dnc_note || overrides.hours_note ? { overrides } : {}),
        },
        tenantId,
        accountId,
      );
      setPlacing(false);
      if (result.ok) {
        setOverridePrompt(null);
        adoptCall(result.value);
        trackAgencySoftphoneCallPlaced({
          tagged: Boolean(tagDraft),
          overrides:
            overrides.dnc_note && overrides.hours_note
              ? 'both'
              : overrides.dnc_note
                ? 'dnc'
                : overrides.hours_note
                  ? 'hours'
                  : 'none',
          entry: entryRef.current,
          surface,
        });
        return;
      }
      // Read through the ref: this runs after an await, and the refusal must be
      // judged against the screen as it is now (an override dialog opened meanwhile).
      handleDialRefusalRef.current(result.refusal, overrides);
    },
    [sessionId, tenantId, accountId, number, draftCallerId, tagDraft, fields, fieldValues, surface, adoptCall],
  );

  const handleDialRefusal = (refusal: SoftphoneRefusal, overrides: AgencyManualCallOverridesRequest) => {
    trackAgencySoftphoneCallRefused({ code: refusal.code, tagged: Boolean(tagDraft) });
    const campaignName = draftCampaign?.campaign_name ?? null;
    switch (refusal.code) {
      case 'dnc_listed':
        setOverridePrompt({
          kind: 'dnc',
          refusal,
          overrides,
          description: describeDncRefusal(refusal, { number, campaignName }),
        });
        return;
      case 'outside_calling_hours':
        setOverridePrompt({
          kind: 'hours',
          refusal,
          overrides,
          description: describeHoursRefusal(refusal, { campaignName }),
        });
        return;
      case 'override_note_invalid':
        if (overridePromptRef.current) setOverrideError(refusal.message || SOFTPHONE_REFUSAL_COPY.override_note_invalid);
        else setDialError(SOFTPHONE_REFUSAL_COPY.override_note_invalid);
        return;
      case 'outcome_pending':
      case 'manual_call_live':
        setOverridePrompt(null);
        adoptCall(refusal.call);
        setDialError(SOFTPHONE_REFUSAL_COPY[refusal.code]);
        return;
      case 'contact_in_flight':
        setOverridePrompt(null);
        setDialError(
          campaignName
            ? `${campaignName} is calling this customer right now. Wait for that call to finish, then try again.`
            : SOFTPHONE_REFUSAL_COPY.contact_in_flight,
        );
        return;
      case 'caller_id_not_allowed':
      case 'campaign_not_taggable':
        setOverridePrompt(null);
        setDialError(SOFTPHONE_REFUSAL_COPY[refusal.code]);
        // What may be called from, and logged to, has changed under us: re-read it.
        loadBootstrap();
        return;
      default:
        setOverridePrompt(null);
        setDialError(refusalCopy(refusal));
    }
  };

  const handleDialRefusalRef = useLatestRef(handleDialRefusal);
  const overridePromptRef = useLatestRef(overridePrompt);

  const dial = useCallback(() => {
    if (!canDial) return;
    // The one sure user gesture before the ring: unlock the ringback and resume
    // the playback context now, or the ring and the customer's voice may be
    // refused by the browser's autoplay policy later.
    ringback.unlock();
    audio.resume();
    void place({});
  }, [canDial, ringback, audio, place]);

  const confirmOverride = useCallback(
    (note: string) => {
      if (!overridePrompt || placing) return;
      trackAgencySoftphoneOverrideConfirmed({ kind: overridePrompt.kind, note_length_bucket: noteBucket(note) });
      void place(withOverride(overridePrompt.overrides, overridePrompt.kind, note));
    },
    [overridePrompt, placing, place],
  );
  const cancelOverride = useCallback(() => {
    if (placing) return;
    setOverridePrompt(null);
    setOverrideError(null);
  }, [placing]);

  // ── Tag and caller ID ─────────────────────────────────────────────────────
  const setTagCampaignId = useCallback(
    (id: string | null) => {
      if (!setupEditable) return;
      setTagDraft(id);
      // The caller-ID set belongs to the tag; a pick from the old set would be refused.
      setCallerDraft(null);
      setDialError(null);
    },
    [setupEditable],
  );
  const setCallerId = useCallback(
    (id: string) => {
      if (!setupEditable) return;
      setCallerDraft(id);
    },
    [setupEditable],
  );

  // ── Fields and notes, autosaved onto the live call ───────────────────────
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
  const draftRef = useRef({ fieldValues, notes });
  draftRef.current = { fieldValues, notes };
  const callRef = useRef(call);
  callRef.current = call;

  const flushSave = useCallback(async () => {
    saveTimerRef.current = null;
    const target = callRef.current;
    if (!target || !tenantId || !accountId) return;
    const { fieldValues: values, notes: text } = draftRef.current;
    // Read at send time, not from the render that armed the timer: a save armed
    // before the field set arrived may fire after it.
    const fieldSet = fieldSetRef.current;
    const sentAt = Date.now();
    setNotesMeta((m) => ({ ...m, inFlight: true }));
    const result = await updateManualCall(
      target.id,
      // Notes alone until the field set is known: `fields` would replace the stored values.
      fieldSet.known ? { fields: cleanFieldValues(fieldSet.fields, values), notes: text } : { notes: text },
      tenantId,
      accountId,
    );
    if (callRef.current?.id !== target.id) return;
    if (result.ok) {
      notesSaveRef.current = {
        ...notesSaveRef.current,
        lastSaveSucceededAt: sentAt,
        lastUpdatedAt: result.value.updated_at,
      };
      setNotesMeta((m) => ({ inFlight: false, failure: null, tick: m.tick + 1 }));
      adoptCall(result.value);
      return;
    }
    const refusal = result.refusal;
    if (refusal.code === 'fields_invalid' && refusal.details) {
      setFieldErrors(fieldErrorsFromDetails(refusal.details));
    }
    const terminal = refusal.code === 'call_settled' || refusal.code === 'call_not_found';
    setNotesMeta((m) => ({ inFlight: false, failure: terminal ? 'terminal' : 'retryable', tick: m.tick + 1 }));
    if (!terminal && refusal.code !== 'fields_invalid') {
      saveTimerRef.current = setTimeout(() => void flushSave(), NOTES_DEBOUNCE_MS * 4);
    }
  }, [tenantId, accountId, fieldSetRef, adoptCall]);

  const scheduleSave = useCallback(() => {
    if (!callRef.current) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(), NOTES_DEBOUNCE_MS);
  }, [flushSave]);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
  }, []);

  const setFieldValue = useCallback(
    (key: string, value: CallFieldValue) => {
      fieldsTouchedRef.current = true;
      setFieldValues((current) => ({ ...current, [key]: value }));
      setFieldErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  const setNotes = useCallback(
    (value: string) => {
      setNotesState(value);
      notesSaveRef.current = { ...notesSaveRef.current, lastKeystrokeAt: Date.now() };
      setNotesMeta((m) => ({ ...m, tick: m.tick + 1 }));
      scheduleSave();
    },
    [scheduleSave],
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

  // ── Outcome ───────────────────────────────────────────────────────────────
  const padEnabled = phase === 'on_call' || phase === 'outcome';
  const setForm = useCallback((next: DispositionFormState, method: 'number_key' | 'click' = 'click') => {
    selectionMethodRef.current = method;
    setFormState(next);
    setPadRejection(null);
  }, []);

  const fullForm = useMemo(() => ({ ...form, notes }), [form, notes]);
  const requiredMissing = useMemo(
    () => Object.keys(validateCallFieldValues(fields, fieldValues, { requireFilled: true })).length > 0,
    [fields, fieldValues],
  );
  const saveBlockAt = useCallback(
    (now: number): SaveBlock | null => {
      const formBlock = blockReason(catalog, fullForm, now);
      if (formBlock === 'no_selection') return 'no_selection';
      if (phase !== 'outcome') return 'call_live';
      if (formBlock) return formBlock;
      if (requiredMissing) return 'fields_required';
      return null;
    },
    [catalog, fullForm, phase, requiredMissing],
  );

  const saveOutcome = useCallback(async () => {
    const target = call;
    if (!target || saving || !tenantId || !accountId) return;
    const now = clock.now();
    const fieldProblems = validateCallFieldValues(fields, fieldValues, { requireFilled: true });
    if (Object.keys(fieldProblems).length > 0) {
      setFieldErrors(fieldProblems);
      setAnnouncement(SAVE_BLOCK_COPY.fields_required);
      return;
    }
    if (saveBlockAt(now) !== null) return;
    const payload = buildSubmitPayload(catalog, fullForm, now);
    if (!payload) return;
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaving(true);
    setPadRejection(null);
    const cleaned = cleanFieldValues(fields, fieldValues);
    const result = await dispositionManualCall(
      target.id,
      {
        code: payload.disposition_code,
        ...(payload.notes ? { notes: payload.notes } : {}),
        ...(payload.callback_at ? { callback_at: payload.callback_at } : {}),
        // Absent until the field set is known: the server then keeps (and checks) the stored values.
        ...(fieldsKnown ? { fields: cleaned } : {}),
      },
      tenantId,
      accountId,
    );
    setSaving(false);
    if (result.ok) {
      adoptCall(result.value.call);
      setAnnouncement('Outcome saved.');
      trackAgencySoftphoneOutcomeSaved({
        tagged: Boolean(target.tag),
        selection_method: selectionMethodRef.current,
        field_count: Object.keys(cleaned).length,
        has_callback: Boolean(payload.callback_at),
      });
      return;
    }
    const refusal = result.refusal;
    if (refusal.code === 'disposition_invalid' && refusal.allowed_codes?.length) {
      setCatalogOverride({ callId: target.id, catalog: resyncCatalog(catalog, refusal.allowed_codes) });
      setPadRejection(CATALOG_CHANGED_COPY);
    } else if (refusal.code === 'fields_invalid') {
      if (refusal.details) setFieldErrors(fieldErrorsFromDetails(refusal.details));
      setPadRejection(SOFTPHONE_REFUSAL_COPY.fields_invalid);
    } else if (refusal.code === 'call_settled') {
      // Saved already (another window, a supervisor on our behalf): the server's
      // view of the call is what retires it here.
      setPadRejection(SOFTPHONE_REFUSAL_COPY.call_settled);
      loadBootstrap();
    } else {
      setPadRejection(refusalCopy(refusal));
    }
    setAnnouncement(`The outcome wasn’t saved. ${refusalCopy(refusal)}`);
  }, [call, saving, tenantId, accountId, clock, fields, fieldsKnown, fieldValues, saveBlockAt, catalog, fullForm, adoptCall, loadBootstrap]);

  // ── Hang up ───────────────────────────────────────────────────────────────
  const hangup = useCallback(async () => {
    const target = call;
    if (!target || !isCallLive(target) || !tenantId || !accountId) return;
    setHangupFailure(null);
    const result = await hangupManualCall(target.id, tenantId, accountId);
    trackAgencySoftphoneHangup({
      state: target.state as 'queued' | 'dialing' | 'ringing' | 'answered' | 'bridged',
      accepted: result.ok,
    });
    if (result.ok) {
      adoptCall(result.value);
      return;
    }
    if (result.refusal.code === 'call_settled' || result.refusal.code === 'call_not_found') {
      loadBootstrap();
      return;
    }
    setHangupFailure(`We couldn’t end the call — you may still be connected. ${refusalCopy(result.refusal)}`);
  }, [call, tenantId, accountId, adoptCall, loadBootstrap]);

  // ── Mark DNC ──────────────────────────────────────────────────────────────
  const dncEnabled = call !== null && (phase === 'on_call' || phase === 'outcome' || phase === 'ringing');
  const openDnc = useCallback(() => {
    if (!dncEnabled || dncInFlight) return;
    setDncFailure(null);
    setDncConfirmOpen(true);
  }, [dncEnabled, dncInFlight]);
  const cancelDnc = useCallback(() => {
    if (dncInFlight) return;
    setDncConfirmOpen(false);
  }, [dncInFlight]);
  const confirmDnc = useCallback(async () => {
    const target = call;
    if (!target || !tenantId || !accountId) return;
    setDncInFlight(true);
    const result = await markManualCallDnc(target.id, undefined, tenantId, accountId);
    setDncInFlight(false);
    setDncConfirmOpen(false);
    trackAgencySoftphoneDncMarked({ tagged: Boolean(target.tag), accepted: result.ok });
    if (result.ok) {
      const where = result.value.scope === 'campaign' && target.tag
        ? `for ${target.tag.campaign_name}`
        : 'for the whole workspace';
      const text = `${formatDialNumber(result.value.phone_e164)} is on the Do Not Call list ${where}.`;
      setDncOutcome(text);
      setAnnouncement(text);
      return;
    }
    const text = `We couldn’t add the number to Do Not Call. ${refusalCopy(result.refusal)}`;
    setDncFailure(text);
    setAnnouncement(text);
  }, [call, tenantId, accountId]);

  // ── Redial ────────────────────────────────────────────────────────────────
  const redial = useCallback(
    (from: AgencyManualCall) => {
      if (call !== null || placing) return;
      entryRef.current = 'redial';
      setNumberState(sanitiseDialInput(from.destination_e164));
      const tagId = from.tag?.campaign_id ?? null;
      const tagOk = tagId === null || taggableCampaigns.some((c) => c.campaign_id === tagId);
      setTagDraft(tagOk ? tagId : null);
      setCallerDraft(from.caller_id);
      setDialError(null);
      setFocusCallToken((n) => n + 1);
    },
    [call, placing, taggableCampaigns],
  );

  return {
    bootstrap,
    bootstrapError,
    reloadBootstrap: loadBootstrap,
    call,
    phase,
    lastCall,
    number,
    numberDisplay: formatDialNumber(number),
    setNumber,
    pressKey,
    backspace,
    pasteNumber,
    dialBlock,
    canDial,
    dialUnavailableReason,
    placing,
    dialError,
    dial,
    taggableCampaigns,
    tagCampaignId,
    setTagCampaignId,
    campaign,
    callerIdOptions: call ? [call.caller_id] : callerIdOptions,
    callerId,
    setCallerId,
    setupEditable,
    fields,
    fieldValues,
    setFieldValue,
    fieldErrors,
    catalog,
    form,
    setForm,
    padEnabled,
    padDisabledReason: padEnabled ? null : SOFTPHONE_PAD_DISABLED_COPY,
    padRejection,
    saveBlockAt,
    saving,
    saveOutcome: () => void saveOutcome(),
    notes,
    setNotes,
    notesEnabled,
    notesStatus: notesStatusLine,
    hangup: () => void hangup(),
    hangupFailure,
    muted: audio.muted,
    muteEnabled: audio.sending || phase === 'ringing',
    toggleMute: audio.toggleMute,
    dncConfirmOpen,
    openDnc,
    cancelDnc,
    confirmDnc: () => void confirmDnc(),
    dncInFlight,
    dncOutcome,
    dncFailure,
    dncEnabled,
    overridePrompt,
    overrideSubmitting: placing && overridePrompt !== null,
    overrideError,
    confirmOverride,
    cancelOverride,
    recent,
    recentLoading,
    recentError,
    redial,
    focusCallToken,
    phaseAnnouncement: politeAnnouncement,
    announcement,
  };
}

/** `fields_invalid` details (`fields.<key>` or `<key>`) → errors by field key. */
export function fieldErrorsFromDetails(details: Array<{ path: string; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { path, message } of details) {
    const key = path.replace(/^fields[.[]/, '').replace(/\]$/, '');
    out[key] = message;
  }
  return out;
}
