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
 * ── The outcome (§2 step 8; Q10, Q11) ────────────────────────────────────────────
 * Only once the call ENDED after it BRIDGED. Against the matched campaign's catalog (whatever its
 * status), else the route's, else the built-in one (`resolveInboundCatalog`). One transaction:
 * the spine row saved and settled (`saveDisposition`, the soft phone's discipline: the same code
 * again is an idempotent replay, notes and callback last-write-wins, nothing settles twice; a
 * different code, or one after the lapse, is `inbound_outcome_already_saved`), then on a first
 * save: a suppress code's DNC mark (campaign scope when matched, else the call's account; never
 * tenant-wide) and the matched campaign's roster rows with the number, and the matched contact
 * settled forward only (`inbound-settlement.ts`). After the commit the session's `inbound` field
 * is cleared (by this id) and the agent returned (`releaseAgent`: a queued break applies, or the
 * release hook offers them the next caller).
 *
 * ── The lapse (§6) ───────────────────────────────────────────────────────────────
 * {@link InboundCallService.sweepLapsed}, every few seconds: a bridged call whose outcome did not
 * come within its window (`inbound-wrapup.ts`: the matched campaign's wrap-up auto-return, else
 * the account default, never past the 30-minute backstop `AGENCY_INBOUND_OUTCOME_LAPSE_MS`), or
 * whose session left, is closed `no_disposition` (`lapseUnsettled`), its field cleared and its
 * agent returned, from the wrap-up it holds them in only ({@link returnsToPool}: an agent on a
 * break stays on it, SWE-M1). A supervisor's force-available closes one the same way
 * ({@link InboundCallService.closeOwedForSupervisor}) and returns the agent.
 */
import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import { inboundScheduleState } from '@magick-agency/domain/inbound-schedule';
import type { AgencyInboundQueueTile } from '@magick-agency/contracts/api/agency/inbound';
import type {
  AgencyContactState,
  AgencyInboundCall,
  AgencyInboundCallDispositionResponse,
  AgencyInboundCallDncResponse,
} from '@magick-agency/contracts/agency';
import {
  agencyAgentSessionRepository,
  agencyCampaignRepository,
  agencyContactRepository,
  agencyInboundCallRepository,
  agencyInboundRouteRepository,
  type AgencyInboundCallRecord,
} from '../../db/repositories/agency.repository.js';
import type { WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';
import type { AgentLiveState, AgentStateMachine } from '../agent-state-machine.js';
import type { StationRegistry } from '../station-registry.js';
import { markDnc } from '../dnc-mark.js';
import { manualDispositionDecision, prepareManualDisposition } from '../softphone/manual-disposition.js';
import type { SoftphoneActor } from '../softphone/types.js';
import { UUID_RE } from '../../utils/uuid.js';
import { inboundCallToWire, loadInboundPanelContext, resolveInboundCatalog } from './inbound-call-wire.js';
import { inboundContactSettlement } from './inbound-settlement.js';
import type { InboundConnector } from './inbound-connector.js';

const log = createChildLogger({ component: 'agency-inbound-calls' });

/** Who is acting: the soft phone's actor (the API layer resolved and vouched for it). */
export type InboundCallActor = SoftphoneActor;

/** What the inbound call operations refuse with (`AgencyInboundErrorCode`, the wire names of each body's fields). */
export type InboundCallRefusal =
  | { code: 'inbound_call_not_found' }
  | { code: 'inbound_call_not_dispositionable' }
  | { code: 'inbound_outcome_already_saved' }
  | {
    code: 'inbound_disposition_invalid';
    reason: 'unknown_code' | 'note_required' | 'datetime_required' | 'invalid_callback_at';
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
  /** The connector, when this process runs one (the hang-up waits for the call's end; the queue tiles). */
  connector: () => Pick<InboundConnector, 'holds' | 'settled' | 'queueSnapshot' | 'eligibleAgents'> | null;
}

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

  /** The panel row of `call`, as the station frames send it. */
  async wire(call: AgencyInboundCallRecord, takerUserId?: string | null): Promise<AgencyInboundCall> {
    const taker = takerUserId === undefined ? await this.takerOf(call) : takerUserId;
    return inboundCallToWire(call, await loadInboundPanelContext(call), taker);
  }

  /** Tell the call's session (its panel follows every change). Never throws. */
  private async sendFrame(call: AgencyInboundCallRecord, takerUserId: string | null): Promise<AgencyInboundCall> {
    const wire = await this.wire(call, takerUserId);
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
   * End the call (`agent_hangup`). Idempotent: a call that already ended answers its row with
   * `hungUp: false` (not audited). Answers the row once this process has written the end.
   */
  async hangup(actor: InboundCallActor, callId: string): Promise<InboundCallResult<{ call: AgencyInboundCall; onBehalf: boolean; hungUp: boolean }>> {
    const found = await this.visible(callId, actor);
    if (!found) return refuse({ code: 'inbound_call_not_found' });
    let hungUp = false;
    const connector = this.deps.connector();
    if (found.call.state !== 'ended' && connector?.holds(found.call.id)) {
      hungUp = await this.deps.bridge.forceEndWithOutcome(found.call.id, 'agent_hangup');
      if (hungUp) {
        // The end is the connector's (its `ended` arm); wait for it so the answer is the ended row.
        for (let i = 0; i < 100 && connector.holds(found.call.id); i++) {
          await connector.settled(found.call.id);
          if (connector.holds(found.call.id)) await new Promise((r) => setTimeout(r, 20));
        }
      }
    }
    const fresh = await agencyInboundCallRepository.findById(actor.tenantId, found.call.id);
    return { ok: true, call: await this.wire(fresh ?? found.call, found.takerUserId), onBehalf: found.onBehalf, hungUp };
  }

  // ─── The outcome ─────────────────────────────────────────────────────────

  async submitDisposition(
    actor: InboundCallActor,
    callId: string,
    req: { code: string; notes?: string; callbackAt?: string },
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

    const [campaign, route, contact] = await Promise.all([
      row.matched_campaign_id ? agencyCampaignRepository.findById(row.matched_campaign_id) : Promise.resolve(null),
      row.route_id ? agencyInboundRouteRepository.findForCall(row.tenant_id, row.route_id) : Promise.resolve(null),
      row.matched_contact_id ? agencyContactRepository.findById(row.matched_contact_id) : Promise.resolve(null),
    ]);
    const tag = campaign && campaign.tenant_id === row.tenant_id ? campaign : null;
    const { catalog, stored } = resolveInboundCatalog(row.matched_campaign_id !== null, tag, route);
    const now = new Date();
    const prepared = prepareManualDisposition({
      catalog, code: req.code, notes: req.notes, callbackAt: req.callbackAt,
      callFields: [], submittedFields: undefined, storedFields: {}, now,
    });
    if (!prepared.ok) {
      const r = prepared.refusal;
      if (r.code === 'disposition_invalid') {
        return refuse({ code: 'inbound_disposition_invalid', reason: r.reason, ...(r.allowed_codes ? { allowed_codes: r.allowed_codes } : {}) });
      }
      // No call fields on an inbound call (Q22): unreachable with none in force.
      return refuse({ code: 'inbound_disposition_invalid', reason: 'unknown_code' });
    }
    const { entry, notes, callbackAt } = prepared.prepared;
    const { decision, nextAttemptAt } = manualDispositionDecision({ entry, now, callbackAt, placed: false, contact, tag });
    const settlement = inboundContactSettlement(entry, decision, nextAttemptAt);

    const client = await getPool().connect();
    let saved: { call: AgencyInboundCallRecord; replay: boolean };
    let dncEntry: InboundDncEntryWritten | null = null;
    let contactState: AgencyContactState | null = contact?.state ?? null;
    let nextAt: Date | null = null;
    try {
      await client.query('BEGIN');
      const result = await agencyInboundCallRepository.saveDisposition({
        id: row.id, code: entry.code, source: stored, notes, callbackAt,
        actorUserId: actor.userId, onBehalf: found.onBehalf,
      }, { client });
      if (!result.ok) {
        await client.query('ROLLBACK');
        if (result.reason === 'not_found') return refuse({ code: 'inbound_call_not_found' });
        if (result.reason === 'live' || result.reason === 'not_bridged') return refuse({ code: 'inbound_call_not_dispositionable' });
        return refuse({ code: 'inbound_outcome_already_saved' });
      }
      if (!result.replay) {
        if (entry.suppress === true && row.from_e164) {
          const marked = await markDnc({
            tenantId: row.tenant_id,
            ...(row.matched_campaign_id ? { campaignId: row.matched_campaign_id } : { accountScope: row.account_id! }),
            phoneE164: row.from_e164,
            reason: `disposition:${entry.code}`,
            addedBy: actor.userId,
          }, { client });
          if (marked.written) dncEntry = { id: marked.written.id, created: !marked.alreadyPresent };
        }
        const settled = await agencyContactRepository.settleFromInbound({
          inboundCallId: row.id, settlement, lastDisposition: entry.code,
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
      }
      await client.query('COMMIT');
      saved = { call: result.call, replay: result.replay };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (!saved.replay) await this.returnAgent(saved.call);
    const call = await this.sendFrame(saved.call, found.takerUserId);
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
    let recorded: Awaited<ReturnType<typeof markDnc>> | null = null;
    if (row.from_e164) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        if (row.matched_campaign_id) {
          await agencyContactRepository.suppressByPhone(
            row.matched_campaign_id, row.from_e164, 'dnc',
            row.matched_contact_id ? { alwaysContactId: row.matched_contact_id } : {},
            { client },
          );
        }
        recorded = await markDnc({
          tenantId: row.tenant_id,
          ...(row.matched_campaign_id ? { campaignId: row.matched_campaign_id } : { accountScope: row.account_id! }),
          phoneE164: row.from_e164,
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
    }
    const contact = row.matched_contact_id ? await agencyContactRepository.findById(row.matched_contact_id).catch(() => null) : null;
    return {
      ok: true,
      onBehalf: found.onBehalf,
      dncEntry: recorded?.written ? { id: recorded.written.id, created: !recorded.alreadyPresent } : null,
      response: {
        call_id: row.id,
        phone_e164: recorded?.phoneE164 ?? row.from_e164 ?? '',
        scope,
        dnc_recorded: recorded?.recorded ?? false,
        contact_state: contact?.state ?? null,
      },
    };
  }

  // ─── The supervisor's queue tiles ────────────────────────────────────────

  /**
   * One tile per live route of the account, by route name (docs/inbound.md §6): open now by its
   * hours, the callers waiting and the longest wait, the calls with an agent (on offer or
   * connected) and the agents who could take the next caller now. The queue is the connector's,
   * in memory (one process, IB8): with no connector every count is 0.
   */
  async queueTiles(tenantId: string, accountId: string, now: Date = new Date()): Promise<AgencyInboundQueueTile[]> {
    const connector = this.deps.connector();
    const snapshot = new Map((connector?.queueSnapshot() ?? []).map((s) => [s.routeId, s]));
    const routes = await agencyInboundRouteRepository.listForAccount(tenantId, accountId);
    const tiles = await Promise.all(routes.map(async (route): Promise<AgencyInboundQueueTile> => {
      const s = snapshot.get(route.id);
      return {
        route_id: route.id,
        route_name: route.name,
        open_now: inboundScheduleState(route, now) === 'open',
        waiting: s?.waiting ?? 0,
        longest_wait_seconds: s?.longestWaitSeconds ?? 0,
        connected: (s?.offered ?? 0) + (s?.connected ?? 0),
        eligible_agents: connector ? await connector.eligibleAgents(tenantId, accountId, route.pool_campaign_ids) : 0,
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
      const rows = await agencyInboundCallRepository.lapseUnsettled({ limit: batch });
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
    const closed = await agencyInboundCallRepository.lapseOne(owed.id);
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
 * How often the outcome-lapse sweep runs: the auto-return windows are a campaign's
 * `wrapup_seconds` (30 s by default), so an agent is returned within a few seconds of the
 * countdown the panel shows. One indexed read of the unsettled bridged calls (a handful).
 */
export const INBOUND_LAPSE_SWEEP_INTERVAL_MS = 5_000;
