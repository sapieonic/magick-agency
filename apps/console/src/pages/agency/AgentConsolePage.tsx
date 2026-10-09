import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  createAgencySession,
  hangupAttempt,
  leaveAgencySession,
  markContactDnc,
} from '../../api/agency';
import { usePermission } from '../../hooks/usePermission';
import { getRoleLevel } from '../../utils/permissions';
import { useAgencyConsole } from './useAgencyConsole';
import { StateRail } from '../../components/agency/StateRail';
import type { StationConnection } from '../../hooks/useAgencyStation';
import {
  DispositionPad,
  type DispositionPadHandle,
} from '../../components/agency/DispositionPad';
import { DncControl, type DncControlHandle } from '../../components/agency/DncControl';
import {
  dncFailureCopy,
  dncOutcomeCopy,
  hangupFailureCopy,
  type DncScope,
} from '../../utils/agencyDncCopy';
import { NotesField } from '../../components/agency/NotesField';
import { BreakMenu, type BreakMenuHandle } from '../../components/agency/BreakMenu';
import { CueSettings } from '../../components/agency/CueSettings';
import { StationIdentity } from '../../components/agency/StationIdentity';
import { StationMenu } from '../../components/agency/StationMenu';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import {
  LEAVE_CONFIRM_ACTION,
  LEAVE_CONFIRM_MESSAGE,
  LEAVE_CONFIRM_TITLE,
  agentLandingPath,
} from '../../utils/agencyStationExit';
import {
  IDLE_GUIDE_HEADING,
  IDLE_GUIDE_INTRO,
  IDLE_KEYS_NOW,
  IDLE_KEYS_ON_CALL,
  IDLE_PAUSED_HINT,
  IDLE_WAITING_HINT,
} from '../../utils/agencyStationIdle';
import {
  SWITCH_CONFIRM_ACTION,
  SWITCH_CONFIRM_TITLE,
  conflictIsMidCall,
  joinConflictCopy,
  joinConflictFallbackSentence,
  parseJoinConflict,
  switchActionLabel,
  switchConfirmMessage,
  switchFailureCopy,
  type SwitchStage,
} from '../../utils/agencyJoinConflict';
import {
  clearLiveSession,
  coalesceJoin,
  localJoinConflict,
  readLiveSession,
  rememberLiveSessionFromBootstrap,
  rememberLiveSessionFromConflict,
  touchLiveSessionState,
  LIVE_SESSION_TOUCH_MS,
} from '../../utils/agencyLiveSession';
import { QueuedBreakPill } from '../../components/agency/QueuedBreakPill';
import { HoldToConfirmButton } from '../../components/agency/HoldToConfirmButton';
import { agencyAudioNotice } from '../../utils/agencyAudioCopy';
import { resolveContextFields, heroesWereConfigured } from '../../utils/agencyContext';
import { fieldMatchesFilter, highlightSegments } from '../../utils/agencyFieldFilter';
import { resolveReleaseCopy, releaseShape, releaseAccount } from '../../utils/agencyReleaseCopy';
import {
  DISPOSITION_BLOCK_COPY,
  dispositionForNumberKey,
} from '../../utils/agencyDispositionForm';
import {
  groupPriorAttempts,
  priorDispositionIsRaw,
  priorDispositionLabel,
} from '../../utils/agencyPriorAttempts';
import type {
  AgencyActionErrorCode,
  AgencySessionBootstrap,
  AgencySessionConflict,
} from '../../types/agency';
import { agencyPersona } from '../../utils/agencyPersona';
import {
  trackAgencyStationJoined,
  trackAgencyStationJoinFailed,
  trackAgencyHangupRequested,
  trackAgencyHangupFailed,
  trackAgencyDncMarked,
  trackAgencyDncFailed,
  trackAgencyStationExit,
  trackAgencyStationSwitchCampaign,
  trackAgencyShortcutUsed,
  trackAgencyDispositionBlocked,
} from '../../analytics/events';
import styles from './AgentConsolePage.module.css';

/**
 * The Agent Console — Phase 2.
 *
 * Phase 1 shipped this page with a local `describeRail`, a bare "Go available"
 * button and a hang-up. Everything Phase 2 needs already existed as tested
 * components; **nothing composed them**, which is the state this file ends.
 *
 * Three structural rules drive the markup and are each easy to undo by accident:
 *
 *  1. **Geometry is frozen.** Column widths and order never change between
 *     states. A control that moves 12px between "ringing" and "connected" is a
 *     misclick, and a misclick on this screen hangs up on a human being. Every
 *     region renders in every state; only content and colour change.
 *  2. **Only authoritative frames move the UI.** Everything visual is derived
 *     from `useAgencyConsole`, which routes bridge-originated `status`/`ended` to
 *     a diagnostic sink. The connect treatment keys off `bridgedAt` — set by
 *     `bridged` and nothing else (§A.13.1).
 *  3. **Tab order is fixed and does not vary by state** (§A.13.9): rail →
 *     column 1 → column 2 → column 3 (pad, then notes) → action bar (Break →
 *     Save → Hang up). Inactive controls are `disabled` so they are *skipped*
 *     rather than reordered, which is the mechanism that keeps the order stable —
 *     and the reason every region renders in every state.
 *
 * The `⚙` station menu (`MAG-160`) obeys all three: it is in the **header**
 * beside cue settings — never the action bar, whose Break → Save → Hang up
 * sequence rule 3 pins — and its items are refused in place with a stated reason
 * rather than disappearing, so nothing moves. (They are refused on *different*
 * states: Exit is additionally refused while `available`, because it leaves the
 * agent in the dialable pool with no console attached. The whole argument lives
 * at the predicates in `agencyStationExit.ts`.) There
 * is deliberately no single-key shortcut for either: §A.9's keys are for the
 * call in front of the agent, and a stray keypress that ends a session would be
 * the worst possible thing to bind a letter to.
 *
 * `C` (callback), `D` (mark DNC) and `/` (contact-panel field filter, §A.6.3)
 * ARE wired, as of `AD-P3-U-03`/`MAG-90` — `C` through the pad's handle so the
 * selection and the focus move together, `D` through the DNC control's, so the
 * key opens the same confirmation the button does, and `/` by focusing the
 * filter input directly, since it owns no confirmation and no selection to
 * hand off.
 */
/**
 * The `<input>` types a printable key belongs to, i.e. the positions §A.9's
 * single-key shortcuts must stay out of.
 *
 * A **deny**-list rather than an allow-list, because the unknown case has to fall
 * on the suppressing side: an `<input>` with no `type` is a text box in every
 * browser, as is one whose `type` this list has never heard of.
 *
 * The guard used to be `tag === 'INPUT'`, which is too wide by exactly these — a
 * radio, a checkbox and a range slider have no use for the letter `b`, so treating
 * them as text fields made **every** page shortcut dead while focus sat inside the
 * cue-settings popover: the one surface the agent who cannot hear the cues has to
 * open (`AD-P2-U-07`), and the same "operable but effectively unreachable" shape
 * that surface was moved to the header to avoid. §A.9 suppresses these keys so that
 * typing a note containing "b" cannot open the break menu mid-sentence; a radio
 * group cannot produce that failure and so does not earn the suppression.
 *
 * This was invisible because `AgentConsolePage.cueVisual.test.tsx`'s `press()`
 * fired at `document` instead of at the focused element — the exact class `MAG-90`
 * called out in writing.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'radio',
  'checkbox',
  'range',
  'button',
  'submit',
  'reset',
  'file',
  'color',
  'image',
]);

export default function AgentConsolePage() {
  const [params] = useSearchParams();
  const campaignId = params.get('campaign') ?? '';
  const { tenantId, accountId, role } = useTenant();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [bootstrap, setBootstrap] = useState<AgencySessionBootstrap | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  /**
   * The `409 session_on_other_campaign` refusal, kept apart from `joinError`.
   *
   * Same failure to join, two different screens: `joinError` is a sentence, and
   * this one names a campaign, a state and a link. Collapsing them into one
   * string would throw away the campaign id, which is the only part of the body
   * the agent can act on.
   */
  const [joinConflict, setJoinConflict] = useState<AgencySessionConflict | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailure, setLeaveFailure] = useState<string | null>(null);
  /**
   * The join-conflict screen's one-click remedy: leave the other campaign's
   * station and rejoin here, without navigating away first (see
   * `confirmSwitch` below and `agencyJoinConflict.ts`'s `SwitchStage`). Kept
   * apart from `leaveConfirm`/`leaving`/`leaveFailure` — those describe a
   * `Leave station` the agent runs against their OWN, currently-open session,
   * while this one only ever exists on the conflict screen, before any
   * session at all is open here.
   */
  const [switchConfirm, setSwitchConfirm] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchFailure, setSwitchFailure] = useState<string | null>(null);
  /**
   * Guards `confirmSwitch`'s `setState` calls against a hard navigation or
   * closed tab mid-chain. The three requests it chains cannot themselves be
   * cancelled — there is no `AbortController` on this API layer (the same gap
   * `onExport`'s CSV download documents elsewhere) — so a leave-and-rejoin
   * that is already in flight still completes server-side either way; this
   * only stops the component from setting state once nothing is listening.
   *
   * Set on the way IN as well as cleared on the way out — see
   * `AgencyAnalyticsPage.tsx`'s `mounted` ref for the reason spelled out in
   * full: `React.StrictMode` runs every effect setup → cleanup → setup in
   * development, so a cleanup-only effect left this `false` for the rest of
   * the page's life. `confirmSwitch` would then set `switching` and never
   * clear it — a permanent "Switching…" with Cancel doing nothing, even once
   * the three requests had already committed. (Caught in review on PR #277.)
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const consoleRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const breakMenuRef = useRef<BreakMenuHandle | null>(null);
  const padRef = useRef<DispositionPadHandle | null>(null);
  const dncRef = useRef<DncControlHandle | null>(null);
  const fieldFilterRef = useRef<HTMLInputElement>(null);
  /** Analytics-only: which session `agency_station_joined` has already fired for. */
  const stationJoinTrackedRef = useRef<string | null>(null);
  const liveAttemptRef = useRef<string | null>(null);
  /**
   * The **panel's** attempt as of now — `live`'s, or the one retained through
   * wrap-up (`MAG-126`).
   *
   * A second ref beside `liveAttemptRef` rather than a replacement for it,
   * because the two answer different questions and a single ref would have to
   * pick one. A hang-up failure is about a call that is still up, so it dies with
   * `live`; a DNC result is about a *contact*, and the contact stays on screen for
   * the whole wrap-up window. Each piece of state is guarded by the ref whose
   * lifetime matches it, and each ref is written by the effect that resets that
   * same state — the guard boundary and the reset boundary are the same boundary,
   * which is the property this ticket exists to restore.
   */
  const panelAttemptRef = useRef<string | null>(null);

  // §A.6.3: matches header and value, case-insensitive, substring, as you type.
  const [fieldFilter, setFieldFilter] = useState('');

  const [dncInFlight, setDncInFlight] = useState(false);
  const [dncOutcome, setDncOutcome] = useState<string | null>(null);
  const [dncFailure, setDncFailure] = useState<string | null>(null);
  /**
   * Why a hang-up can be reported as failed at all (`MAG-112`).
   *
   * There was nowhere to put this before, because the rejection was swallowed —
   * and it was swallowed on the reasoning that the socket frame had already done
   * the job. Neither path worked, so the button's only feedback was the
   * `released` frame that was never coming, and the agent was left holding a
   * live call with a button that looked like it had fired.
   */
  const [hangupFailure, setHangupFailure] = useState<string | null>(null);
  // Floor is `agent` (level 5), so every agent holds it — but a supervisor
  // watching a station from a lower-privileged membership does not, and a bare
  // greyed button on this screen reads as an outage.
  const mayMarkDnc = usePermission('agency.dnc.write');
  // The tenant-wide escalation is a DIFFERENT, higher floor — `agency.dnc.manage`
  // (`account_admin`), the same permission master requires to remove an entry.
  // Marking campaign-scoped stays at `agent`; only the wider, harder-to-undo
  // escalation is gated behind this.
  const mayMarkDncTenantWide = usePermission('agency.dnc.manage');

  const cons = useAgencyConsole(bootstrap, tenantId ?? undefined, accountId ?? undefined);

  /**
   * The catalog a prior attempt's disposition may be resolved through — THIS
   * campaign's for this campaign's attempts, and nothing at all for an
   * ancestor's.
   *
   * Disposition codes are campaign-local: each campaign carries its own
   * `disposition_catalog`, and a retry may have been authored with a different
   * one from its parent. Resolving an ancestor's code through the child's
   * catalog therefore prints THIS campaign's label as the historical write-up —
   * "Callback" where the parent's catalog said "Wrong number" — which is worse
   * than the raw code, because it is a plausible sentence that is false. The
   * agent is reading this panel precisely to know what happened LAST time.
   *
   * The raw-code fallback is already the designed answer for a code the catalog
   * does not carry (`data-unlabelled` styles it as a slug rather than passing an
   * enum off as prose), so an ancestor group simply takes that path.
   */
  const priorCatalog = useCallback(
    (isCurrent: boolean) => (isCurrent ? bootstrap?.disposition_catalog : undefined),
    [bootstrap],
  );
  const { station, clock, audio } = cons;
  const { connection, agentState, live, retainedAttempt, release, dialing, missedPings } = station;
  const micNotice = agencyAudioNotice(audio.error);

  useEffect(() => {
    if (!campaignId) {
      setJoinError('No campaign selected.');
      trackAgencyStationJoinFailed({ reason: 'no_campaign', conflict_state: null });
      return;
    }
    /**
     * Wait for BOTH ids before joining.
     *
     * `TenantContext` resolves the account asynchronously — it is null on first
     * render and again for a moment after a tenant switch. Joining in that
     * window sends no `X-Account-Id`, master forwards no `x-mgkvc-account`, and
     * core answers the exact 400 this console was fixed to stop producing.
     *
     * The retry when the account lands then succeeds, which is what made this
     * survivable-looking and is precisely why it was not: `joinError` gates the
     * whole render ahead of `bootstrap`, so the page stayed on the error screen
     * behind a session that had joined perfectly well. Clearing it on entry is
     * the other half of the fix — a guard alone would still strand anyone whose
     * first attempt failed for a real reason that later resolved.
     */
    if (!tenantId || !accountId) return;

    /**
     * Refuse locally when this browser already knows the agent is live on
     * another campaign. The 409 from `POST /sessions` is core doing its job;
     * firing it from a view that already has the answer is the UAT warning
     * ("already live on another campaign") and MAG-134's "don't send the
     * click" rule applied to the join path. Resume of the SAME campaign still
     * POSTs — that is a refresh of this station, not a second join.
     */
    const cached = localJoinConflict(tenantId, campaignId);
    if (cached) {
      setJoinError(null);
      setJoinConflict(cached);
      trackAgencyStationJoinFailed({
        reason: 'session_on_other_campaign',
        conflict_state: cached.state,
      });
      return;
    }

    let cancelled = false;
    setJoinError(null);
    setJoinConflict(null);
    const joinKey = `${tenantId}:${accountId}:${campaignId}`;
    coalesceJoin(joinKey, () => createAgencySession(campaignId, tenantId, accountId))
      .then((session) => {
        rememberLiveSessionFromBootstrap(tenantId, session);
        if (!cancelled) setBootstrap(session);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          /**
           * Still write the cache on a cancelled 409: StrictMode's simulated
           * unmount would otherwise drop the only copy of "you are live
           * elsewhere" and the remount would POST again.
           */
          const conflict = parseJoinConflict(err);
          if (conflict) rememberLiveSessionFromConflict(tenantId, conflict);
          return;
        }
        /**
         * The one refusal the tenant-wide live-session rule makes reachable for
         * an ordinary agent: they are still joined to another campaign. It is an
         * answer with a remedy in it, so it must not fall through to the generic
         * message — core states the campaign and their state there precisely so
         * this screen can name both. See `agencyJoinConflict.ts`.
         */
        const conflict = parseJoinConflict(err);
        if (conflict) {
          rememberLiveSessionFromConflict(tenantId, conflict);
          setJoinConflict(conflict);
          trackAgencyStationJoinFailed({
            reason: 'session_on_other_campaign',
            conflict_state: conflict.state ?? null,
          });
          return;
        }
        /**
         * A conflict body the parser REFUSED — a structured field missing or
         * unreadable — still carries core's own sentence, and that is a better
         * thing to put in front of an agent than the generic fallback. The
         * parser stays strict on purpose (a conflict screen that names no
         * campaign reads as broken), so the degraded reading is chosen here
         * rather than by loosening it.
         */
        setJoinError(
          joinConflictFallbackSentence(err)
            ?? (err instanceof Error ? err.message : 'Could not join the campaign.'),
        );
        trackAgencyStationJoinFailed({
          reason: joinConflictFallbackSentence(err)
            ? 'conflict_unreadable'
            : (campaignId ? 'api_error' : 'no_campaign'),
          conflict_state: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, tenantId, accountId]);

  /**
   * `agency_station_joined`, decoupled from the join effect above.
   *
   * `role` comes from tenant membership, which can still be unresolved when
   * `createAgencySession` settles — that effect is keyed on
   * `[campaignId, tenantId, accountId]`, not `role`, so firing the event
   * inline in its `.then()` meant a successful join with a not-yet-resolved
   * role permanently skipped the adoption event, with no later retry. This
   * effect instead fires as soon as BOTH `bootstrap` and a resolvable persona
   * are available, whichever settles second, and is deduped per session id so
   * a later re-render (e.g. `role` changing shape without changing persona)
   * cannot double-fire it.
   */
  useEffect(() => {
    if (!bootstrap) return;
    const persona = agencyPersona(role);
    if (!persona) return;
    if (stationJoinTrackedRef.current === bootstrap.session_id) return;
    stationJoinTrackedRef.current = bootstrap.session_id;
    trackAgencyStationJoined({
      persona,
      campaign_id: bootstrap.campaign_id,
      disposition_count: bootstrap.disposition_catalog.length,
      break_reason_count: bootstrap.break_reasons.length,
      wrapup_seconds: bootstrap.wrapup_seconds,
      wrapup_auto_return: bootstrap.wrapup_auto_return,
      record_calls: bootstrap.record_calls,
      // `AgencySessionBootstrap.context_display` carries only the hero/order/
      // hidden display overrides, not the full set of contact-context fields a
      // campaign's CSV configured — that count is only knowable per-attempt,
      // from the attempt's own `context` keys (`resolveContextFields`). Not
      // available at join time.
      context_field_count: 0,
    });
  }, [bootstrap, role]);

  /**
   * Keep the cached live-session state current while this station is open, so
   * a second tab that reads it can still refuse a mid-call switch. No-ops
   * unless the cache is THIS campaign — a stale conflict record for another
   * campaign must not be rewritten from this console's state.
   *
   * `session_gone` is terminal (4404): core no longer has this session, and
   * reconnecting cannot help. Touching after that would keep a second campaign
   * refused locally for as long as this page stays mounted. Clear only when
   * the record is still this campaign — another tab may already have written
   * a newer one.
   */
  useEffect(() => {
    if (!tenantId || !bootstrap) return;
    if (connection === 'session_gone') {
      const cached = readLiveSession(tenantId);
      if (cached?.campaignId === bootstrap.campaign_id) clearLiveSession(tenantId);
      return;
    }
    touchLiveSessionState(tenantId, bootstrap.campaign_id, agentState);
    const timer = window.setInterval(() => {
      touchLiveSessionState(tenantId, bootstrap.campaign_id, agentState);
    }, LIVE_SESSION_TOUCH_MS);
    return () => window.clearInterval(timer);
  }, [tenantId, bootstrap, agentState, connection]);

  /**
   * Focus moves exactly ONCE per call — to the console root, on reservation — and
   * never at connect. Stealing focus at connect would interrupt a screen-reader
   * user mid-sentence at the worst possible moment.
   */
  useEffect(() => {
    if (live && live.bridgedAt === null) consoleRef.current?.focus();
  }, [live?.attempt.attempt_id, live]);

  /**
   * The **live** attempt as of *now*, for the hang-up rejection to check itself
   * against.
   *
   * A ref rather than the closed-over value: the rejection resolves after the
   * render that created the handler, and a new `reserved` may have landed in
   * between. Reporting the previous call's failure over the new one is the same
   * stale-response hazard §A.13.6 refuses for dispositions.
   *
   * Clearing on change is part of the same rule — a failure notice must not
   * outlive the call it describes. And `live` is deliberately the right scope
   * *here*, where the DNC result below needs the panel's: every sentence
   * `hangupFailureCopy` can produce ends in "you are still connected", which
   * stops being true the instant `released` lands. A notice that outlived the
   * call would be telling the agent they are on a call that is over.
   */
  useEffect(() => {
    liveAttemptRef.current = live?.attempt.attempt_id ?? null;
    setHangupFailure(null);
  }, [live?.attempt.attempt_id]);

  /** The attempt whose details stay on screen — live, or retained through wrap-up. */
  const panelAttempt = live?.attempt ?? retainedAttempt;

  const resolved = useMemo(
    () => (panelAttempt ? resolveContextFields(panelAttempt.context, bootstrap?.context_display) : null),
    [panelAttempt, bootstrap?.context_display],
  );

  /**
   * §A.6.3. Scoped to tier 2 (`resolved.fields`) only — the hero row is capped at
   * four and always visible, and the empty-field disclosure is already collapsed
   * to one summary row, so neither is the "40 rows is scan cost" problem this
   * filter exists to solve.
   */
  const filteredFields = useMemo(
    () => resolved?.fields.filter((field) => fieldMatchesFilter(field, fieldFilter)) ?? [],
    [resolved, fieldFilter],
  );

  /**
   * Prior attempts, split by the campaign each one came from.
   *
   * Memoised on the attempt, not on the array: `prior_attempts` arrives as part
   * of one `reserved` frame and never changes for the life of that attempt, so
   * this runs once per call — which matters because everything on this panel is
   * computed while a customer is already ringing.
   *
   * The bootstrap supplies the fallback identity for a group with no campaign
   * of its own; see `groupPriorAttempts` for why that is "this campaign" rather
   * than a placeholder.
   */
  const priorGroups = useMemo(
    () =>
      panelAttempt
        ? groupPriorAttempts(
            panelAttempt.prior_attempts,
            panelAttempt.campaign_id,
            panelAttempt.campaign_name,
          )
        : [],
    [panelAttempt],
  );

  const hangup = useCallback(() => {
    const attemptId = live?.attempt.attempt_id;
    if (!attemptId) return;
    setHangupFailure(null);
    trackAgencyHangupRequested({
      campaign_id: bootstrap?.campaign_id ?? '',
      was_bridged: Boolean(live?.bridgedAt),
      talk_seconds: live?.bridgedAt
        ? Math.floor((Date.now() - new Date(live.bridgedAt).getTime()) / 1000)
        : 0,
    });
    /**
     * **The HTTP route is the only hangup path** (`MAG-112`).
     *
     * This used to send the station socket's `hangup` control frame as the
     * primary and treat the HTTP call as belt-and-braces, swallowing its
     * rejection so "a failed fallback must not surface as an error for a hang-up
     * that worked". Exactly backwards: the frame was read by neither listener on
     * that socket and core registered no route, so the HTTP call was the only
     * one that could work — and it 404'd, silently, into that same catch. The
     * agent's hang-up button did nothing and said nothing.
     *
     * So the rejection is surfaced now. That is a fix only because the call is
     * real; making this catch visible on its own would have converted a silent
     * no-op into a loud one.
     *
     * **No automatic retry** — a retry landing after a new `reserved` hangs up a
     * different customer (§A.7.1.1), the same shape as the stale disposition
     * response §A.13.6 forbids. The agent retries by holding the button again.
     */
    void hangupAttempt(attemptId, tenantId ?? undefined, accountId ?? undefined).catch((err: unknown) => {
      // Guarded against a stale response: by the time this rejects the agent may
      // already be on a different call, and an error about the previous one is
      // worse than none.
      if (liveAttemptRef.current !== attemptId) return;
      setHangupFailure(hangupFailureCopy(err));
      // Same structured-code read `hangupFailureCopy`/`dncFailureCopy` use —
      // `details.code`, never `err.message`.
      const code =
        err !== null && typeof err === 'object'
          ? ((err as { details?: { code?: unknown } }).details?.code ?? null)
          : null;
      trackAgencyHangupFailed({
        campaign_id: bootstrap?.campaign_id ?? '',
        code: typeof code === 'string' ? (code as AgencyActionErrorCode) : 'unknown',
      });
    });
  }, [live?.attempt.attempt_id, live?.bridgedAt, tenantId, accountId, bootstrap]);

  /**
   * Where `Exit station` goes, and who is offered it at all.
   *
   * Above `agent` only: `/agency/campaigns/:id` sits inside the Agency
   * workspace, whose nav floors at `agency.campaigns.read` — a level-5 agent
   * would be navigated into a shell with nothing in it. Leaving, by contrast, is
   * everyone's: it is the only control that frees their live-session slot.
   *
   * A role level rather than a permission because this is not a gate on an API
   * call. Nothing about `agency.supervise` decides whether a page is worth
   * landing on, and borrowing it here would hide the exit from an `operator` or
   * `viewer` who can see the campaign perfectly well.
   */
  const canExitToCampaign = role !== undefined && getRoleLevel(role) > getRoleLevel('agent');
  /** Bootstrap's id is the authority; the query param is only how we got here. */
  const stationCampaignId = bootstrap?.campaign_id ?? campaignId;

  /**
   * Leave the station — the session-ending exit (§A.13.3).
   *
   * `leaveAgencySession` has existed since Phase 1 and was **called from
   * nowhere**: the console had no way out except closing the tab, which tells
   * core nothing until the heartbeat grace expires. It is wired here rather than
   * rewritten.
   *
   * Behind a confirmation because it is not undoable in one click — rejoining
   * means a fresh session and a fresh place in the pool — and because the same
   * menu carries an item one row away that does something quite different.
   *
   * On failure the dialog **stays open** carrying the reason, and the confirm
   * button becomes the retry. Navigating away on a leave that did not land would
   * leave the agent believing they had stopped receiving calls while core still
   * had them in the pool — the one outcome this control exists to prevent.
   */
  const confirmLeave = useCallback(() => {
    const sessionId = bootstrap?.session_id;
    if (!sessionId) return;
    setLeaving(true);
    setLeaveFailure(null);
    leaveAgencySession(sessionId, tenantId ?? undefined, accountId ?? undefined)
      .then(() => {
        if (tenantId) clearLiveSession(tenantId);
        setLeaveConfirm(false);
        /**
         * An agent goes to their landing screen, carrying `?left=station`: their
         * assignment is unchanged, so a plain `/app` would resolve it and send
         * them straight back into the station they just left. A supervisor goes
         * to the campaign they were watching.
         */
        navigate(
          canExitToCampaign ? `/agency/campaigns/${stationCampaignId}` : agentLandingPath('station'),
        );
        trackAgencyStationExit({
          campaign_id: stationCampaignId,
          action: 'leave',
          outcome: 'completed',
          blocked_reason: null,
          agent_state: agentState,
          destination: canExitToCampaign ? 'campaign' : 'landing',
        });
      })
      .catch((err: unknown) => {
        setLeaving(false);
        setLeaveFailure(
          err instanceof Error ? err.message : 'Your station is still open. Try again.',
        );
        trackAgencyStationExit({
          campaign_id: stationCampaignId,
          action: 'leave',
          outcome: 'failed',
          blocked_reason: null,
          agent_state: agentState,
          destination: null,
        });
      });
  }, [
    bootstrap?.session_id,
    tenantId,
    accountId,
    navigate,
    canExitToCampaign,
    stationCampaignId,
    agentState,
  ]);

  /**
   * What `confirmSwitch` has actually gotten done, kept across a retry.
   *
   * A rejoin failure used to leave the confirm button retrying the WHOLE
   * chain from `resume` — but by the time `rejoin` can fail, `leave` has
   * already succeeded, so redoing `resume` calls `createAgencySession` on the
   * campaign the agent just left, rejoining it (raised in review on PR #277).
   * Reset only where a switch attempt genuinely starts over: the button's
   * `onClick` below (a fresh conflict, nothing done yet) — never inside
   * `confirmSwitch` itself, so a retry after any failure resumes from
   * wherever the chain actually got to.
   */
  const switchProgressRef = useRef<{ otherSessionId: string | null; leftOther: boolean }>({
    otherSessionId: null,
    leftOther: false,
  });

  /**
   * The join-conflict screen's one-click remedy (`agencyJoinConflict.ts`).
   *
   * The conflict body core sends (`session_on_other_campaign`) names the OTHER
   * campaign and the agent's state there, but never a `session_id` — nothing
   * on that response was ever meant to be a session lookup key. `leaveAgencySession`
   * needs exactly that id, so getting one is the first of three chained
   * requests, not an extra: `createAgencySession(conflict.campaign_id)` for a
   * campaign the agent is ALREADY joined to is the same resume-in-place call
   * `/station?campaign=…` already relies on (a refreshed console tab does the
   * same thing), and it is the only place that id can come from.
   *
   * `conflictIsMidCall` gates whether the BUTTON is offered at all, on
   * `joinConflict.state` — a snapshot from whenever the agent first tried to
   * join, from a page with no socket open to the other campaign to keep it
   * current. It can be stale by the time this actually runs, so the resumed
   * session's OWN `state` — current, because this request just resumed that
   * exact session — is checked again before `leave` ever fires (raised in
   * review on PR #277: without this, an agent who went `available` → `on_call`
   * elsewhere could have that live call ended out from under them).
   */
  const confirmSwitch = useCallback(async () => {
    if (!joinConflict) return;
    const conflict = joinConflict;
    setSwitching(true);
    setSwitchFailure(null);
    const progress = switchProgressRef.current;

    let stage: SwitchStage = 'resume';
    try {
      if (!progress.leftOther) {
        let otherSessionId = progress.otherSessionId;
        if (!otherSessionId) {
          const otherSession = await createAgencySession(
            conflict.campaign_id,
            tenantId ?? undefined,
            accountId ?? undefined,
          );
          if (conflictIsMidCall(otherSession.state)) {
            // Not a request failure — the other campaign answered fine, and
            // it now has a live customer on it. Refreshing `joinConflict`
            // with the state just learned re-renders this same screen
            // honestly: the button disappears (mid-call gate), and the copy
            // stops offering a remedy this screen must not perform.
            if (mountedRef.current) {
              setSwitching(false);
              setSwitchConfirm(false);
              setJoinConflict({ ...conflict, state: otherSession.state });
            }
            trackAgencyStationSwitchCampaign({
              from_campaign_id: conflict.campaign_id,
              to_campaign_id: campaignId,
              agent_state: otherSession.state,
              outcome: 'blocked_mid_call',
              failed_stage: null,
            });
            return;
          }
          otherSessionId = otherSession.session_id;
          progress.otherSessionId = otherSessionId;
        }
        stage = 'leave';
        await leaveAgencySession(otherSessionId, tenantId ?? undefined, accountId ?? undefined);
        progress.leftOther = true;
        if (tenantId) clearLiveSession(tenantId);
      }

      stage = 'rejoin';
      const session = await createAgencySession(campaignId, tenantId ?? undefined, accountId ?? undefined);
      if (tenantId) rememberLiveSessionFromBootstrap(tenantId, session);

      // Tracking fires regardless of mount — it records what actually
      // happened server-side, which the requests already committed to before
      // this line ran. Only the `setState` calls need the guard.
      if (mountedRef.current) {
        setSwitching(false);
        setSwitchConfirm(false);
        setJoinConflict(null);
        setBootstrap(session);
      }
      trackAgencyStationSwitchCampaign({
        from_campaign_id: conflict.campaign_id,
        to_campaign_id: campaignId,
        agent_state: conflict.state,
        outcome: 'completed',
        failed_stage: null,
      });
    } catch (err: unknown) {
      if (stage === 'rejoin') {
        /**
         * A conflict on the REJOIN leg means a third campaign's session beat
         * this one to the punch while the switch was in flight — the other
         * station is already closed, so the old screen no longer describes
         * anything real. Replacing `joinConflict` re-renders this same screen
         * for the new one, which is the one honest thing left to show.
         */
        const rejoinConflict = parseJoinConflict(err);
        if (rejoinConflict) {
          // Leave already cleared the previous station. Without writing this
          // conflict, a remount POSTs `/sessions` again and recreates the
          // "already live on another campaign" warning the cache exists to
          // suppress.
          if (tenantId) rememberLiveSessionFromConflict(tenantId, rejoinConflict);
          if (mountedRef.current) {
            setSwitching(false);
            setSwitchConfirm(false);
            setJoinConflict(rejoinConflict);
          }
          trackAgencyStationSwitchCampaign({
            from_campaign_id: conflict.campaign_id,
            to_campaign_id: campaignId,
            agent_state: conflict.state,
            outcome: 'failed',
            failed_stage: stage,
          });
          return;
        }
        /**
         * An ordinary failure here means `leave` already succeeded — the
         * agent is not "still at" `conflict.campaign_name` any more, so
         * this screen has nothing true left to say and retrying THIS dialog
         * would call `createAgencySession(conflict.campaign_id)` again,
         * rejoining the campaign that was just left (raised in review on
         * PR #277). The ordinary join screen is the honest state instead —
         * it already knows how to retry: reloading this route re-runs the
         * plain join effect, which starts clean because the conflict really
         * is gone.
         */
        if (mountedRef.current) {
          setSwitching(false);
          setSwitchConfirm(false);
          setJoinConflict(null);
          setJoinError(switchFailureCopy(stage, conflict.campaign_name, err));
        }
        trackAgencyStationSwitchCampaign({
          from_campaign_id: conflict.campaign_id,
          to_campaign_id: campaignId,
          agent_state: conflict.state,
          outcome: 'failed',
          failed_stage: stage,
        });
        return;
      }
      if (mountedRef.current) {
        setSwitching(false);
        setSwitchFailure(switchFailureCopy(stage, conflict.campaign_name, err));
      }
      trackAgencyStationSwitchCampaign({
        from_campaign_id: conflict.campaign_id,
        to_campaign_id: campaignId,
        agent_state: conflict.state,
        outcome: 'failed',
        failed_stage: stage,
      });
    }
  }, [joinConflict, tenantId, accountId, campaignId]);

  /**
   * Exit station — navigation, and nothing else.
   *
   * The session stays live and the socket closes on unmount (the station hook's
   * cleanup, unchanged). That is the point of having two controls: a supervisor
   * who joined to cover ten minutes gets their screen back without telling the
   * dialer they have gone home. It is also why the two never share a label.
   */
  const exitStation = useCallback(() => {
    navigate(`/agency/campaigns/${stationCampaignId}`);
    trackAgencyStationExit({
      campaign_id: stationCampaignId,
      action: 'exit',
      outcome: 'completed',
      blocked_reason: null,
      agent_state: agentState,
      destination: 'campaign',
    });
    /**
     * `blocked_reason` is only ever `null` from this page: `StationMenu`'s
     * click handlers return early on `leaveBlocked`/`exitBlocked` before
     * calling `onLeave`/`onExit` at all (`aria-disabled` plus a handler guard,
     * never `disabled`), so a blocked attempt is never observable from here.
     * There is deliberately no `outcome: 'blocked'` variant wired up.
     */
  }, [navigate, stationCampaignId, agentState]);

  /**
   * Mark the contact on the line Do Not Call (§A.7.5), scoped to whichever of
   * the two choices the agent made in the dialog.
   *
   * The request asserts `scope`, not a campaign id — core already knows the
   * campaign from the attempt it is looking at, so this console has nothing to
   * name. `scope === 'campaign'` (the default) is sent explicitly rather than by
   * omission, so the request is self-describing in a log or a test even though
   * absent `scope` means the same thing server-side. `scope === 'tenant'` is the
   * escalation, floored server-side at `agency.dnc.manage`.
   *
   * Fired only from the confirmation dialog — there is no path from a single key
   * or a single click to the request. The outcome copy is scoped to *both* which
   * choice was made and what the response actually promised: on the tenant-wide
   * escalation, `dnc_recorded: false` means that wider list write is still in
   * flight, and claiming it anyway is the overstatement §A.7.5 forbids.
   *
   * **No retry.** A retry landing after a new `reserved` would suppress a
   * different customer — the same hazard §A.7.1.1 refuses for the hang-up.
   */
  const confirmDnc = useCallback(
    (scope: DncScope, origin: 'shortcut' | 'click') => {
      const attemptId = live?.attempt.attempt_id;
      if (!attemptId) return;
      setDncInFlight(true);
      setDncFailure(null);
      setDncOutcome(null);
      markContactDnc(
        attemptId,
        { scope },
        tenantId ?? undefined,
        accountId ?? undefined,
      )
        .then((response) => {
          // Same stale guard as the hang-up above, and for a sharper reason: the
          // effect below only clears the outcome *when the panel's attempt
          // changes*, so a response resolving after the next `reserved` re-paints
          // the previous contact's DNC result onto the new call. "Added to Do Not
          // Call" shown against the customer now on the line is a claim about the
          // wrong person.
          //
          // The guard reads the **panel's** attempt and not `live`'s (`MAG-126`).
          // `live` has a writer this used to ignore — `released` clears it — so
          // keyed on `live` all three of these handlers returned early at hangup,
          // for a contact still on screen and about to be dispositioned. That lost
          // the confirmation the agent had just earned and, because `finally` went
          // with it, left `dncInFlight` stuck true: a control reading "Marking…"
          // and disabled for the whole wrap-up window. `panelAttemptRef` still
          // moves on the next `reserved`, so the wrong-person guarantee above is
          // unchanged — it is the *only* thing that moves it.
          if (panelAttemptRef.current !== attemptId) return;
          setDncOutcome(dncOutcomeCopy(response, scope));
          trackAgencyDncMarked({
            campaign_id: bootstrap?.campaign_id ?? '',
            scope,
            dnc_recorded: response.dnc_recorded,
            opened_via: origin,
          });
        })
        .catch((err: unknown) => {
          if (panelAttemptRef.current !== attemptId) return;
          setDncFailure(dncFailureCopy(err));
          // Same structured-code read as the hang-up above.
          const code =
            err !== null && typeof err === 'object'
              ? ((err as { details?: { code?: unknown } }).details?.code ?? null)
              : null;
          trackAgencyDncFailed({
            campaign_id: bootstrap?.campaign_id ?? '',
            scope,
            code: typeof code === 'string' ? (code as AgencyActionErrorCode) : null,
          });
        })
        .finally(() => {
          if (panelAttemptRef.current !== attemptId) return;
          setDncInFlight(false);
        });
    },
    [live?.attempt.attempt_id, tenantId, accountId, bootstrap],
  );

  /**
   * A new **contact** clears the previous one's DNC result — it was about
   * someone else (`MAG-126`).
   *
   * Keyed on the panel's attempt, for the reason the effect below spells out at
   * length for the field filter: `released` sets `live` to null, so keyed on
   * `live?.attempt.attempt_id` this fired the moment the customer hung up, while
   * `panelAttempt` still showed that same contact for the whole wrap-up window.
   * "Added to Do Not Call" vanished from under the agent at exactly the moment
   * they were deciding what to write in the note — the console saying less than
   * it knew about a compliance action it had already taken.
   *
   * **The ref above moves with this key, and that is not a detail.** Re-keying
   * this effect alone would be a worse bug than the one it fixes: the handlers
   * guard on a ref, and if that ref still tracked `live` they would all return
   * early at hangup while this effect no longer fired — nothing would clear
   * `dncInFlight`, and the control would sit disabled reading "Marking…" for the
   * whole wrap-up window (`dncBlockReason` reports `in_flight` ahead of
   * `no_live_attempt`). Neither an outcome nor a failure, and no way back. The
   * two notions of "the current attempt" have to be the same notion.
   *
   * `dncInFlight` is still reset here, and it still has to be: on a `released`
   * with `requires_disposition: false` nothing is retained, the key goes to
   * `undefined`, and the handlers *do* return early — this is what frees the
   * control in that case. Where the panel is retained the request's own
   * `finally` clears it, because the guard now agrees the panel has not moved.
   */
  useEffect(() => {
    panelAttemptRef.current = panelAttempt?.attempt_id ?? null;
    setDncOutcome(null);
    setDncFailure(null);
    setDncInFlight(false);
  }, [panelAttempt?.attempt_id]);

  /**
   * §A.6.3: the filter clears on the next `reserved` event, not on every render
   * of the contact panel — and **not at hangup**.
   *
   * Keyed on the **panel's** attempt rather than `live`'s, because `live` has a
   * fourth writer this comment used to deny: `reserved` sets it, `bridged` and
   * `ready` replace it, and **`released` clears it** (`useAgencyStation`'s
   * `released` handler ends `setLive(null)`). Keyed on `live?.attempt.attempt_id`
   * the id therefore went `att-1 → undefined` the moment the customer hung up,
   * firing this effect while `panelAttempt` — `live?.attempt ?? retainedAttempt` —
   * still showed that same contact for the whole wrap-up window. An agent who had
   * filtered to find a policy number lost the query at exactly the moment they
   * started writing the note that quotes it.
   *
   * `panelAttempt.attempt_id` is that event and not a proxy for it: the `released`
   * handler retains the same attempt in the same task it clears `live` in, so the
   * key does not move across a wrap-up; it moves when a genuinely different
   * contact arrives. (On a `released` with `requires_disposition: false` nothing is
   * retained and the key does go to `undefined` — correct there, since the panel
   * has already given the contact up and there is no note to write.)
   *
   * Without any of this a filter left over from the last call could hide 38 of the
   * next contact's fields the moment the panel repopulates.
   */
  useEffect(() => {
    setFieldFilter('');
  }, [panelAttempt?.attempt_id]);

  /**
   * The global keyboard map (§A.9, §A.13.9).
   *
   * **All single-key shortcuts are suppressed while focus is inside a text
   * input**, except `Esc` and `Ctrl`/`Cmd`+`Enter` — otherwise typing a note
   * containing the letter "b" opens the break menu mid-sentence. `E`,`E` is not
   * here: `HoldToConfirmButton` owns it, so the hold fill and the double-tap
   * share one state machine rather than two that can disagree — and `C` and `D`
   * follow the same rule, each delegating to the component that owns the state.
   */
  const onWindowKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // `NON_TEXT_INPUT_TYPES` above carries the whole argument for why an
      // `<input>` is not automatically a text field.
      const inTextField =
        tag === 'TEXTAREA' ||
        target?.isContentEditable === true ||
        (tag === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type));

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        const accepted = cons.padEnabled && cons.block === null;
        if (accepted) {
          event.preventDefault();
          cons.submit();
        }
        trackAgencyShortcutUsed({
          campaign_id: bootstrap?.campaign_id ?? '',
          key: 'ctrl_enter',
          accepted,
        });
        if (!accepted && cons.block !== null) {
          trackAgencyDispositionBlocked({
            campaign_id: bootstrap?.campaign_id ?? '',
            reason: cons.block,
            method: 'ctrl_enter',
          });
        }
        return;
      }
      if (inTextField || event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();

      if (key === 'a') {
        // One key for two verbs, because the rail says which one is on offer and
        // the agent is never asked to remember (§A.13.3).
        if (agentState === 'offline') {
          event.preventDefault();
          cons.goAvailable('shortcut');
          trackAgencyShortcutUsed({ campaign_id: bootstrap?.campaign_id ?? '', key: 'a', accepted: true });
        } else if (agentState === 'break') {
          event.preventDefault();
          cons.endBreak('shortcut');
          trackAgencyShortcutUsed({ campaign_id: bootstrap?.campaign_id ?? '', key: 'a', accepted: true });
        } else {
          trackAgencyShortcutUsed({ campaign_id: bootstrap?.campaign_id ?? '', key: 'a', accepted: false });
        }
        return;
      }

      if (key === 'b') {
        event.preventDefault();
        breakMenuRef.current?.open();
        trackAgencyShortcutUsed({ campaign_id: bootstrap?.campaign_id ?? '', key: 'b', accepted: true });
        return;
      }

      if (key === 'n') {
        if (cons.notesEnabled) {
          event.preventDefault();
          notesRef.current?.focus();
        }
        trackAgencyShortcutUsed({
          campaign_id: bootstrap?.campaign_id ?? '',
          key: 'n',
          accepted: cons.notesEnabled,
        });
        return;
      }

      if (key === '/') {
        // §A.6.3. Focuses the filter input; nothing to enable/disable here — the
        // box is present at every density and in every call state, so there is
        // no "refuses" branch the way `C` and `N` have one. Once focus lands
        // inside the input, `inTextField` above is what stops this branch from
        // firing again — the second `/` types a literal slash rather than
        // re-focusing a field that already has focus.
        event.preventDefault();
        fieldFilterRef.current?.focus();
        trackAgencyShortcutUsed({ campaign_id: bootstrap?.campaign_id ?? '', key: 'slash', accepted: true });
        return;
      }

      if (key === 'c') {
        // Selects the callback code AND moves focus to the time row — both
        // halves, in the pad, so the key and a pointer share one state machine.
        // The pad refuses when it is disabled or the campaign has no
        // datetime-bearing code, and `preventDefault` follows the refusal so an
        // unhandled `c` still reaches the page as an ordinary key.
        //
        // Captured once into a local rather than called a second time for the
        // tracking call below — `selectCallback()` acts (it moves focus), so a
        // second invocation would be a second action, not a re-read.
        const selected = padRef.current?.selectCallback();
        if (selected) event.preventDefault();
        trackAgencyShortcutUsed({
          campaign_id: bootstrap?.campaign_id ?? '',
          key: 'c',
          accepted: Boolean(selected),
        });
        return;
      }

      if (key === 'd') {
        // Opens the confirmation, never the request. §A.7.5 exists for the
        // customer who says "take me off your list" and hangs up in three
        // seconds — reachable in one key, still impossible to do by accident.
        event.preventDefault();
        dncRef.current?.open();
        trackAgencyShortcutUsed({ campaign_id: bootstrap?.campaign_id ?? '', key: 'd', accepted: true });
        return;
      }

      if (key >= '1' && key <= '9') {
        if (!cons.padEnabled) return;
        // Index-based against the catalog **in the order core delivered it**. A
        // client-side sort would silently remap every agent's muscle memory the
        // moment an admin renames a code (§A.13.6).
        const entry = dispositionForNumberKey(cons.catalog, key);
        // Emitted once the pad is at least enabled — a digit typed while the pad
        // is closed isn't a shortcut attempt on this surface.
        trackAgencyShortcutUsed({
          campaign_id: bootstrap?.campaign_id ?? '',
          key: 'digit',
          accepted: Boolean(entry),
        });
        if (!entry) return;
        event.preventDefault();
        // Analytics-only: this code was picked by a number key, not a click.
        cons.noteCodeSelectionMethod('number_key');
        cons.setForm({ ...cons.form, selectedCode: entry.code });
        if (entry.requires_note) notesRef.current?.focus();
      }
    },
    [agentState, cons, bootstrap],
  );

  useEffect(() => {
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [onWindowKeyDown]);

  /*
    The join conflict, ahead of `joinError` — both are "the station did not
    open", and this one is the case with a remedy in it. One live session per
    agent per TENANT (core migration 092; 074's per-campaign comment was
    superseded deliberately), so being refused here means they are still joined
    somewhere else, and the link is the way to the Leave-station control that
    frees them.
  */
  if (joinConflict) {
    const copy = joinConflictCopy(joinConflict);
    // Only when it is safe: mid-call, the other station may only be left by
    // physically going there and finishing what is on screen — see
    // `conflictIsMidCall`.
    const midCall = conflictIsMidCall(joinConflict.state);
    return (
      <div className={styles.shell}>
        <div className={styles.fatal} role="alert" data-testid="join-conflict">
          <h1>{copy.headline}</h1>
          <p>{copy.detail}</p>
          <p>{copy.remedy}</p>
          {!midCall && (
            <button
              type="button"
              className={styles.fatalAction}
              onClick={() => {
                // A fresh attempt at a (possibly brand-new, post-swap)
                // conflict always starts from scratch.
                switchProgressRef.current = { otherSessionId: null, leftOther: false };
                setSwitchConfirm(true);
              }}
              data-testid="switch-station"
            >
              {switchActionLabel(joinConflict)}
            </button>
          )}
          {/*
            The one remaining way there when a direct switch is not offered
            (mid-call) or not wanted — quieter once the button above exists,
            primary again when it does not.
          */}
          <Link
            className={midCall ? styles.fatalAction : styles.fatalEscape}
            to={`/station?campaign=${encodeURIComponent(joinConflict.campaign_id)}`}
          >
            {copy.linkLabel}
          </Link>
          {/* The other station may refuse them too — a stopped campaign, say —
              so even this screen keeps the escape below it. */}
          <StationEscape toCampaign={canExitToCampaign} campaignId={stationCampaignId} />
        </div>

        {/*
          Shares `ConfirmDialog` with `Leave station` below — same focus trap,
          same Escape handling, same reason a failure replaces the message
          rather than appending to it. `disabled` is deliberately the only
          thing guarding a mid-flight request: `onCancel` still fires on
          Escape/overlay-click, and letting it close the dialog while
          `confirmSwitch`'s chain is still running would land its eventual
          rejection on a surface nobody can see, same as `confirmLeave`'s.
        */}
        <ConfirmDialog
          open={switchConfirm}
          title={SWITCH_CONFIRM_TITLE}
          message={switchFailure ?? switchConfirmMessage(joinConflict)}
          confirmLabel={switching ? 'Switching…' : SWITCH_CONFIRM_ACTION}
          disabled={switching}
          onConfirm={confirmSwitch}
          onCancel={() => {
            if (switching) return;
            setSwitchConfirm(false);
            setSwitchFailure(null);
          }}
        />
      </div>
    );
  }

  if (joinError) {
    return (
      <div className={styles.shell}>
        <div className={styles.fatal} role="alert">
          <h1>Can’t open the station</h1>
          <p>{joinError}</p>
          {/*
            ── This screen used to be a trap, and it is the common one ─────────
            It returns before the header, so there is no `StationMenu`, no nav,
            and no sidebar (the console is full-viewport, outside `AppLayout`).
            An assigned agent whose campaign is paused or stopped is refused
            here — and every route back (`/app`, `/`, the catch-all) resolves
            their assignment and returns them to this same screen. The only
            escape was a query param they could not know existed.

            The conflict screen above was given a link precisely because a dead
            end was unacceptable. This failure is far more likely than that one.
          */}
          <StationEscape toCampaign={canExitToCampaign} campaignId={stationCampaignId} />
        </div>
      </div>
    );
  }

  return (
    /*
      `data-connect-flash` is set ONLY when the audible cue could not carry the
      connect — a muted console, an `AudioContext` the browser refuses to run, or
      the agent's own `always`. For a hearing agent with working sound it is never
      set, which is the point: an unconditional flash 200 times a day is the visual
      equivalent of the haptics defect.

      **Connect, and only connect, lights the whole shell.** The three cues each get
      a rail flash (`StateRail`, keyed off `VISUAL_CUE_SPECS`); *scope* is the fourth
      axis separating them, and it is spent here, on the one event that means a
      stranger has started speaking to the agent. A ring and a hang-up do not earn
      the whole screen.
    */
    <div
      className={styles.shell}
      data-connect-flash={cons.connectFlashAttemptId !== null ? 'true' : undefined}
    >
      <header className={styles.header}>
        <div className={styles.identity}>
          <StationIdentity user={user} subline={bootstrap?.campaign_name ?? 'Loading…'} />
        </div>
        <div className={styles.headerRight}>
          {/* Recording is disclosed as a dot PLUS the word — in several
              jurisdictions the agent must announce it, and they cannot announce
              what they cannot see. */}
          {bootstrap?.record_calls ? (
            <span className={styles.recording}>
              <span className={styles.recordingDot} aria-hidden="true" />
              Recording
            </span>
          ) : null}
          {/* Muted is disclosed in the header as well as on the button. An agent
              who has to look at a toggle to find out whether they are audible
              will not look, and the failure is a customer hearing nothing while
              the talk timer runs — the exact shape of the bug the audio path
              was built to remove. */}
          {audio.muted ? (
            <span className={styles.muted} data-testid="muted-pill">
              <span className={styles.mutedDot} aria-hidden="true" />
              Muted
            </span>
          ) : null}
          {/*
            Cue settings live in the header, not the action bar (`AD-P2-U-07`).

            Two reasons, both about the agent rather than the layout. It is a
            **display** preference and not a call action — §A.13.9's action-bar
            sequence (Break → Save → … → Hang up) is the set of things that act on
            a live call, and a control that changes how the console looks does not
            belong between Mark DNC and Hang up. And it must be reachable in two
            keystrokes from a cold start: the agent most likely to need it is the
            one who cannot hear the cues, and making them Tab past the whole
            contact panel to find the switch is the same "operable but effectively
            unreachable" shape `AD-P2-U-04` was filed for.
          */}
          <CueSettings prefs={cons.cuePrefs} onChange={cons.setCuePrefs} />
          {/*
            The way OUT of the station, beside cue settings and deliberately not
            in the action bar: §A.13.9 fixes that bar's sequence (Break → Save →
            … → Hang up) as a tab-order guarantee, and an item inserted there
            moves controls an agent reaches by muscle memory — the neighbour
            being the one that hangs up on a person. Leaving is also not a call
            action, which is the same reasoning that put cue settings here.
          */}
          <StationMenu
            agentState={agentState}
            canExit={canExitToCampaign}
            leaving={leaving}
            onLeave={() => setLeaveConfirm(true)}
            onExit={exitStation}
          />
          <ConnectionHealthPill connection={connection} missedPings={missedPings} />
        </div>
      </header>

      {/*
        The microphone banner. `role="alert"` and above the rail, because this is
        the one console failure that is otherwise **completely invisible**: the
        panel populates, `bridged` arrives, the talk timer runs and the agent
        talks into nothing. It is not scoped to a call — a blocked microphone
        found during pre-flight has to be fixable before the first one arrives.
      */}
      {micNotice ? (
        <p className={styles.micFailure} role="alert" data-testid="mic-failure">
          <strong>{micNotice.headline}</strong> {micNotice.remedy}
          {/*
            The button IS the fix, not a link to it. A browser's autoplay policy
            is lifted by any user gesture, so for `audio_blocked` the click that
            dismisses the banner is the same click that resumes both contexts —
            and on a mid-call reload it is the only control the agent has any
            reason to press. `agencyAudioNotice` supplies `action` for exactly
            that one kind; every other failure needs something done outside the
            page, and a button there would be a promise we cannot keep.
          */}
          {micNotice.action ? (
            <button
              type="button"
              className={styles.micFailureAction}
              onClick={audio.resume}
              data-testid="mic-resume"
            >
              {micNotice.action}
            </button>
          ) : null}
        </p>
      ) : null}

      {/* The rail is the ONLY polite live region on this screen. */}
      <StateRail
        agentState={agentState}
        agentStateSince={station.agentStateSince}
        breakReasonLabel={cons.breakReasonLabel}
        connection={connection}
        live={live}
        release={release}
        wrapup={station.wrapup}
        dispositionSubmitted={cons.dispositionSubmitted}
        dialing={dialing}
        clock={clock}
        presenceBusy={cons.presenceBusy}
        onGoAvailable={cons.goAvailable}
        onEndBreak={cons.endBreak}
        waitingForDialer={cons.waitingForDialer}
        cueFlash={cons.cueFlash}
        // PORT NOTE (magick-agency, CONTRACT-DIFF §1): core's reconnect window.
        deferredHangupMs={bootstrap?.intervals.deferred_hangup_ms ?? null}
        /*
          The way back from `superseded` / `disconnected`. Handed straight from the
          station hook: reclaiming a station and reconnecting to one are the same
          act, because core gives the station to whoever attaches last.
        */
        onReconnect={station.reconnect}
      />

      {/*
        A refusal is a response, not an alarm: core declines `/available` while a
        disposition is outstanding, and that refusal is what makes the disposition
        mandatory. Rendered under the rail with the remedy core stated, never in
        the rail — the rail is the call's state (§A.13.4).
      */}
      {cons.presenceRefusal ? (
        <p className={styles.presenceRefusal}>{cons.presenceRefusal}</p>
      ) : null}

      {/* Assertive region, used ONLY for connect, disconnect and the direct
          result of a button the agent just pressed (§A.11 — exactly two live
          regions, and this is the second). */}
      <div className={styles.srOnly} role="alert" aria-live="assertive">
        {cons.announcement}
      </div>

      {/*
        ── The retry banner ──────────────────────────────────────────────────
        "Retry 1 of 'Q3 Winback' — these contacts were previously voicemail,
        callback, no answer." One line, above the contact panel, so the agent
        knows before the first call lands that the person they are about to
        speak to has been called before and roughly why they are being called
        again.

        **It does not violate rule 1 (geometry is frozen).** That rule is about
        the console not moving BETWEEN CALL STATES — a control that shifts 12px
        between "ringing" and "connected" is a misclick, and a misclick here
        hangs up on a human being. This is read from the session bootstrap,
        which is fixed at join and never changes for the life of the station, so
        it is present for the whole shift or absent for the whole shift. It
        cannot appear or disappear under a cursor. Anything derived from a FRAME
        must not be placed here.

        **`selection_summary` is rendered verbatim.** Core builds it from the
        frozen selector on the child campaign's row, so the sentence the agent
        reads and the query that put this contact in front of them cannot
        disagree. Re-deriving it from anything this client holds would be a
        second answer to the same question — and this client does not even have
        the input, because the selector is deliberately not on the bootstrap.

        Not a live region: it is standing context, not an event, and the console
        has exactly two live regions (§A.11) both spent on the call itself.
      */}
      {bootstrap?.retry_context ? (
        <p className={styles.retryBanner} data-testid="retry-context">
          <strong className={styles.retryBannerLead}>
            Retry {bootstrap.retry_context.generation} of “
            {bootstrap.retry_context.parent_campaign_name}”
          </strong>
          <span className={styles.retryBannerBody}>
            — these contacts were previously {bootstrap.retry_context.selection_summary}
          </span>
        </p>
      ) : null}

      <div className={styles.body} ref={consoleRef} tabIndex={-1}>
        <section className={styles.colContact} aria-label="Contact">
          {panelAttempt && resolved ? (
            <>
              <p className={styles.dialled}>{panelAttempt.phone_e164}</p>
              <p className={styles.attemptMeta}>Attempt {panelAttempt.attempt_number}</p>
              {resolved.hero.length > 0 ? (
                <dl className={styles.heroList}>
                  {resolved.hero.map((field) => (
                    <div key={field.label} className={styles.heroField}>
                      <dt className={styles.heroLabel}>{field.label}</dt>
                      <dd className={styles.heroValue}>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {!heroesWereConfigured(bootstrap?.context_display) && resolved.hero.length > 0 ? (
                // Show the heuristic's output AS a heuristic — an agent must not
                // come to trust four guessed fields as the operator's choice.
                <p className={styles.autoSelected}>auto-selected</p>
              ) : null}
            </>
          ) : (
            <IdlePanel
              dialing={dialing}
              release={release}
              missedRelease={station.missedRelease}
              lostDisposition={cons.lostDispositionNotice}
            />
          )}
        </section>

        <section className={styles.colDetail} aria-label="Contact detail">
          {panelAttempt && resolved ? (
            <>
            {/*
              ── The empty state covers the FIELDS, not the column ───────────
              This branch used to wrap the prior-attempt history too, so a
              contact whose uploaded columns were all claimed by the hero row —
              a phone number and a name, the commonest roster there is — showed
              no history at all, under copy claiming it had "only a phone
              number". Both halves were wrong: it has a name, and it may have
              been called four times.

              That was survivable while history could only come from this
              campaign and the panel had other ways to hint at it. It stopped
              being survivable when history began spanning a retry lineage,
              because on a retry campaign the prior attempts ARE the reason the
              agent is being told anything about this contact. So the sentence
              now describes the field list it was always about, and the history
              renders beside it either way.
            */}
            {resolved.fields.length === 0 && resolved.empty.length === 0 ? (
              /*
                "no extra details", not "only a phone number". The list can be
                empty because the contact's name was consumed by the hero row
                above — the common phone-plus-name contact — so the old sentence
                was a plain falsehood on the most ordinary roster there is. What
                is actually true is that this PANEL has nothing more to add,
                which is what it now says.
              */
              <p className={styles.emptyState}>
                No extra details were uploaded for this contact.
              </p>
            ) : (
              <>
                {/*
                  §A.6.3. Present whenever there is a tier-2 list to search —
                  "the filter box is present at all densities, so the gesture is
                  the same every time" — but not when the panel has nothing to
                  filter (0 non-empty fields), which would only invite typing
                  into a box that can never show a result.
                */}
                {resolved.fields.length > 0 ? (
                  <div className={styles.fieldFilter}>
                    <label className={styles.fieldFilterLabel} htmlFor="agency-field-filter">
                      Filter fields
                      <span className={styles.fieldFilterKey} aria-hidden="true">
                        /
                      </span>
                    </label>
                    <input
                      id="agency-field-filter"
                      ref={fieldFilterRef}
                      type="text"
                      className={styles.fieldFilterInput}
                      value={fieldFilter}
                      placeholder="Type to find a field…"
                      aria-describedby="agency-field-filter-count"
                      onChange={(event) => setFieldFilter(event.target.value)}
                      onKeyDown={(event) => {
                        // Esc clears AND blurs — the page's global handler never
                        // sees this key while focus is in here (it returns early
                        // on `inTextField`), so this is the only place it can be
                        // handled, same shape as `NotesField`'s own Escape.
                        if (event.key !== 'Escape') return;
                        event.preventDefault();
                        setFieldFilter('');
                        event.currentTarget.blur();
                      }}
                    />
                    <p id="agency-field-filter-count" className={styles.fieldFilterCount}>
                      {fieldFilter
                        ? `${filteredFields.length} of ${resolved.fields.length} field${resolved.fields.length === 1 ? '' : 's'}`
                        : `${resolved.fields.length} field${resolved.fields.length === 1 ? '' : 's'}`}
                    </p>
                  </div>
                ) : null}

                {/* A definition list, not a table: these are label/value pairs,
                    and a table implies row/column relationships that do not
                    exist. */}
                {filteredFields.length > 0 ? (
                  <dl className={styles.fieldList}>
                    {filteredFields.map((field) => (
                      <div key={field.label} className={styles.field}>
                        <dt className={styles.fieldLabel} title={field.label} aria-label={field.label}>
                          <HighlightedText text={field.label} query={fieldFilter} />
                        </dt>
                        {/* Rendered as TEXT, always. `context` is operator-uploaded
                            file content and is never markup — `HighlightedText`
                            only ever wraps slices of that same text in `<mark>`,
                            it never interprets it. */}
                        <dd className={styles.fieldValue}>
                          <HighlightedText text={field.value} query={fieldFilter} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : resolved.fields.length > 0 ? (
                  // Not absence — the filter is why nothing is showing, and the
                  // query that caused it is named so the agent knows to change it
                  // rather than assume the contact has nothing left to show.
                  <p className={styles.fieldFilterEmpty} data-testid="field-filter-empty">
                    No fields match “{fieldFilter}”.
                  </p>
                ) : null}
                {resolved.empty.length > 0 ? (
                  <details className={styles.emptyFields}>
                    <summary>
                      {resolved.empty.length} empty field
                      {resolved.empty.length === 1 ? '' : 's'}
                    </summary>
                    <dl className={styles.fieldList}>
                      {resolved.empty.map((field) => (
                        <div key={field.label} className={styles.field}>
                          <dt className={styles.fieldLabel}>{field.label}</dt>
                          <dd className={styles.fieldValue}>—</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                ) : null}
              </>
            )}
                {panelAttempt.prior_attempts.length > 0 ? (
                  /*
                    ── Grouped by campaign, this one first ────────────────────
                    Core's read is lineage-scoped now: a contact retried from an
                    earlier campaign carries that campaign's attempts here too.
                    A flat list of them is unreadable, because `attempt_number`
                    is per-campaign and RESETS — two passes would each show an
                    "attempt 1" and nothing would say which pass either belonged
                    to. The campaign name is what makes the history legible, and
                    it is also the only thing about an ancestor campaign the
                    agent is given (retry design DR-7): no stats, no connect
                    rate, no roster counts, no agent roster.

                    The heading count stays the TOTAL across groups, because it
                    is capped at 20 across the whole lineage and a per-group
                    count would not add up to what the agent can see.
                  */
                  <section className={styles.priorAttempts} data-testid="prior-attempts">
                    <h2 className={styles.sectionTitle}>
                      Prior attempts ({panelAttempt.prior_attempts.length})
                    </h2>
                    {priorGroups.map((group) => (
                      <div
                        key={group.campaignId}
                        className={styles.priorGroup}
                        data-testid={`prior-group-${group.campaignId}`}
                        data-current={String(group.isCurrent)}
                      >
                        <h3 className={styles.priorGroupTitle}>
                          {/*
                            "This campaign" rather than its name for the group
                            the agent is signed into: the name is already in the
                            station header two inches up, and repeating it here
                            makes the one group that is NOT theirs harder to
                            pick out — which is the whole point of the split.
                          */}
                          <span className={styles.priorGroupName}>
                            {group.isCurrent ? 'This campaign' : group.campaignName}
                          </span>
                          <span className={styles.priorGroupCount}>{group.attempts.length}</span>
                        </h3>
                        <ul className={styles.priorList}>
                          {group.attempts.map((prior) => (
                            /*
                              Keyed on campaign + number, never on the number
                              alone: it is unique per contact row and a lineage
                              carries one row per campaign, so two groups
                              legitimately both hold an "attempt 1".
                            */
                            <li
                              key={`${group.campaignId}:${prior.attempt_number}`}
                              className={styles.priorItem}
                            >
                              <span
                                className={styles.priorOutcome}
                                /*
                                  Set when the code could not be named — see
                                  `priorDispositionLabel`. It styles the value as
                                  the code it is rather than passing an enum off
                                  as prose, and the campaign name above it is the
                                  explanation for why there is no label.
                                */
                                data-unlabelled={
                                  priorDispositionIsRaw(
                                    prior.disposition_code,
                                    priorCatalog(group.isCurrent),
                                  ) || undefined
                                }
                              >
                                {priorDispositionLabel(
                                  prior.disposition_code,
                                  priorCatalog(group.isCurrent),
                                )}
                              </span>
                              {prior.notes ? (
                                <span className={styles.priorNote}>{prior.notes}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </section>
                ) : null}
            </>
          ) : (
            <IdleGuide dialing={dialing} />
          )}
        </section>

        {/* Column 3 — the outcome and the note. Rendered in every state so the
            geometry never shifts; disabled with a stated reason when there is
            nothing to act on. */}
        <section className={styles.colOutcome} aria-label="Outcome">
          <DispositionPad
            catalog={cons.catalog}
            form={cons.form}
            onChange={(next) => {
              // Every change reaching the pad's own `onChange` — a card click,
              // or the `C` shortcut's `selectCallback()`, which reports back
              // through this same prop — is a non-digit selection. Only the
              // digit branch above calls `setForm` directly and marks
              // `number_key` itself; without this, a click AFTER any number
              // key kept reporting `selection_method: 'number_key'` forever,
              // because nothing ever set it back.
              cons.noteCodeSelectionMethod('click');
              cons.setForm(next);
            }}
            enabled={cons.padEnabled}
            disabledReason={cons.padDisabledReason}
            rejection={cons.padRejection}
            keysRemapped={cons.keysRemapped}
            now={clock.now}
            onNeedsNote={() => notesRef.current?.focus()}
            handleRef={padRef}
          />
          <NotesField
            ref={notesRef}
            value={cons.notes}
            onAgentEdit={cons.onNotesEdit}
            status={cons.notesStatusLine}
            foreignWrite={cons.notesForeignWrite}
            enabled={cons.notesEnabled}
            disabledReason={cons.notesDisabledReason}
            onSubmit={cons.submit}
          />
        </section>
      </div>

      {/* The action bar. Tab order within it is fixed: Break → Save → Hang up. */}
      <div className={styles.actionBar}>
        <BreakMenu
          handleRef={breakMenuRef}
          reasons={cons.breakReasons}
          queuedReasonLabel={cons.pendingBreakLabel}
          busy={cons.breakBusy}
          rejection={cons.breakRejection}
          onSelect={cons.requestBreak}
        />

        {cons.pendingBreakLabel ? (
          <QueuedBreakPill
            reasonLabel={cons.pendingBreakLabel}
            cancelling={cons.cancelling}
            cancelFailed={cons.cancelFailed}
            onCancel={cons.cancelBreak}
          />
        ) : null}

        {/* Not an error: the queued break was promoted to a real one, which is the
            ordinary outcome of pressing ✕ at the end of wrap-up. No danger
            styling, and the recovery is `End break` in the rail (§A.13.4). */}
        {cons.breakAlreadyStarted ? (
          <span className={styles.breakAlreadyStarted}>Your break already started.</span>
        ) : null}

        <button
          type="button"
          className={styles.save}
          onClick={cons.submit}
          disabled={!cons.padEnabled || cons.block !== null || cons.submitting}
          aria-describedby={cons.block ? 'submit-block-reason' : undefined}
        >
          {cons.submitting ? 'Saving…' : 'Save disposition'}
          <span className={styles.shortcut} aria-hidden="true">
            Ctrl ↵
          </span>
        </button>

        {/*
          §A.13.6: the reason is rendered **next to the submit control**, never as a
          toast — "an agent must not return to `available` believing a disposition
          saved when it did not". Only once the pad is live: before that the pad
          carries its own "available when connected", and two stated reasons for one
          disabled control is noise.
        */}
        {cons.padEnabled && cons.block ? (
          <span id="submit-block-reason" className={styles.blockReason}>
            {DISPOSITION_BLOCK_COPY[cons.block]}
          </span>
        ) : null}

        {/*
          Mark DNC sits before the hang-up in tab order: the sequence that
          actually happens is "take me off your list" *then* the call ends, and
          an agent tabbing forward should meet them in that order.
        */}
        <DncControl
          handleRef={dncRef}
          attemptId={live?.attempt.attempt_id ?? null}
          phoneE164={live?.attempt.phone_e164 ?? null}
          campaignName={live?.attempt.campaign_name ?? null}
          permitted={mayMarkDnc}
          permittedTenantWide={mayMarkDncTenantWide}
          inFlight={dncInFlight}
          onConfirm={confirmDnc}
          failure={dncFailure}
          outcome={dncOutcome}
        />

        {/*
          Mute sits between DNC and Hang up, which keeps §A.13.9's stated
          sequence (Break → Save → … → Hang up) intact while putting it beside
          the other control that acts on the live call.

          `aria-pressed` carries the state and the label carries the *action*.
          A label that flips to "Muted" would be a state read as a verb — the
          agent presses a button that says "Muted" expecting to become muted.

          Disabled when the uplink is not open, per §A.13.9's rule that inactive
          controls are disabled so they are skipped rather than reordered.
          Keyed off `audio.sending` rather than `live` alone: a call that is up
          while the microphone failed has nothing to mute, and offering the
          control there would suggest the silence is something the agent did.
        */}
        <button
          type="button"
          className={styles.mute}
          onClick={audio.toggleMute}
          disabled={!audio.sending}
          aria-pressed={audio.muted}
          data-testid="mute-toggle"
        >
          {audio.muted ? 'Unmute' : 'Mute'}
        </button>

        <HoldToConfirmButton
          attemptId={live?.attempt.attempt_id ?? null}
          enabled={Boolean(live)}
          disabledReason={live ? null : 'No call in progress'}
          onConfirm={hangup}
        />

        {/*
          `role="alert"`, unlike the DNC outcome's polite region: this says the
          agent is still on a call they believe they ended, and it is the one
          message on this screen that must interrupt.
        */}
        {hangupFailure ? (
          <span className={styles.actionFailure} role="alert" data-testid="hangup-failure">
            {hangupFailure}
          </span>
        ) : null}
      </div>

      {/*
        The shared `ConfirmDialog`, not a console-local one: it already owns the
        focus trap, the Escape handling and the focus restore this needs, and its
        footer order is a documented safety property.

        A failed leave replaces the message rather than adding a second line —
        the original sentence describes what confirming will do, and once it has
        failed the only news is that it did not.
      */}
      <ConfirmDialog
        open={leaveConfirm}
        title={LEAVE_CONFIRM_TITLE}
        message={
          leaveFailure
            ? `Your station is still open — ${leaveFailure}`
            : LEAVE_CONFIRM_MESSAGE
        }
        confirmLabel={leaving ? 'Leaving…' : LEAVE_CONFIRM_ACTION}
        disabled={leaving}
        onConfirm={confirmLeave}
        onCancel={() => {
          /**
           * **Refused while the request is in flight.**
           *
           * `ConfirmDialog`'s `disabled` guards the confirm button only —
           * Escape and a click on the overlay call `onCancel` unconditionally.
           * Without this, cancelling mid-request unmounts the dialog, the
           * rejection then sets `leaveFailure` on a surface nobody can see, and
           * the menu item reads "Leave station" again: the agent believes they
           * left while core still has them in the pool. That is verbatim the
           * outcome `confirmLeave` refuses to produce by navigation, arriving
           * through the Escape key instead.
           */
          if (leaving) return;
          setLeaveConfirm(false);
          setLeaveFailure(null);
        }}
      />
    </div>
  );
}

/**
 * The way off a station screen that has no station on it.
 *
 * Both fatal screens render before the console's header, so this link is the
 * only navigation on them. Where it goes is the same question `Exit station`
 * answers: a supervisor has a campaign page to return to, an `agent` (level 5)
 * does not and is sent to their landing screen — with `refused`, so it does not
 * resolve their assignment and send them straight back here.
 */
function StationEscape({ toCampaign, campaignId }: { toCampaign: boolean; campaignId: string }) {
  return (
    <Link
      className={styles.fatalEscape}
      to={toCampaign ? `/agency/campaigns/${campaignId}` : agentLandingPath('refused')}
      data-testid="station-escape"
    >
      {toCampaign ? 'Back to the campaign' : 'Back to your home screen'}
    </Link>
  );
}

function IdlePanel({
  dialing,
  release,
  missedRelease,
  lostDisposition,
}: {
  dialing: boolean;
  release: ReturnType<typeof useAgencyConsole>['station']['release'];
  missedRelease: ReturnType<typeof useAgencyConsole>['station']['missedRelease'];
  lostDisposition: string | null;
}) {
  return (
    <div className={styles.releasePanel}>
      {release && releaseShape(release) === 'dim_and_clear' ? (
        <>
          <p className={styles.releaseHeadline}>{resolveReleaseCopy(release).headline}</p>
          <p className={styles.releaseSubtext}>{resolveReleaseCopy(release).subtext}</p>
        </>
      ) : release ? (
        /*
          ── A release that no wrap-up ever explained (core `#290`) ──────────────
          `releaseShape` is `wrapup` here, so the release copy belonged in the
          wrap-up rail — and this panel only renders once there is no attempt on
          screen, which means that wrap-up is over or never began. The station
          clears `release` when a wrap-up genuinely ends (see its `agent_state`
          handler), so reaching this branch means it never did: core took the
          early return that skips both the `agent_state{wrapup}` and `wrapup`
          frames, and without this the agent's screen goes from a live call
          straight to the resting "Waiting for a call" with no account of the
          call they were just on. That reads as data loss, which is the same
          failure the missed-release notice beside it exists to prevent.

          The server's own sentence, not the copy table's headline: on this path
          there is no wrap-up to name and no disposition left to pick, so the
          wrap-up-shaped copy would be two false statements. See
          `releaseAccount`.
        */
        <>
          <p className={styles.releaseHeadline} data-testid="unexplained-release">
            {releaseAccount(release)}
          </p>
          <p className={styles.releaseSubtext}>
            {dialing ? 'Waiting for a call' : 'No calls will come through right now.'}
          </p>
        </>
      ) : missedRelease ? (
        /*
          The call that ended while the agent's socket was away (`ready`'s
          `missed_release`). Rendered here, in the idle slot, and prefixed so it
          cannot be mistaken for something that just happened — the agent has been
          staring at a reconnect spinner and needs to know the call is over, not to
          be told a fresh one ended.

          **Core hands this over exactly once**: `takeMissedRelease` clears as it
          reads, so if the console does not put it on screen the record of the call
          the agent was on is gone for good, and an empty station after a drop
          reads as data loss.
        */
        <>
          <p className={styles.releaseHeadline} data-testid="missed-release">
            While you were disconnected: {resolveReleaseCopy(missedRelease).headline}
          </p>
          <p className={styles.releaseSubtext}>{resolveReleaseCopy(missedRelease).subtext}</p>
        </>
      ) : (
        <>
          <p className={styles.idleHeadline}>
            {dialing ? 'Waiting for a call' : 'No calls will come through right now.'}
          </p>
          <p className={styles.idleHint}>{dialing ? IDLE_WAITING_HINT : IDLE_PAUSED_HINT}</p>
        </>
      )}
      {/*
        A disposition whose response outlived its attempt. One non-blocking line,
        here in the idle slot and only after the next call completes — never a
        toast, never the rail, and it must not steal focus: an alert about
        customer A while the agent is talking to customer B is worse than the loss
        it reports (§A.13.6).
      */}
      {lostDisposition ? <p className={styles.lostDisposition}>{lostDisposition}</p> : null}
    </div>
  );
}

/**
 * The waiting middle column. Purely a reminder — no controls — so it cannot
 * enter the tab order and cannot move a live-call control when a reservation
 * lands. The keys listed are the ones the page actually binds; a key that is
 * only a comment would train muscle memory for a binding that does not exist.
 */
function IdleGuide({ dialing }: { dialing: boolean }) {
  return (
    <div className={styles.idleGuide} data-testid="idle-guide">
      <p className={styles.idleGuideHeading}>{IDLE_GUIDE_HEADING}</p>
      <p className={styles.idleGuideIntro}>
        {dialing ? IDLE_GUIDE_INTRO : IDLE_PAUSED_HINT}
      </p>
      <p className={styles.idleKeyGroupLabel}>Right now</p>
      <ul className={styles.idleKeys}>
        {IDLE_KEYS_NOW.map((row) => (
          <li key={row.key} className={styles.idleKeyRow}>
            <span className={styles.idleKeyChip}>{row.key}</span>
            {row.does}
          </li>
        ))}
      </ul>
      <p className={styles.idleKeyGroupLabel}>On a call</p>
      <ul className={styles.idleKeys}>
        {IDLE_KEYS_ON_CALL.map((row) => (
          <li key={row.key} className={styles.idleKeyRow}>
            <span className={styles.idleKeyChip}>{row.key}</span>
            {row.does}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnectionHealthPill({
  connection,
  missedPings,
}: {
  /**
   * `StationConnection`, not `string`. It was `string`, which is why the compiler
   * could not flag the missing `disconnected` arm when that state was added — the
   * label silently fell through to "Connecting" and the dot to green. A closed
   * vocabulary here is the same convention `agencyStatsConsumers.ts` and
   * `AuditActionOption` use to make an unhandled member a compile error.
   */
  connection: StationConnection;
  missedPings: number;
}) {
  // One missed ping is not an alarm — a single 10s gap is normal on wifi.
  const label =
    connection === 'open'
      ? missedPings >= 2
        ? 'Weak connection'
        : 'Connected'
      : connection === 'reconnecting'
        ? 'Reconnecting'
        : connection === 'superseded'
          ? 'Moved to another window'
          : connection === 'session_gone'
            ? 'Session ended'
            : // Named, not left to the fallback. The `idle` arm's absence is the
              // documented defect a few lines up — a stopped console reading
              // "Connecting" — and `disconnected` is that same state reached
              // deliberately, so it must not repeat it.
              connection === 'disconnected'
              ? 'Disconnected'
              : 'Connecting';

  return (
    <span className={styles.healthPill} data-state={connection}>
      <span className={styles.healthDot} aria-hidden="true" />
      {label}
    </span>
  );
}

/*
 * `resolveDispositionLabel` used to live here and rendered an unrecognised code
 * as the literal words "Unknown outcome". That was defensible while prior
 * attempts could only come from THIS campaign — an unknown code then really was
 * a stale console. Once history spans a retry lineage it is routine: the parent
 * campaign's catalog is not on this bootstrap and must not be (the agent role
 * holds four `agency.*` permissions and nothing that reads another campaign's
 * configuration), so a code the parent had and the child does not is a code this
 * console structurally cannot name. "Unknown outcome" then reads as "the write-up
 * was lost" about a write-up that is intact.
 *
 * The rule and the reasoning moved to `utils/agencyPriorAttempts.ts`, beside the
 * grouping that makes the campaign name visible next to the raw code.
 */

/**
 * §A.6.3: "matching characters are marked". `highlightSegments` does the
 * matching (pure, tested on its own); this wraps each matched slice in a
 * `<mark>` and leaves the rest as plain text.
 *
 * Never touches HTML in `text` — it only slices the string `agencyContext`
 * already stringified and never re-parses it, so §A.6.4's "value contains
 * HTML/markup: rendered as text, always" holds through the filter exactly as
 * it did without one.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = highlightSegments(text, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          <mark key={index} className={styles.filterMatch}>
            {segment.text}
          </mark>
        ) : (
          // No wrapper needed for the common (no-match) case — a lone unmatched
          // segment renders as a plain string, not an extra span nobody asked for.
          segment.text
        ),
      )}
    </>
  );
}
