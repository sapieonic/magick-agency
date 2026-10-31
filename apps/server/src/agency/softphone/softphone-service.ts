/**
 * `SoftphoneService` — `AgencyRuntime.softphone`, the soft phone's runtime surface
 * (docs/softphone.md §4, §5; rulings SP1–SP7). The public API layer's soft-phone
 * routes call these methods and map each refusal 1:1 onto its
 * `AgencySoftphoneErrorCode` (`./types.ts`).
 *
 * **What is NOT in here, deliberately:** request parsing (the API layer validates
 * shapes and passes typed values), RBAC (it vouches for `actor.supervise`),
 * `platform_audit_log` writes (it audits from each result: placed, the two
 * overrides, dispositioned, hung up, DNC marked, the two session actions) and
 * enrichment (`agent_name`). Station frames ARE sent here: they are the runtime's.
 *
 * Ownership: a session is the actor's own live session in the actor's tenant and
 * account, else `session_not_found`. A call is visible to the agent who placed it,
 * and to an `actor.supervise` caller for any call in the account (`on_behalf`),
 * else `call_not_found`.
 */
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import { getPool } from '@magick-agency/db';
import {
  SOFTPHONE_BREAK_REASON,
  SOFTPHONE_BREAK_REASON_LABEL,
  SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES,
  type AgencyAgentState,
  type AgencyCallFieldValues,
  type AgencyManualCall,
  type AgencyManualCallDispositionResponse,
  type AgencyManualCallDncResponse,
  type AgencySessionStateResponse,
} from '@magick-agency/contracts/agency';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { breakMustWait, type BreakRegistry } from '@magick-agency/domain/break-manager';
import {
  agencyAgentSessionRepository,
  agencyCampaignRepository,
  agencyContactRepository,
  agencyManualCallRepository,
  agencySoftphoneSettingsRepository,
} from '../../db/repositories/agency.repository.js';
import {
  isCampaignSession,
  type AgencyAgentSessionRecord,
  type AgencyCampaignRecord,
  type AgencyManualCallRecord,
} from '../../db/models/agency.model.js';
import { defaultPhoneCountryCode } from '../../utils/phone-normalizer.js';
import { AGENT_LEASE_MS, type AgentStateMachine } from '../agent-state-machine.js';
import type { AgencyDialer } from '../agency-dialer.js';
import type { DncRegistry } from '../dnc-registry.js';
import { markDnc } from '../dnc-mark.js';
import type { StationRegistry } from '../station-registry.js';
import { submittedCallFields, validateCallFieldValues } from './call-fields.js';
import { runManualPredial } from './manual-predial.js';
import { manualDispositionDecision, prepareManualDisposition, resolveManualCatalog } from './manual-disposition.js';
import type { ManualDialer } from './manual-dialer.js';
import { onSoftphoneBreak, setAvailableGuarded } from './session-guard.js';
import { UUID_RE } from '../../utils/uuid.js';
import type { SoftphoneActor, SoftphoneRefusal, SoftphoneResult } from './types.js';

const log = createChildLogger({ component: 'agency-softphone' });

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** `placeCall`'s request: `AgencyManualCallCreateRequest` without the actor, already shape-checked. */
export interface PlaceCallRequest {
  sessionId: string;
  /** As typed; normalised to E.164 in the default region. */
  to: string;
  callerId?: string | null;
  /** The tag. Absent or null: untagged. */
  campaignId?: string | null;
  fields?: AgencyCallFieldValues;
  overrides?: { dnc_note?: string; hours_note?: string } | null;
}

/** `submitDisposition`'s request: `AgencyManualCallDispositionRequest` without the actor. */
export interface SubmitDispositionRequest {
  code: string;
  notes?: string;
  /** ISO-8601. */
  callbackAt?: string;
  fields?: AgencyCallFieldValues;
}

// ─── Results (the success halves; every method may also answer a refusal) ──

export interface PlaceCallSuccess {
  call: AgencyManualCall;
  /** SP1: the override used to place it, for `agency_manual_call.dnc_overridden`. */
  dncOverride: { note: string; entryId: string } | null;
  /** SP2: the override used to place it, for `agency_manual_call.hours_overridden`. */
  hoursOverrideNote: string | null;
}

export interface CallActionSuccess {
  call: AgencyManualCall;
  /** The actor is not the agent who placed the call (a supervisor). */
  onBehalf: boolean;
}

export interface HangupSuccess extends CallActionSuccess {
  /** A hang-up was issued: false when the call had already ended (an idempotent no-op, not audited). */
  hungUp: boolean;
}

/**
 * The `dnc_entries` row a soft-phone mark landed on, for the `dnc_entry.created` audit
 * row: `created` false when the number was already listed at that scope (nothing new
 * was recorded, so nothing is audited as created).
 */
export interface DncEntryWritten {
  id: string;
  created: boolean;
}

export interface DispositionSuccess {
  response: AgencyManualCallDispositionResponse;
  onBehalf: boolean;
  /** The same code again: notes/callback updated, nothing settled a second time. */
  replay: boolean;
  /** A suppress code's DNC row; null when the code does not suppress, or on a replay. */
  dncEntry: DncEntryWritten | null;
}

export interface DncSuccess {
  response: AgencyManualCallDncResponse;
  onBehalf: boolean;
  /** Null when nothing was recorded (an unusable number). */
  dncEntry: DncEntryWritten | null;
}

export interface SessionSwitchSuccess {
  response: AgencySessionStateResponse;
  /**
   * The state the answer was decided from (audit's from-state): for the switch, the
   * read of the pass that decided, so a re-read after a lost CAS, not the first read.
   */
  fromState: AgencyAgentState | null;
  campaignId: string;
  /** `switchToSoftphone` only: deferred behind a reservation, call or wrap-up. */
  queued: boolean;
  /**
   * `switchToSoftphone` only: the session was already on the soft phone, or the switch
   * already queued — an idempotent repeat that changed nothing, and is not audited again.
   */
  unchanged: boolean;
}

export interface SoftphoneServiceDeps {
  agents: AgentStateMachine;
  stations: StationRegistry;
  breaks: BreakRegistry;
  dialer: Pick<AgencyDialer, 'hasUnannouncedAttempt'>;
  dnc: Pick<DncRegistry, 'checkEntry'>;
  manual: ManualDialer;
}

const refuse = (refusal: SoftphoneRefusal): { ok: false; refusal: SoftphoneRefusal } => ({ ok: false, refusal });

export class SoftphoneService {
  constructor(private readonly deps: SoftphoneServiceDeps) {}

  // ─── Lookups ──────────────────────────────────────────────────────────────

  /** The actor's own live session in their tenant and account. */
  private async ownSession(sessionId: string, actor: SoftphoneActor): Promise<AgencyAgentSessionRecord | null> {
    if (!isUuid(sessionId)) return null;
    const session = await agencyAgentSessionRepository.findById(sessionId);
    if (!session || session.left_at) return null;
    if (session.tenant_id !== actor.tenantId || session.account_id !== actor.accountId) return null;
    return session.agent_user_id === actor.userId ? session : null;
  }

  /** A call the actor may act on: their own, or any in the account for a supervisor. */
  private async visibleCall(
    callId: string,
    actor: SoftphoneActor,
  ): Promise<{ call: AgencyManualCallRecord; onBehalf: boolean } | null> {
    const call = await agencyManualCallRepository.findById(callId, { tenantId: actor.tenantId, accountId: actor.accountId });
    if (!call) return null;
    const onBehalf = call.agent_user_id !== actor.userId;
    if (onBehalf && !actor.supervise) return null;
    return { call, onBehalf };
  }

  private async wire(call: AgencyManualCallRecord): Promise<AgencyManualCall> {
    const wire = await this.deps.manual.wireFor(call);
    if (!wire) throw new Error(`manual call ${call.id} vanished between its write and its read`);
    return wire;
  }

  /**
   * The tag, when the actor may log to it: in the account, `running` or `paused`
   * (`SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES`), and staffed unless a supervisor — the
   * rule bootstrap's `taggable_campaigns` lists by.
   */
  private async taggable(campaignId: string, actor: SoftphoneActor): Promise<AgencyCampaignRecord | null> {
    if (!isUuid(campaignId)) return null;
    const campaign = await agencyCampaignRepository.findById(campaignId);
    if (!campaign || campaign.tenant_id !== actor.tenantId || campaign.account_id !== actor.accountId) return null;
    if (!(SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES as readonly string[]).includes(campaign.status)) return null;
    if (actor.supervise) return campaign;
    const staffed = await agencyCampaignAgentRepository.listActiveForUser(actor.tenantId, actor.userId);
    return staffed.some((s) => s.campaign_id === campaign.id) ? campaign : null;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * The session's unsettled call — live, or ended and awaiting its outcome — as the
   * live wire row (contact context and prior attempts), or null. For bootstrap's
   * `call` and the `manual_call_live` / `outcome_pending` bodies.
   */
  async getLiveForSession(sessionId: string): Promise<AgencyManualCall | null> {
    if (!isUuid(sessionId)) return null;
    const unsettled = await agencyManualCallRepository.findUnsettledForSession(sessionId);
    return unsettled ? this.deps.manual.wireFor(unsettled) : null;
  }

  /** Whether this process is driving a live soft-phone call on the session. */
  hasLiveCall(sessionId: string): boolean {
    return this.deps.manual.hasLiveCall(sessionId);
  }

  // ─── Place a call (§4.1 steps 1–4) ────────────────────────────────────────

  /**
   * Dial from the actor's session on the soft phone.
   *
   * Refusals, in the order checked: `session_not_found`; `manual_call_live` /
   * `outcome_pending` (the session's unsettled call); `not_on_softphone` (not on the
   * `soft_phone` break); `station_unavailable` (no open station socket on this
   * replica); `campaign_not_taggable`; `fields_invalid`; then the pre-dial's
   * `override_note_invalid`, `invalid_number`, `caller_id_not_allowed`,
   * `contact_in_flight`, `outside_calling_hours`, `dnc_listed`, `dnc_unavailable`
   * (`manual-predial.ts`); `dial_failed` when Redis cannot answer the session claim;
   * and from the dial, `concurrency_limit`, `station_unavailable` or `dial_failed` (a
   * bridge refusal this code does not name).
   *
   * On success the call is in the bridge's hands and the answer is the row as it is
   * now (usually `dialing` or `ringing`); the `manual_call` frames carry the rest. A
   * dial the carrier refused outright is a success too, answered as the row it
   * ended and settled as (`failed`).
   */
  async placeCall(actor: SoftphoneActor, req: PlaceCallRequest): Promise<SoftphoneResult<PlaceCallSuccess>> {
    const session = await this.ownSession(req.sessionId, actor);
    if (!session) return refuse({ code: 'session_not_found' });

    const pending = await this.pendingRefusal(session.id);
    if (pending) return refuse(pending);

    const live = await this.deps.agents.get(session.id);
    if (!onSoftphoneBreak(live, session)) {
      return refuse({ code: 'not_on_softphone' });
    }
    const socket = this.deps.stations.socketFor(session.id);
    if (!socket || socket.readyState !== 1 /* OPEN */ || !this.deps.stations.isLocallyOwned(session.id)) {
      return refuse({ code: 'station_unavailable' });
    }

    let tag: AgencyCampaignRecord | null = null;
    if (req.campaignId) {
      tag = await this.taggable(req.campaignId, actor);
      if (!tag) return refuse({ code: 'campaign_not_taggable' });
    }

    const settings = await agencySoftphoneSettingsRepository.get(actor.tenantId, actor.accountId);
    const fields = validateCallFieldValues(settings.call_fields, req.fields, { requireFilled: false });
    if (!fields.ok) return refuse({ code: 'fields_invalid', details: fields.details });

    const accountNumbers = tag
      ? []
      : (await tenantPhoneAssignmentRepository.findAvailableForAccount(actor.tenantId, actor.accountId))
        .map((n) => n.phone_number)
        .filter((n): n is string => typeof n === 'string');

    const predial = await runManualPredial({
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      to: req.to,
      defaultCountryCode: defaultPhoneCountryCode(),
      requestedCallerId: req.callerId,
      tag,
      accountNumbers,
      settings,
      overrides: req.overrides ?? null,
      now: new Date(),
    }, {
      dnc: this.deps.dnc,
      findRosterMatches: (campaignId, phone) => agencyContactRepository.findForManualMatch(campaignId, phone),
      findInFlightInAccount: (phone) => agencyContactRepository.findInFlightForAccount(actor.tenantId, actor.accountId, phone),
    });
    if (!predial.ok) {
      // The session's unsettled call comes first in the order of refusals, but it was
      // read above, before the pre-dial's awaits and outside the session lock. A second
      // dial from this session that committed meanwhile has claimed the roster contact,
      // so the pre-dial sees it `in_flight` and would answer `contact_in_flight` for the
      // agent's OWN call. Asked again here, the session's call wins, as it does inside
      // step 3's lock.
      const own = await this.pendingRefusal(session.id);
      return own ? refuse(own) : predial;
    }
    const plan = predial.plan;

    // ── Step 3: the row and the contact claim, in ONE transaction ────────────
    // The session row is locked first, so two dials from one session serialise here
    // and the second meets the first's committed row (manual_call_live), never a
    // half-claimed contact.
    const client = await getPool().connect();
    let call: AgencyManualCallRecord;
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ break_reason: string | null }>(
        'SELECT break_reason FROM agency_agent_sessions WHERE id = $1 FOR UPDATE', [session.id],
      );
      // Under the lock: a `/break` to another reason that committed after the read
      // above has left the soft phone (`setBreakLeavingSoftphone`, the other side of
      // this lock), and no call may start on the break it left.
      if (locked.rows[0]?.break_reason !== SOFTPHONE_BREAK_REASON) {
        await client.query('ROLLBACK');
        return refuse({ code: 'not_on_softphone' });
      }
      const existing = await agencyManualCallRepository.findUnsettledForSession(session.id, { client });
      if (existing) {
        await client.query('ROLLBACK');
        return refuse(await this.unsettledRefusal(existing));
      }
      let contact: { contactId: string; claimed: boolean; priorState: AgencyManualCallRecord['contact_prior_state'] } | null = null;
      if (tag && plan.contact) {
        const claim = await agencyContactRepository.claimForManual(tag.id, plan.contact.id, { client });
        if (claim.outcome === 'busy' || (claim.outcome === 'linked' && claim.state === 'in_flight')) {
          await client.query('ROLLBACK');
          return refuse({ code: 'contact_in_flight', campaign_id: tag.id, contact_id: plan.contact.id });
        }
        if (claim.outcome === 'claimed') contact = { contactId: plan.contact.id, claimed: true, priorState: claim.priorState };
        else if (claim.outcome === 'linked') contact = { contactId: plan.contact.id, claimed: false, priorState: null };
      }
      const created = await agencyManualCallRepository.create({
        tenantId: actor.tenantId,
        accountId: actor.accountId,
        sessionId: session.id,
        agentUserId: actor.userId,
        campaignId: tag?.id ?? null,
        contact,
        destinationE164: plan.destinationE164,
        callerId: plan.callerId,
        fields: fields.values,
        recordingRequested: plan.recordingRequested,
        analysisProfileId: plan.analysisProfileId,
        dncOverride: plan.dncOverride,
        hoursOverrideNote: plan.hoursOverrideNote,
      }, { client });
      if (!created.ok) {
        await client.query('ROLLBACK');
        return created.existing
          ? refuse(await this.unsettledRefusal(created.existing))
          : refuse({ code: 'not_on_softphone' });
      }
      await client.query('COMMIT');
      call = created.call;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // ── Step 1: the session claim in Redis ───────────────────────────────────
    // After the commit, so the claim names a row that exists. An end-break that won
    // the race leaves the session `available`: the row is closed undialled.
    let claim = await this.deps.agents.claimManual(session.id, call.id);
    if (!claim.ok && claim.reason === 'held') {
      // This row is the session's only unsettled call (the insert proved it), so
      // another id in the field is stale: clear it by its id and try once more.
      log.warn({ sessionId: session.id, heldBy: claim.heldBy }, 'Stale soft-phone claim found at dial — clearing it');
      await this.deps.agents.releaseManual(session.id, claim.heldBy);
      claim = await this.deps.agents.claimManual(session.id, call.id);
    }
    if (!claim.ok) {
      await this.deps.manual.abandonUndialled(call.id);
      // Redis did not answer: nothing says the agent is off the soft phone, so say what
      // happened (retry) rather than send them to a switch they already made.
      return refuse({ code: claim.reason === 'unavailable' ? 'dial_failed' : 'not_on_softphone' });
    }

    // ── Step 4: dial, agent first ─────────────────────────────────────────────
    const dialed = await this.deps.manual.dial(call, { socket, ...(tag ? { provider: tag.telephony_provider } : {}) });
    if (!dialed.ok) return refuse({ code: dialed.failure });

    const fresh = await agencyManualCallRepository.findById(call.id, { tenantId: actor.tenantId, accountId: actor.accountId });
    return {
      ok: true,
      call: await this.wire(fresh ?? call),
      dncOverride: plan.dncOverride,
      hoursOverrideNote: plan.hoursOverrideNote,
    };
  }

  /** `manual_call_live` (still live) or `outcome_pending` (ended, awaiting its outcome). */
  private async unsettledRefusal(existing: AgencyManualCallRecord): Promise<SoftphoneRefusal> {
    const call = await this.wire(existing);
    return existing.state === 'ended' ? { code: 'outcome_pending', call } : { code: 'manual_call_live', call };
  }

  private async pendingRefusal(sessionId: string): Promise<SoftphoneRefusal | null> {
    const existing = await agencyManualCallRepository.findUnsettledForSession(sessionId);
    return existing ? this.unsettledRefusal(existing) : null;
  }

  // ─── Hang up (SP3) ────────────────────────────────────────────────────────

  /**
   * Hang up the call, while ringing too (SP3: VoiceLink cannot stop the customer's
   * phone ringing). Idempotent: a call that already ended answers its row. Answers
   * the row as read right after the hangup was issued — the `manual_call` frame is
   * the authority for "over". A live call this process does not hold (a crash's
   * leftover) answers its row unchanged; the orphan sweep ends it. `hungUp` is true
   * only when a hang-up was actually issued (A11): false for a call that had already
   * ended and for that leftover, so the caller audits only a real hang-up.
   */
  async hangup(actor: SoftphoneActor, callId: string): Promise<SoftphoneResult<HangupSuccess>> {
    const found = await this.visibleCall(callId, actor);
    if (!found) return refuse({ code: 'call_not_found' });
    let hungUp = false;
    if (found.call.state !== 'ended') {
      hungUp = await this.deps.manual.hangup(found.call.id, found.onBehalf ? 'supervisor' : 'agent');
      if (hungUp) await this.deps.manual.settled(found.call.id);
    }
    const fresh = await agencyManualCallRepository.findById(found.call.id, { tenantId: actor.tenantId, accountId: actor.accountId });
    return { ok: true, call: await this.wire(fresh ?? found.call), onBehalf: found.onBehalf, hungUp };
  }

  // ─── Details (PATCH /calls/:id) ───────────────────────────────────────────

  /**
   * Replace the call's field values and/or notes while it is live or awaiting its
   * outcome (last write wins; `notes: ''` clears). Fields are validated against the
   * set in force, `required` not enforced (`fields_invalid`), and replace the stored
   * values wholesale; omitted `fields`, or `{}` while no call fields are in force, leave
   * them unchanged (`submittedCallFields`). A settled call is `call_settled`.
   */
  async updateDetails(
    actor: SoftphoneActor,
    callId: string,
    patch: { fields?: AgencyCallFieldValues; notes?: string },
  ): Promise<SoftphoneResult<CallActionSuccess>> {
    const found = await this.visibleCall(callId, actor);
    if (!found) return refuse({ code: 'call_not_found' });
    if (found.call.settled_at !== null) return refuse({ code: 'call_settled', call: await this.wire(found.call) });
    let fields: AgencyCallFieldValues | undefined;
    if (patch.fields !== undefined) {
      const settings = await agencySoftphoneSettingsRepository.get(actor.tenantId, actor.accountId);
      // `{}` with no call fields in force is no change (see `submittedCallFields`).
      const submitted = submittedCallFields(settings.call_fields, patch.fields);
      if (submitted !== undefined) {
        const valid = validateCallFieldValues(settings.call_fields, submitted, { requireFilled: false });
        if (!valid.ok) return refuse({ code: 'fields_invalid', details: valid.details });
        fields = valid.values;
      }
    }
    const updated = await agencyManualCallRepository.updateDetails(found.call.id, {
      ...(fields !== undefined ? { fields } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    });
    if (!updated) {
      const now = await agencyManualCallRepository.findById(found.call.id, { tenantId: actor.tenantId, accountId: actor.accountId });
      return refuse({ code: 'call_settled', call: await this.wire(now ?? found.call) });
    }
    const call = await this.deps.manual.sendFrame(updated) ?? await this.wire(updated);
    return { ok: true, call, onBehalf: found.onBehalf };
  }

  // ─── The outcome (§4.1 step 7, §5) ────────────────────────────────────────

  /**
   * Save the call's outcome and settle it: the code against the call's catalog (the
   * tag's, else the settings', else the built-in), its note / callback, the fields
   * with `required` enforced; then ONE transaction — `recordDisposition`, the DNC
   * mark for a suppress code (campaign scope when tagged, else the call's account;
   * B8, `dnc-mark.ts`), the
   * roster contact (`settleFromManual`, §5) — and after the commit the Redis claim
   * is released. The same code again is an idempotent replay (notes and callback
   * last-write-wins; nothing settles twice): a corrected callback time also moves the
   * contact this call settled (`rescheduleFromManualReplay`), and nothing else repeats
   * — no DNC mark, no settlement, no claim release.
   *
   * Refusals: `call_not_found`; `manual_call_live` (not ended yet);
   * `disposition_invalid`; `fields_invalid`; `call_settled` (another code saved,
   * lapsed, or the call never bridged so there was nothing to write up).
   */
  async submitDisposition(
    actor: SoftphoneActor,
    callId: string,
    req: SubmitDispositionRequest,
  ): Promise<SoftphoneResult<DispositionSuccess>> {
    const found = await this.visibleCall(callId, actor);
    if (!found) return refuse({ code: 'call_not_found' });
    const row = found.call;
    if (row.state !== 'ended') return refuse({ code: 'manual_call_live', call: await this.wire(row) });

    const tag = row.campaign_id ? await agencyCampaignRepository.findById(row.campaign_id) : null;
    const settings = await agencySoftphoneSettingsRepository.get(actor.tenantId, actor.accountId);
    const { catalog, source } = resolveManualCatalog(tag, row.campaign_id !== null, settings);
    const now = new Date();
    const prepared = prepareManualDisposition({
      catalog,
      code: req.code,
      notes: req.notes,
      callbackAt: req.callbackAt,
      callFields: settings.call_fields,
      submittedFields: req.fields,
      storedFields: row.fields ?? {},
      now,
    });
    if (!prepared.ok) return prepared;
    const { entry, notes, callbackAt } = prepared.prepared;

    const contact = row.contact_id ? await agencyContactRepository.findById(row.contact_id) : null;
    const { decision, nextAttemptAt } = manualDispositionDecision({
      entry, now, callbackAt, placed: row.dialed_at !== null, contact, tag,
    });

    const client = await getPool().connect();
    let recorded: { call: AgencyManualCallRecord; replay: boolean };
    let dncEntry: DncEntryWritten | null = null;
    let contactState: AgencyManualCallDispositionResponse['contact_state'] = contact?.state ?? null;
    let nextAt: Date | null = null;
    try {
      await client.query('BEGIN');
      const result = await agencyManualCallRepository.recordDisposition({
        id: row.id,
        code: entry.code,
        source,
        notes,
        callbackAt,
        ...(prepared.prepared.fields !== undefined ? { fields: prepared.prepared.fields } : {}),
        actorUserId: actor.userId,
        onBehalf: found.onBehalf,
      }, { client });
      if (!result.ok) {
        await client.query('ROLLBACK');
        if (result.reason === 'not_found') return refuse({ code: 'call_not_found' });
        const current = result.call ?? row;
        if (result.reason === 'live') return refuse({ code: 'manual_call_live', call: await this.wire(current) });
        return refuse({ code: 'call_settled', call: await this.wire(current) });
      }
      if (!result.replay) {
        if (entry.suppress === true) {
          const marked = await markDnc({
            tenantId: row.tenant_id,
            ...dncMarkScope(row),
            phoneE164: row.destination_e164,
            reason: `disposition:${entry.code}`,
            addedBy: actor.userId,
          }, { client });
          if (marked.written) dncEntry = { id: marked.written.id, created: !marked.alreadyPresent };
        }
        const settled = await agencyContactRepository.settleFromManual({
          manualCallId: row.id,
          decision: { contactState: decision.contactState, nextAttemptAt, suppressedReason: decision.suppressedReason },
          charge: row.dialed_at !== null ? 'attempt' : 'none',
          lastOutcome: row.outcome,
          lastDisposition: entry.code,
        }, { client });
        if (settled) {
          contactState = settled.state;
          nextAt = settled.applied === 'settled' && settled.state === 'pending' ? settled.nextAttemptAt : null;
        }
        // A suppress outcome on a tagged call takes the number off the tag's roster, as
        // Mark DNC does (`markDnc` below): every other row of that campaign carrying it
        // (a household landline listed twice) leaves too, in this transaction, rather
        // than staying `pending` until pacing claims each one and its DNC gate
        // suppresses it. After the settlement, so the call's own contact is settled by
        // its decision first; a swept row keeps any reason it was already suppressed for.
        if (entry.suppress === true && row.campaign_id) {
          await agencyContactRepository.suppressByPhone(
            row.campaign_id, row.destination_e164, decision.suppressedReason ?? 'dnc', {}, { client },
          );
        }
      } else if (callbackAt && nextAttemptAt && decision.contactState === 'pending') {
        // A replay that corrected the callback time: the call row took the new
        // `callback_at` above, and the contact this call settled moves with it, as the
        // station's replay re-runs `markState`. Nothing else runs twice — no DNC mark,
        // no settlement, no attempt charged, no claim released.
        const moved = await agencyContactRepository.rescheduleFromManualReplay({
          manualCallId: row.id, dispositionCode: entry.code, nextAttemptAt,
        }, { client });
        if (moved) {
          contactState = moved.state;
          nextAt = moved.nextAttemptAt;
        }
      }
      await client.query('COMMIT');
      recorded = { call: result.call, replay: result.replay };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (!recorded.replay) await this.deps.agents.releaseManual(row.session_id, row.id);
    else if (contact && nextAt === null) {
      contactState = (await agencyContactRepository.findById(contact.id).catch(() => null))?.state ?? contactState;
    }
    const call = await this.deps.manual.sendFrame(recorded.call) ?? await this.wire(recorded.call);
    return {
      ok: true,
      onBehalf: found.onBehalf,
      replay: recorded.replay,
      dncEntry,
      response: {
        call,
        contact_state: contactState,
        next_attempt_at: nextAt ? nextAt.toISOString() : null,
        callback_requested_at: callbackAt ? callbackAt.toISOString() : null,
      },
    };
  }

  // ─── Mark DNC (POST /calls/:id/dnc) ───────────────────────────────────────

  /**
   * Mark the dialled number Do Not Call: campaign scope when the call is tagged
   * (and every roster row of that campaign carrying the number leaves the roster,
   * as the station's mark does), the call's ACCOUNT when untagged — never tenant-wide,
   * which is the station's `agency.dnc.manage` escalation (`dnc-mark.ts`) — one
   * transaction (B8). Allowed on any call the actor can see, live or settled.
   */
  async markDnc(
    actor: SoftphoneActor,
    callId: string,
    req: { reason?: string } = {},
  ): Promise<SoftphoneResult<DncSuccess>> {
    const found = await this.visibleCall(callId, actor);
    if (!found) return refuse({ code: 'call_not_found' });
    const row = found.call;
    const client = await getPool().connect();
    let recorded: Awaited<ReturnType<typeof markDnc>>;
    try {
      await client.query('BEGIN');
      if (row.campaign_id) {
        await agencyContactRepository.suppressByPhone(
          row.campaign_id, row.destination_e164, 'dnc',
          row.contact_id ? { alwaysContactId: row.contact_id } : {},
          { client },
        );
      }
      recorded = await markDnc({
        tenantId: row.tenant_id,
        ...dncMarkScope(row),
        phoneE164: row.destination_e164,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
        addedBy: actor.userId,
      }, { client });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const contact = row.contact_id ? await agencyContactRepository.findById(row.contact_id).catch(() => null) : null;
    await this.deps.manual.sendFrame(row);
    return {
      ok: true,
      onBehalf: found.onBehalf,
      dncEntry: recorded.written ? { id: recorded.written.id, created: !recorded.alreadyPresent } : null,
      response: {
        call_id: row.id,
        phone_e164: recorded.phoneE164 ?? row.destination_e164,
        scope: row.campaign_id ? 'campaign' : 'account',
        dnc_recorded: recorded.recorded,
        contact_state: contact?.state ?? null,
      },
    };
  }

  // ─── Switching a campaign session (SP7, §4.2) ─────────────────────────────

  /**
   * Put the actor's campaign session on the soft phone: `break` with
   * `soft_phone`, QUEUED exactly like a break while the agent is reserved, on a call
   * or in wrap-up (`breakMustWait`), and applied by `releaseAgent` at its end. The
   * `agent_state` frame announces it (suppressed for an unannounced dial, as the
   * break route does). Already on the soft phone, or the switch already queued: an
   * idempotent success marked `unchanged` (not audited a second time).
   *
   * The immediate switch is a CAS from the state just read (`transition`), never an
   * unconditional set: a pacing tick that reserved the agent between the read and the
   * write must not have its fresh `reserved` overwritten (the dial would ring with no
   * agent). A lost CAS re-reads once — now reserved, the switch is queued like any
   * break, and `fromState` is that re-read — and a write Redis cannot answer is
   * `dial_failed` (503, nothing changed).
   *
   * Refusals: `session_not_found`; `wrong_session_kind` (a soft-phone session);
   * `dial_failed` (the agent state store did not answer, or the state kept moving).
   */
  async switchToSoftphone(sessionId: string, actor: SoftphoneActor): Promise<SoftphoneResult<SessionSwitchSuccess>> {
    const session = await this.ownSession(sessionId, actor);
    if (!session) return refuse({ code: 'session_not_found' });
    if (!isCampaignSession(session)) return refuse({ code: 'wrong_session_kind' });
    const base = { session_id: session.id, campaign_id: session.campaign_id, kind: session.kind } as const;
    let live = await this.deps.agents.get(session.id);
    // What the decision was made from, for the audit's `from_state`: the state read on
    // the pass that decided, which after a lost CAS is the re-read (`reserved`, say),
    // not the first read the CAS lost on.
    const fromState = () => live?.state ?? null;
    const since = new Date().toISOString();

    for (let pass = 0; pass < 2; pass++) {
      if (onSoftphoneBreak(live, session)) {
        return {
          ok: true, fromState: fromState(), campaignId: session.campaign_id, queued: false, unchanged: true,
          response: { ...base, state: 'break', since, break_reason: SOFTPHONE_BREAK_REASON },
        };
      }
      if (breakMustWait(live?.state)) {
        const busy = live!.state;
        const alreadyQueued = this.deps.breaks.peek(session.id)?.code === SOFTPHONE_BREAK_REASON;
        this.deps.breaks.queue(session.id, { code: SOFTPHONE_BREAK_REASON, label: SOFTPHONE_BREAK_REASON_LABEL });
        if (!this.deps.dialer.hasUnannouncedAttempt(session.id)) {
          this.deps.stations.send(session.id, {
            event: 'agent_state', state: busy, since,
            pending_state: 'break', pending_break_reason: SOFTPHONE_BREAK_REASON,
          });
        }
        return {
          ok: true, fromState: fromState(), campaignId: session.campaign_id, queued: true, unchanged: alreadyQueued,
          response: { ...base, state: busy, since, pending_state: 'break', break_reason: SOFTPHONE_BREAK_REASON },
        };
      }
      // No lease at all: there is no state to race (a reservation CASes from a live
      // `available`), so the write creates it.
      const moved = live
        ? await this.deps.agents.transition(session.id, live.state, 'break', { leaseMs: AGENT_LEASE_MS.break })
        : (await this.deps.agents.set(session.id, 'break', { leaseMs: AGENT_LEASE_MS.break })) === 'ok';
      if (moved) break;
      if (pass === 1 || !live) return refuse({ code: 'dial_failed' });
      live = await this.deps.agents.get(session.id);
      if (!live) return refuse({ code: 'dial_failed' });
    }
    await agencyAgentSessionRepository.setState(session.id, 'break', SOFTPHONE_BREAK_REASON);
    this.deps.stations.send(session.id, { event: 'agent_state', state: 'break', since, break_reason: SOFTPHONE_BREAK_REASON });
    return {
      ok: true, fromState: fromState(), campaignId: session.campaign_id, queued: false, unchanged: false,
      response: { ...base, state: 'break', since, break_reason: SOFTPHONE_BREAK_REASON },
    };
  }

  /**
   * Return the actor's campaign session from the soft phone: end the `soft_phone`
   * break (`available`). A switch still QUEUED is simply withdrawn (the session
   * stays in its current state). Refusals: `session_not_found`; `wrong_session_kind`
   * (a soft-phone session); `manual_call_live` while a call is live or awaiting its
   * outcome; `not_on_softphone`; `station_unavailable` (no station socket here —
   * going available needs one, as `POST /sessions/:id/available` does); `dial_failed`
   * when the agent state store cannot answer the write (nothing is written to the
   * session row and no frame is sent: the agent is still on the soft phone).
   */
  async returnFromSoftphone(sessionId: string, actor: SoftphoneActor): Promise<SoftphoneResult<SessionSwitchSuccess>> {
    const session = await this.ownSession(sessionId, actor);
    if (!session) return refuse({ code: 'session_not_found' });
    if (!isCampaignSession(session)) return refuse({ code: 'wrong_session_kind' });
    const live = await this.deps.agents.get(session.id);
    const fromState = live?.state ?? null;
    const since = new Date().toISOString();
    const base = { session_id: session.id, campaign_id: session.campaign_id, kind: session.kind } as const;

    if (this.deps.breaks.peek(session.id)?.code === SOFTPHONE_BREAK_REASON) {
      this.deps.breaks.cancel(session.id);
      const state = live?.state ?? session.state;
      if (!this.deps.dialer.hasUnannouncedAttempt(session.id)) {
        this.deps.stations.send(session.id, { event: 'agent_state', state, since });
      }
      return { ok: true, fromState, campaignId: session.campaign_id, queued: false, unchanged: false, response: { ...base, state, since } };
    }

    const pending = await this.pendingRefusal(session.id);
    if (pending) return refuse({ code: 'manual_call_live', call: (pending as { call: AgencyManualCall }).call });
    if (!onSoftphoneBreak(live, session)) {
      return refuse({ code: 'not_on_softphone' });
    }
    if (!this.deps.stations.isLocallyOwned(session.id)) return refuse({ code: 'station_unavailable' });

    const set = await setAvailableGuarded(this.deps.agents, session.id);
    if (!set.ok) {
      // Redis did not take the write: reporting `available` here would put the agent
      // in the DB and on the console as ready while pacing (which reads Redis) never
      // sees them. Nothing changed; retry.
      // So did a `manual` claim that would not clear (`claim_not_released`).
      if (set.refusal.code === 'unavailable' || set.refusal.code === 'claim_not_released') return refuse({ code: 'dial_failed' });
      return refuse(set.refusal);
    }
    await agencyAgentSessionRepository.setState(session.id, 'available');
    this.deps.stations.send(session.id, { event: 'agent_state', state: 'available', since });
    return { ok: true, fromState, campaignId: session.campaign_id, queued: false, unchanged: false, response: { ...base, state: 'available', since } };
  }

  // ─── Station reconnect (§4.1 step 9) ──────────────────────────────────────

  /** Re-adopt a live call onto a reconnected station socket; the call to restore, or null. */
  reattachStation(sessionId: string, ws: WebSocket): Promise<AgencyManualCall | null> {
    return this.deps.manual.reattachStation(sessionId, ws);
  }
}

/**
 * The scope of a soft-phone DNC mark: the tag's campaign, else the account the call
 * belongs to (`dnc-mark.ts`, `accountScope`), so an agent's untagged mark never
 * writes a tenant-wide row.
 */
function dncMarkScope(row: AgencyManualCallRecord): { campaignId: string } | { accountScope: string } {
  return row.campaign_id ? { campaignId: row.campaign_id } : { accountScope: row.account_id };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
