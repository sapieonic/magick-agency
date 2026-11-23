/**
 * ─── FINISHING AN ANSWERED INBOUND CALL (docs/inbound.md §2 step 8, §6; P2) ─────────────────
 *
 * The runtime half of the inbound call routes (`/inbound/calls/:id`: read, notes, hang up, the
 * outcome, Mark DNC), modelled on the soft phone's (`softphone/softphone-service.ts`) and reusing
 * its outcome machinery: the submitted code validated against the call's catalog with the
 * station's own pure functions (`prepareManualDisposition`), the roster decision
 * (`manualDispositionDecision`, a callback moved into the contact's calling window), the DNC mark
 * (`markDnc`, B8). Refusals map 1:1 onto `AgencyInboundErrorCode`; RBAC, the flag (never: the
 * finish routes are not gated) and the audit rows are the API layer's.
 *
 * Who may act: the agent the call was offered to or connected with (its session's agent, or the
 * agent it bridged to), or a caller vouched for as `agency.supervise` (then `on_behalf`). Anyone
 * else, a call of another account, or a call that never reached an agent: `inbound_call_not_found`.
 *
 * ── The outcome (§2 step 8; IQ10, IQ11) ────────────────────────────────────────────
 * Only once the call ENDED after it BRIDGED. Against the matched campaign's catalog (whatever its
 * status), else the catalog of the campaign an unknown caller's call is filed under, else the
 * route's, else the built-in one (`resolveInboundCatalog`). With the account's "Every call must
 * belong to a campaign" on, a call filed under none is refused `campaign_required`; the request
 * may name the campaign (`campaign_id`), filed in the same transaction (docs/call-log.md §5). One transaction:
 * the spine row saved and settled (`saveDisposition`, the soft phone's discipline: the same code
 * again is an idempotent replay, notes and callback last-write-wins, nothing settles twice; a
 * different code, or one after the lapse, is `inbound_outcome_already_saved`), then on a first
 * save: a suppress code's DNC mark (campaign scope when the caller MATCHED a campaign's list, else
 * the call's account, CL6: a campaign the call is only filed under never narrows the mark; never
 * tenant-wide) and the matched campaign's roster rows with the number, and the matched contact
 * settled forward only (`inbound-settlement.ts`). After the commit the session's `inbound` field
 * is cleared (by this id) and the agent returned (`releaseAgent`: a queued break applies, or the
 * release hook offers them the next caller).
 *
 * ── The lapse (§6) ───────────────────────────────────────────────────────────────
 * {@link InboundCallService.sweepLapsed}, every few seconds: a bridged call whose outcome did not
 * come within its window (`inbound-wrapup.ts`: the route's wrap-up window captured on the call,
 * IQ52, else 30 s, never past the 30-minute backstop `AGENCY_INBOUND_OUTCOME_LAPSE_MS`), or
 * whose session left, is closed `no_disposition` (`lapseUnsettled`), its field cleared and its
 * agent returned, from the wrap-up it holds them in only ({@link returnsToPool}: an agent on a
 * break stays on it, SWE-M1). A supervisor's force-available closes one the same way
 * ({@link InboundCallService.closeOwedForSupervisor}) and returns the agent. Either close settles
 * the matched contact in the same transaction, as an outcome that moves nothing would (SWE-F2): the
 * customer was reached, so the inbound callback a missed call booked is cleared, and a contact that
 * callback reopened from exhausted goes back to exhausted.
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { createChildLogger } from '@magick-agency/observability';
import { inboundScheduleState } from '@magick-agency/domain/inbound-schedule';
import type { AgencyInboundQueueTile } from '@magick-agency/contracts/api/agency/inbound';
import type {
  AgencySoftphoneDispositionInvalidRefusal,
  AgencyContactState,
  AgencyInboundCall,
  AgencyInboundCallCampaignOption,
  AgencyInboundCallDispositionResponse,
  AgencyInboundCallDncResponse,
} from '@magick-agency/contracts/agency';
import {
  agencyAgentSessionRepository,
  agencyCallSettingsRepository,
  agencyCampaignRepository,
  agencyContactRepository,
  agencyInboundCallRepository,
  agencyInboundRouteRepository,
  promiseDateText,
  type AgencyInboundCallRecord,
  type RequireCampaign,
} from '../../db/repositories/agency.repository.js';
import type { WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';
import type { AgentLiveState, AgentStateMachine } from '../agent-state-machine.js';
import type { StationRegistry } from '../station-registry.js';
import { markDnc, type DncMarkResult } from '../dnc-mark.js';
import { manualDispositionDecision, prepareManualDisposition } from '../softphone/manual-disposition.js';
import { promiseZoneFor } from '../disposition.js';
import { contactPromiseWrite, promiseFollowUpAt } from '../promise-to-pay.js';
import { todayIn } from '@magick-agency/domain/promise-to-pay';
import type { SoftphoneActor } from '../softphone/types.js';
import { UUID_RE } from '../../utils/uuid.js';
import { withTimeoutOr } from '../../utils/with-timeout.js';
import {
  campaignRequiredFor, inboundCallToWire, loadInboundPanelContext, resolveInboundCatalog, type InboundPanelPreloaded,
} from './inbound-call-wire.js';
import { findTaggableCampaign, listTaggableCampaigns } from '../softphone/taggable-campaign.js';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { INBOUND_LAPSE_SETTLEMENT, inboundContactSettlement } from './inbound-settlement.js';
import type { InboundAgentViewsMemo, InboundConnector } from './inbound-connector.js';
import { callbackBookerOf } from '../call-later.js';

const log = createChildLogger({ component: 'agency-inbound-calls' });

/** Who is acting: the soft phone's actor (the API layer resolved and vouched for it). */
export type InboundCallActor = SoftphoneActor;

/** What the inbound call operations refuse with (`AgencyInboundErrorCode`, the wire names of each body's fields). */
export type InboundCallRefusal =
  | { code: 'inbound_call_not_found' }
  | { code: 'inbound_call_not_dispositionable' }
  | { code: 'inbound_outcome_already_saved' }
  /** A matched caller's campaign is fixed (CL4). */
  | { code: 'inbound_campaign_fixed' }
  /** The campaign named is not one the actor may log to. */
  | { code: 'inbound_campaign_not_allowed' }
  /**
   * The soft phone family's code (docs/call-log.md §5): the account's "Every call must belong to
   * a campaign" applies to the call and it is filed under none.
   */
  | { code: 'campaign_required' }
  | {
    code: 'inbound_disposition_invalid';
    /** The soft phone's rules but its own `promise_needs_contact` (a matched call has its contact). */
    reason: Exclude<AgencySoftphoneDispositionInvalidRefusal['reason'], 'promise_needs_contact'>;
    allowed_codes?: string[];
  };

export type InboundCallResult<T> = ({ ok: true } & T) | { ok: false; refusal: InboundCallRefusal };

/** A DNC row a mark landed on, for the `dnc_entry.created` audit row (`created`: newly listed). */
export interface InboundDncEntryWritten {
  id: string;
  created: boolean;
}

export interface InboundCallServiceDeps {
  bridge: Pick<WebRtcBridgeManager, 'forceEndWithOutcome'>;
  agents: Pick<AgentStateMachine, 'releaseInbound' | 'get'>;
  stations: Pick<StationRegistry, 'send' | 'isLocallyOwned'>;
  releaseAgent: (sessionId: string) => Promise<unknown>;
  /** The connector, when this process runs one (the hang-up asks it and waits for the call's end; the queue tiles). */
  connector: () => Pick<InboundConnector, 'holds' | 'hangUp' | 'whenLeft' | 'queueSnapshot' | 'routeAgents'> | null;
}

/** How long a hang-up waits for the connector to have ended and settled the call before answering. */
export const INBOUND_HANGUP_SETTLE_MS = 5_000;

const refuse = (refusal: InboundCallRefusal): { ok: false; refusal: InboundCallRefusal } => ({ ok: false, refusal });

export class InboundCallService {
  constructor(private readonly deps: InboundCallServiceDeps) {}

  /** The call, if the actor may act on it (see the header); `onBehalf` when it is another agent's. */
  private async visible(
    callId: string,
    actor: InboundCallActor,
  ): Promise<{ call: AgencyInboundCallRecord; takerUserId: string | null; onBehalf: boolean } | null> {
    if (!UUID_RE.test(callId)) return null;
    const call = await agencyInboundCallRepository.findById(actor.tenantId, callId);
    if (!call || call.account_id !== actor.accountId || call.session_id === null) return null;
    const takerUserId = await this.takerOf(call);
    const onBehalf = takerUserId !== actor.userId;
    if (onBehalf && !actor.supervise) return null;
    return { call, takerUserId, onBehalf };
  }

  /** The agent the call was offered to or connected with. */
  private async takerOf(call: AgencyInboundCallRecord): Promise<string | null> {
    if (call.answered_by_user_id) return call.answered_by_user_id;
    if (!call.session_id) return null;
    const session = await agencyAgentSessionRepository.findById(call.session_id).catch(() => null);
    return session?.agent_user_id ?? null;
  }

  /** The panel row of `call`, as the station frames send it. `preloaded`: what this request already read. */
  async wire(call: AgencyInboundCallRecord, takerUserId?: string | null, preloaded?: InboundPanelPreloaded): Promise<AgencyInboundCall> {
    const taker = takerUserId === undefined ? await this.takerOf(call) : takerUserId;
    return inboundCallToWire(call, await loadInboundPanelContext(call, preloaded ? { preloaded } : {}), taker);
  }

  /** Tell the call's session (its panel follows every change). Never throws. */
  private async sendFrame(
    call: AgencyInboundCallRecord,
    takerUserId: string | null,
    preloaded?: InboundPanelPreloaded,
  ): Promise<AgencyInboundCall> {
    const wire = await this.wire(call, takerUserId, preloaded);
    if (call.session_id) this.deps.stations.send(call.session_id, { event: 'inbound_call', call: wire });
    return wire;
  }

  // ─── Reads and notes ─────────────────────────────────────────────────────

  async get(actor: InboundCallActor, callId: string): Promise<InboundCallResult<{ call: AgencyInboundCall; onBehalf: boolean }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    return { ok: true, call: await this.wire(found.call, found.takerUserId), onBehalf: found.onBehalf };
  }

  /** Replace the notes while the call is unsettled (`''` clears them); last write wins. */
  async updateNotes(
    actor: InboundCallActor,
    callId: string,
    notes: string,
  ): Promise<InboundCallResult<{ call: AgencyInboundCall; onBehalf: boolean }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    const updated = await agencyInboundCallRepository.updateNotes(found.call.id, notes);
    if (!updated) return refuse({ code: 'inbound_outcome_already_saved' });
    return { ok: true, call: await this.sendFrame(updated, found.takerUserId), onBehalf: found.onBehalf };
  }

  // ─── Hang up ─────────────────────────────────────────────────────────────

  /**
   * Hang up. Whether the call is still live here is the connector's to say, not the row's: a row
   * the stale sweep ended while its bridge call goes on still gets that call ended (SWE-m1).
   *  - A call on OFFER whose audio has not bound: the agent turned it down (QA-F3). The connector
   *    puts the caller back at the head of the queue for the next agent (never this one again) and
   *    returns the agent to the pool; nothing is recorded as abandoned, no Missed row, no callback.
   *    Answers the requeued row, as the connector's last frame to the agent shows it (theirs no more).
   *  - A connected call: ended `agent_hangup`; answers the ended row once the connector has written
   *    the end (its completion promise, bounded by {@link INBOUND_HANGUP_SETTLE_MS}).
   * Idempotent: a call this process no longer holds answers its row with `hungUp: false`.
   */
  async hangup(actor: InboundCallActor, callId: string): Promise<InboundCallResult<{ call: AgencyInboundCall; onBehalf: boolean; hungUp: boolean }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    const connector = this.deps.connector();
    let hungUp = false;
    if (connector?.holds(found.call.id)) {
      const step = await connector.hangUp(found.call.id);
      if (step.kind === 'declined') {
        const wire = await this.wire(step.call, null);
        return { ok: true, call: { ...wire, session_id: found.call.session_id ?? wire.session_id }, onBehalf: found.onBehalf, hungUp: true };
      }
      if (step.kind === 'end') {
        hungUp = await this.deps.bridge.forceEndWithOutcome(found.call.id, 'agent_hangup');
        // The connector's end, or give up waiting (the row as it stands then is answered). Never rejects.
        if (hungUp) await withTimeoutOr(connector.whenLeft(found.call.id).catch(() => undefined), INBOUND_HANGUP_SETTLE_MS, undefined);
      }
    }
    const fresh = await agencyInboundCallRepository.findById(actor.tenantId, found.call.id);
    return { ok: true, call: await this.wire(fresh ?? found.call, found.takerUserId), onBehalf: found.onBehalf, hungUp };
  }

  // ─── The outcome ─────────────────────────────────────────────────────────

  async submitDisposition(
    actor: InboundCallActor,
    callId: string,
    req: {
      code: string; notes?: string; callbackAt?: string; promiseDate?: unknown; promiseAmount?: unknown;
      /** File an unknown caller's call under this campaign with the outcome (CL4). */
      campaignId?: string;
    },
    /** Internal: this is the one retry after the call was refiled under the save (see below). */
    retried = false,
  ): Promise<InboundCallResult<{
    response: AgencyInboundCallDispositionResponse;
    onBehalf: boolean;
    replay: boolean;
    dncEntry: InboundDncEntryWritten | null;
  }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    const row = found.call;
    if (row.state !== 'ended' || row.bridged_at === null) return refuse({ code: 'inbound_call_not_dispositionable' });

    // ── The campaign the call is filed under (docs/call-log.md §5) ───────────────────
    // A `campaign_id` on the request files an unknown caller's call under it, in the outcome's
    // transaction; the one the call already has is accepted as it is.
    let filing: { campaign: AgencyCampaignRecord; source: 'agent' | 'supervisor' } | null = null;
    if (req.campaignId !== undefined && req.campaignId !== row.campaign_id) {
      const chosen = await this.campaignChoice(row, actor, req.campaignId);
      if ('refusal' in chosen) return refuse(chosen.refusal);
      filing = { campaign: chosen.campaign, source: found.onBehalf ? 'supervisor' : 'agent' };
    }
    // With the account's setting on, a call filed under no campaign takes no outcome (CL3): not
    // a replay of one already saved, and not a call that arrived before the switch (CL19).
    let required: RequireCampaign | undefined;
    if (!filing && row.campaign_id === null && row.disposition_code === null && row.account_id !== null) {
      required = await agencyCallSettingsRepository.requireCampaign(row.tenant_id, row.account_id);
      if (campaignRequiredFor(row, required)) return refuse({ code: 'campaign_required' });
    }
    // The campaign whose catalog applies when the caller is on no list: the one being filed, else
    // the one the call is already under (the route's, or an earlier choice).
    const filedId = row.matched_campaign_id === null ? (filing?.campaign.id ?? row.campaign_id) : null;

    const [campaign, route, contact, filedRead] = await Promise.all([
      row.matched_campaign_id ? agencyCampaignRepository.findById(row.matched_campaign_id) : Promise.resolve(null),
      row.route_id ? agencyInboundRouteRepository.findForCall(row.tenant_id, row.route_id) : Promise.resolve(null),
      row.matched_contact_id ? agencyContactRepository.findById(row.matched_contact_id) : Promise.resolve(null),
      filing ? Promise.resolve(filing.campaign) : filedId ? agencyCampaignRepository.findById(filedId) : Promise.resolve(null),
    ]);
    const tag = campaign && campaign.tenant_id === row.tenant_id ? campaign : null;
    const filedCampaign = filedRead && filedRead.tenant_id === row.tenant_id ? filedRead : null;
    const { catalog, stored } = resolveInboundCatalog(
      row.matched_campaign_id !== null, tag, route, filedId ? { campaign: filedCampaign } : null,
    );
    const now = new Date();
    // A promise's "today" is the customer's (PT4): the matched contact's zone, else its campaign's.
    const promiseZone = promiseZoneFor(contact?.timezone, tag?.default_timezone);
    const prepared = prepareManualDisposition({
      catalog, code: req.code, notes: req.notes, callbackAt: req.callbackAt,
      promiseDate: req.promiseDate, promiseAmount: req.promiseAmount,
      promiseToday: todayIn(promiseZone, now) ?? undefined,
      recorded: { code: row.disposition_code, promiseDate: promiseDateText(row.promise_date ?? null) },
      callFields: [], submittedFields: undefined, storedFields: {}, now,
    });
    if (!prepared.ok) {
      const r = prepared.refusal;
      if (r.code === 'disposition_invalid' && r.reason !== 'promise_needs_contact') {
        return refuse({ code: 'inbound_disposition_invalid', reason: r.reason, ...(r.allowed_codes ? { allowed_codes: r.allowed_codes } : {}) });
      }
      // No call fields on an inbound call (IQ22), and `promise_needs_contact` is the soft
      // phone's own check, never `prepareManualDisposition`'s: unreachable.
      return refuse({ code: 'inbound_disposition_invalid', reason: 'unknown_code' });
    }
    const { entry, notes, callbackAt, promise } = prepared.prepared;
    // Only a matched campaign's catalogue may ask for a promise (a route's refuses
    // `requires_promise`). Its follow-up (PT2) takes the callback arm; a promise alone books
    // nothing (PT3).
    const followUpAt = promiseFollowUpAt(entry, promise, promiseZone);
    const { decision, nextAttemptAt } = manualDispositionDecision({
      entry, now, callbackAt: callbackAt ?? followUpAt, placed: false, contact, tag,
    });
    const settlement = inboundContactSettlement(entry, decision, nextAttemptAt, { followUp: followUpAt !== null });
    // Agent station (BE-3): a call-later the agent who answered books on this call is theirs, as on
    // the station; a supervisor's on-behalf save records no booker (`callbackBookerOf`).
    const callbackBooker = callbackBookerOf({
      decisionReason: decision.reason,
      entry,
      followUpBooked: followUpAt !== null,
      onBehalf: found.onBehalf,
      reservedUserId: row.answered_by_user_id ?? null,
    });

    // Written inside the transaction below (typed wide: TS does not follow writes in a callback).
    let dncEntry = null as InboundDncEntryWritten | null;
    let contactState: AgencyContactState | null = contact?.state ?? null;
    let nextAt = null as Date | null;
    const saved = await withTransaction(async (client, tx): Promise<{ call: AgencyInboundCallRecord; replay: boolean } | { refusal: InboundCallRefusal } | { refiled: true }> => {
      if (filing) {
        // Filed first, in this transaction: a save refused below rolls the filing back with it.
        const filed = await agencyInboundCallRepository.fileUnderCampaign({
          id: row.id, tenantId: row.tenant_id, campaignId: filing.campaign.id, source: filing.source,
        }, { client });
        if (!filed) {
          // Settled since it was read (another save, or the lapse).
          await tx.rollback();
          return { refusal: { code: 'inbound_outcome_already_saved' } };
        }
      }
      const result = await agencyInboundCallRepository.saveDisposition({
        id: row.id, code: entry.code, source: stored, notes, callbackAt,
        promiseDate: promise?.date ?? null, promiseAmount: promise?.amount ?? null,
        actorUserId: actor.userId, onBehalf: found.onBehalf,
        // The code was validated against this campaign's catalog, read before the transaction:
        // the save holds only while the call is still filed under it.
        expectedCampaignId: filing ? filing.campaign.id : row.campaign_id,
      }, { client });
      if (!result.ok) {
        await tx.rollback();
        if (result.reason === 'campaign_changed') return { refiled: true };
        if (result.reason === 'not_found') return { refusal: { code: 'inbound_call_not_found' } };
        if (result.reason === 'live' || result.reason === 'not_bridged') return { refusal: { code: 'inbound_call_not_dispositionable' } };
        return { refusal: { code: 'inbound_outcome_already_saved' } };
      }
      if (!result.replay) {
        if (entry.suppress === true && row.from_e164) {
          dncEntry = (await markCallerDnc(row, row.from_e164, actor.userId, `disposition:${entry.code}`, client)).entry;
        }
        const settled = await agencyContactRepository.settleFromInbound({
          inboundCallId: row.id, settlement, lastDisposition: entry.code, callbackBooker,
        }, { client });
        if (settled) {
          contactState = settled.state;
          nextAt = settled.applied === 'settled' && settled.state === 'pending' && settlement.kind === 'callback' ? settled.nextAttemptAt : null;
        }
        // A suppress outcome takes the number off the matched campaign's roster, as Mark DNC does.
        if (entry.suppress === true && row.matched_campaign_id && row.from_e164) {
          await agencyContactRepository.suppressByPhone(
            row.matched_campaign_id, row.from_e164, decision.suppressedReason ?? 'dnc', {}, { client },
          );
        }
      } else if (settlement.kind === 'callback') {
        // A replay that corrected the callback time or the promised date: the contact the first
        // save booked moves with it, as the soft phone's replay does (only while it is still
        // `pending` on this code). Nothing else runs twice: no DNC mark, no settlement.
        const moved = await agencyContactRepository.rescheduleFromInboundReplay({
          inboundCallId: row.id, dispositionCode: entry.code, nextAttemptAt: settlement.at, callbackBooker,
        }, { client });
        if (moved) {
          contactState = moved.state;
          nextAt = moved.nextAttemptAt;
        }
      }
      // The matched contact's latest promise, or an earlier one followed up (PT6, PT7); on a
      // replay too, so a corrected promise reaches the contact.
      if (row.matched_contact_id && contact) {
        const callAt = new Date(row.arrived_at);
        const write = promise ? contactPromiseWrite(promise, promiseZone, callAt) : null;
        if (write) await agencyContactRepository.recordContactPromise({ contactId: row.matched_contact_id, promise: write }, { client });
        else await agencyContactRepository.notePromiseFollowUp({ contactId: row.matched_contact_id, callAt }, { client });
      }
      return { call: result.call, replay: result.replay };
    }, { pool: getPool() });
    if ('refiled' in saved) {
      // The call was filed under another campaign between the read and the save (a supervisor's
      // Change while the agent pressed Save): nothing was written. Judge the code once more,
      // against the campaign the call is under now; it is saved there or refused with that
      // campaign's codes, never kept from the other's catalog. Once: a second refile in the
      // same instant is refused, and the panel's next frame carries the outcomes to choose from.
      if (retried) return refuse({ code: 'inbound_disposition_invalid', reason: 'unknown_code' });
      return this.submitDisposition(actor, callId, req, true);
    }
    if ('refusal' in saved) return refuse(saved.refusal);

    if (!saved.replay) await this.returnAgent(saved.call);
    // The panel's rebuild reads the campaigns and the call settings held above, not a second time.
    const call = await this.sendFrame(saved.call, found.takerUserId, {
      campaigns: [campaign, filedRead], ...(required ? { requireCampaign: required } : {}),
    });
    return {
      ok: true,
      onBehalf: found.onBehalf,
      replay: saved.replay,
      dncEntry,
      response: {
        call,
        contact_state: contactState,
        next_attempt_at: nextAt ? nextAt.toISOString() : null,
        callback_requested_at: callbackAt ? callbackAt.toISOString() : null,
      },
    };
  }

  // ─── The campaign an unknown caller's call is filed under (docs/call-log.md §5) ──

  /**
   * Whether `actor` may file `row` under campaign `campaignId`: never a matched caller's call
   * (its campaign is fixed, CL4), never a settled one, and only a campaign the actor may log a
   * call to (the soft phone's rule, `findTaggableCampaign`).
   */
  private async campaignChoice(
    row: AgencyInboundCallRecord,
    actor: InboundCallActor,
    campaignId: string,
  ): Promise<{ campaign: AgencyCampaignRecord } | { refusal: InboundCallRefusal }> {
    if (row.matched_campaign_id !== null) return { refusal: { code: 'inbound_campaign_fixed' } };
    if (row.settled_at !== null) return { refusal: { code: 'inbound_outcome_already_saved' } };
    const campaign = await findTaggableCampaign(campaignId, actor);
    return campaign ? { campaign } : { refusal: { code: 'inbound_campaign_not_allowed' } };
  }

  /**
   * File an unknown caller's call under a campaign at wrap-up ("Change" beside "Filed under"):
   * the call ended after it bridged and its outcome is not saved. Source `agent`, or
   * `supervisor` on behalf. The answer's `disposition_catalog` is the new campaign's, and the
   * call's session is told (its panel reloads the outcomes). Choosing the campaign it already
   * has changes nothing.
   */
  async setCampaign(
    actor: InboundCallActor,
    callId: string,
    campaignId: string,
  ): Promise<InboundCallResult<{ call: AgencyInboundCall; onBehalf: boolean; changed: boolean; fromCampaignId: string | null }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    const row = found.call;
    if (row.matched_campaign_id !== null) return refuse({ code: 'inbound_campaign_fixed' });
    if (row.state !== 'ended' || row.bridged_at === null) return refuse({ code: 'inbound_call_not_dispositionable' });
    if (campaignId === row.campaign_id) {
      return { ok: true, call: await this.wire(row, found.takerUserId), onBehalf: found.onBehalf, changed: false, fromCampaignId: row.campaign_id };
    }
    const chosen = await this.campaignChoice(row, actor, campaignId);
    if ('refusal' in chosen) return refuse(chosen.refusal);
    const filed = await agencyInboundCallRepository.fileUnderCampaign({
      id: row.id, tenantId: row.tenant_id, campaignId: chosen.campaign.id, source: found.onBehalf ? 'supervisor' : 'agent',
    });
    if (!filed) return refuse({ code: 'inbound_outcome_already_saved' });
    return {
      ok: true, call: await this.sendFrame(filed, found.takerUserId, { campaigns: [chosen.campaign] }), onBehalf: found.onBehalf,
      changed: true, fromCampaignId: row.campaign_id,
    };
  }

  /** The campaigns `actor` may file call `callId` under, newest first (the soft phone's rule). */
  async campaignOptions(
    actor: InboundCallActor,
    callId: string,
  ): Promise<InboundCallResult<{ campaigns: AgencyInboundCallCampaignOption[] }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    const campaigns = await listTaggableCampaigns(actor);
    return { ok: true, campaigns: campaigns.map((c) => ({ campaign_id: c.id, campaign_name: c.name })) };
  }

  /**
   * A settled call's session: the `inbound` field cleared (by this id), and the agent returned
   * (`releaseAgent`) only when the call is what holds them out of the pool — read live, before
   * the field is cleared ({@link returnsToPool}). An agent who chose a break since (a restart
   * landed them on `break` with the call re-claimed, and they pressed a break) keeps it, and one
   * the station close wrote `offline` stays out: their own "Go available" brings them back.
   */
  private async returnAgent(call: AgencyInboundCallRecord): Promise<void> {
    if (!call.session_id) return;
    const sessionId = call.session_id;
    const live = await this.deps.agents.get(sessionId);
    await this.deps.agents.releaseInbound(sessionId, call.id);
    if (!this.deps.stations.isLocallyOwned(sessionId)) return;
    if (!returnsToPool(live, call.id)) {
      log.info({ sessionId, inboundCallId: call.id, state: live?.state ?? null }, 'Inbound call settled — the agent is not returned from where they are');
      return;
    }
    await Promise.resolve(this.deps.releaseAgent(sessionId)).catch((err: unknown) =>
      log.error({ err, sessionId, inboundCallId: call.id }, 'Could not return the agent after an inbound outcome'));
  }

  // ─── Mark DNC ────────────────────────────────────────────────────────────

  /**
   * Mark the caller's number Do Not Call: the matched campaign's scope (and its roster rows with
   * the number leave the roster), else the call's account; never tenant-wide. Any call the actor
   * may see, live or settled. A withheld number records nothing.
   */
  async markDnc(
    actor: InboundCallActor,
    callId: string,
    req: { reason?: string } = {},
  ): Promise<InboundCallResult<{ response: AgencyInboundCallDncResponse; onBehalf: boolean; dncEntry: InboundDncEntryWritten | null }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    const row = found.call;
    const scope = row.matched_campaign_id ? 'campaign' as const : 'account' as const;
    const fromE164 = row.from_e164;
    const recorded = fromE164 === null ? null : await withTransaction(async (client) => {
      if (row.matched_campaign_id) {
        await agencyContactRepository.suppressByPhone(
          row.matched_campaign_id, fromE164, 'dnc',
          row.matched_contact_id ? { alwaysContactId: row.matched_contact_id } : {},
          { client },
        );
      }
      return markCallerDnc(row, fromE164, actor.userId, req.reason, client);
    }, { pool: getPool() });
    const contact = row.matched_contact_id ? await agencyContactRepository.findById(row.matched_contact_id).catch(() => null) : null;
    return {
      ok: true,
      onBehalf: found.onBehalf,
      dncEntry: recorded?.entry ?? null,
      response: {
        call_id: row.id,
        phone_e164: recorded?.result.phoneE164 ?? row.from_e164 ?? '',
        scope,
        dnc_recorded: recorded?.result.recorded ?? false,
        contact_state: contact?.state ?? null,
      },
    };
  }

  // ─── The supervisor's queue tiles ────────────────────────────────────────

  /**
   * One tile per live route of the account, by route name (docs/inbound.md §6): open now by its
   * hours, the callers waiting and the longest wait, the calls with an agent (on offer or
   * connected), the agents free who could take the route's waiting callers (each judged by the
   * caller's own account, as the connector judges them: QA-F5) or, with nobody waiting, its next
   * caller, and whether nobody at all could take its next caller (`no_agents_available`, PM-M6:
   * such a caller is overflowed at once). The queue is the connector's, in memory (one process,
   * IB8): with no connector every count is 0 and `no_agents_available` false (nothing is put
   * through on this deployment at all; the route editor and super-admin say so).
   */
  async queueTiles(tenantId: string, accountId: string, now: Date = new Date()): Promise<AgencyInboundQueueTile[]> {
    const connector = this.deps.connector();
    const snapshot = new Map((connector?.queueSnapshot() ?? []).map((s) => [s.routeId, s]));
    const routes = await agencyInboundRouteRepository.listForAccount(tenantId, accountId);
    // One read of each account's agents for every route (they share the account).
    const views: InboundAgentViewsMemo = new Map();
    const tiles = await Promise.all(routes.map(async (route): Promise<AgencyInboundQueueTile> => {
      const s = snapshot.get(route.id);
      const agents = connector ? await connector.routeAgents(route, views) : null;
      return {
        route_id: route.id,
        route_name: route.name,
        open_now: inboundScheduleState(route, now) === 'open',
        waiting: s?.waiting ?? 0,
        longest_wait_seconds: s?.longestWaitSeconds ?? 0,
        connected: (s?.offered ?? 0) + (s?.connected ?? 0),
        eligible_agents: agents?.eligible ?? 0,
        no_agents_available: agents?.noneCouldTake ?? false,
      };
    }));
    return tiles.sort((a, b) => a.route_name.localeCompare(b.route_name));
  }

  // ─── The lapse sweep ─────────────────────────────────────────────────────

  /**
   * Close every answered call whose outcome lapsed (see the header), in batches. Returns how many.
   * Each one's session is told (its panel shows the call settled) and its agent returned.
   */
  async sweepLapsed(batch = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await withTransaction(async (client) => {
        const closed = await agencyInboundCallRepository.lapseUnsettled({ limit: batch }, { client });
        for (const row of closed) await settleLapsedContact(row, client);
        return closed;
      }, { pool: getPool() });
      for (const row of rows) {
        try {
          await this.returnAgent(row);
          await this.sendFrame(row, await this.takerOf(row));
        } catch (err) {
          log.warn({ err, inboundCallId: row.id }, 'Could not return the agent of a lapsed inbound call');
        }
      }
      total += rows.length;
      if (rows.length < batch) return total;
    }
  }

  // ─── A supervisor's force-available (docs/inbound.md §6) ─────────────────

  /**
   * Before a supervisor's force-available returns `sessionId` to the pool: an inbound call whose
   * outcome the agent owes is closed as the lapse closes it (`no_disposition`, nobody recorded it;
   * the route audits it as closed by a supervisor), the session's `inbound` field cleared and its
   * panel told. The caller then releases the agent as for any wrap-up. A call still offered or
   * connected is `live`: nothing to close, and the agent is not forced off it. `none`: the session
   * owes no inbound outcome (or it was saved first). Throws when the spine cannot be read.
   */
  async closeOwedForSupervisor(sessionId: string): Promise<
    | { kind: 'none' }
    | { kind: 'live'; inboundCallId: string }
    | { kind: 'closed'; call: AgencyInboundCallRecord }
  > {
    const owed = await agencyInboundCallRepository.findUnsettledForSession(sessionId);
    if (!owed) return { kind: 'none' };
    if (owed.state !== 'ended' || owed.bridged_at === null) return { kind: 'live', inboundCallId: owed.id };
    const closed = await withTransaction(async (client) => {
      const row = await agencyInboundCallRepository.lapseOne(owed.id, { client });
      if (row) await settleLapsedContact(row, client);
      return row;
    }, { pool: getPool() });
    if (!closed) {
      // Saved (or swept) a moment ago: whatever settled it is now the session's to return from.
      const again = await agencyInboundCallRepository.findUnsettledForSession(sessionId);
      return again ? { kind: 'live', inboundCallId: again.id } : { kind: 'none' };
    }
    await this.deps.agents.releaseInbound(sessionId, closed.id);
    await this.sendFrame(closed, await this.takerOf(closed)).catch((err: unknown) =>
      log.warn({ err, inboundCallId: closed.id }, 'Could not tell the session its inbound call was closed'));
    log.info({ sessionId, inboundCallId: closed.id }, 'Inbound outcome closed by a supervisor (force-available)');
    return { kind: 'closed', call: closed };
  }
}

/**
 * The matched contact of a reached call whose outcome was just closed with none (the lapse, a
 * supervisor's close), settled as an outcome that moves nothing would settle it
 * (`INBOUND_LAPSE_SETTLEMENT`, SWE-F2): its booked inbound callback cleared (the customer was
 * spoken to, so the campaign must not ring them back for it) and a contact that callback reopened
 * put back to `exhausted`, never dialable again by it. On the transaction that closed the call, so
 * the two commit together. The contact's last disposition is left as it was (nobody recorded one).
 */
async function settleLapsedContact(call: AgencyInboundCallRecord, client: Pick<PoolClient, 'query'>): Promise<void> {
  if (!call.matched_contact_id) return;
  await agencyContactRepository.settleFromInbound({ inboundCallId: call.id, settlement: INBOUND_LAPSE_SETTLEMENT, lastDisposition: null }, { client });
}

/**
 * Mark the caller's number (`fromE164`, the call's own) Do Not Call on the call's scope: the
 * matched campaign's, else the call's account; never tenant-wide. In the caller's transaction.
 * By the MATCH, never `campaign_id` (CL6): a call filed under a campaign by its route or at
 * wrap-up has that campaign only as a filing choice, and its mark covers the whole account.
 * `entry`: the DNC row it landed on, for the audit (null when nothing was written).
 */
async function markCallerDnc(
  row: AgencyInboundCallRecord,
  fromE164: string,
  addedBy: string,
  reason: string | undefined,
  client: PoolClient,
): Promise<{ result: DncMarkResult; entry: InboundDncEntryWritten | null }> {
  const result = await markDnc({
    tenantId: row.tenant_id,
    ...(row.matched_campaign_id ? { campaignId: row.matched_campaign_id } : { accountScope: row.account_id! }),
    phoneE164: fromE164,
    ...(reason !== undefined ? { reason } : {}),
    addedBy,
  }, { client });
  return { result, entry: result.written ? { id: result.written.id, created: !result.alreadyPresent } : null };
}

/**
 * Whether settling inbound call `callId` returns its agent to the pool (SWE-M1): only from a
 * state this call holds them in — `wrapup` (its outcome owed), or `reserved` / `on_call` — with
 * the session's `inbound` field naming this call. Never from `break` (chosen, or the restart's),
 * `offline`, `available`, a state another call or a campaign wrap-up holds, or no lease at all:
 * those agents stay where they are, and their own "Go available" brings them back.
 */
export function returnsToPool(live: Pick<AgentLiveState, 'state' | 'inboundCallId'> | null, callId: string): boolean {
  if (!live || live.inboundCallId !== callId) return false;
  return live.state === 'wrapup' || live.state === 'reserved' || live.state === 'on_call';
}

/**
 * How often the outcome-lapse sweep runs: the auto-return windows are the route's
 * `wrapup_seconds` (IQ52: 30 s by default, at least 10 s), so an agent is returned within a few seconds of the
 * countdown the panel shows. One indexed read of the unsettled bridged calls (a handful).
 */
export const INBOUND_LAPSE_SWEEP_INTERVAL_MS = 5_000;
