/*
 * The agent session handlers: join, station token, available, force-available, break,
 * break cancel and leave. Part of `agency.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getTenantId, getAccountId } from '../../middleware/auth.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { agencyAgentSessionRepository, agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { AGENT_LEASE_MS } from '../../../agency/agent-state-machine.js';
import { owedSoftphoneCall, setAvailableGuarded } from '../../../agency/softphone/session-guard.js';
import { validateBreakReason, breakMustWait, resolveBreakReasons } from '@magick-agency/domain/break-manager';
import type {
  AgencyActionErrorResponse,
  AgencyAgentState,
  AgencyCreateSessionRequest,
  AgencyManualCall,
  AgencySessionBootstrap,
  AgencySessionCampaignConflict,
  AgencySessionStateResponse,
  AgencySoftphoneCallPendingRefusal,
  AgencySoftphoneErrorResponse,
  AgencySoftphoneSessionOnSoftphoneRefusal,
  AgencyStationTokenResponse,
} from '@magick-agency/contracts/agency';
import { isCampaignSession } from '../../../db/models/agency.model.js';
import { requireOwnedSession, resolveRetryContext, STATION_INTERVALS } from './helpers.js';

const log = createChildLogger({ component: 'agency-routes' });

/**
 * Registered by `agencyRoutes` inside its authenticated scope (`sub`, the one carrying
 * `authMiddleware`), so every route here runs behind it.
 */
export async function registerSessionRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── POST /sessions — join a campaign, get everything the console needs ──
  sub.post('/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    // Typed against the contract, not restated inline. An inline shape can
    // require a field (`agent_user_id`) the contract never mentions; the caller
    // builds to the contract, Zod drops the field, and every join 400s. A field
    // added to the interface is a compile error here rather than a silent
    // divergence.
    const body = request.body as Partial<AgencyCreateSessionRequest> | undefined;

    if (!(await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, { tenantId, accountId }))) {
      return reply.code(403).send({ error: 'Feature Not Enabled', message: 'Agency dialer is not enabled for this account.' });
    }
    if (!body?.campaign_id || !body.agent_user_id) {
      return reply.code(400).send({ error: 'Validation failed', message: 'campaign_id and agent_user_id are required' });
    }

    const campaign = await agencyCampaignRepository.findById(body.campaign_id);
    if (!campaign || campaign.tenant_id !== tenantId || campaign.account_id !== accountId) {
      return reply.code(404).send({ error: 'Not Found', message: 'Campaign not found' });
    }

    const join = await agencyAgentSessionRepository.joinOrRehydrate({
      tenantId, accountId,
      campaignId: campaign.id,
      agentUserId: body.agent_user_id,
      replicaId: runtime.replicaId,
    });

    // One live session per agent per TENANT. The agent is
    // still joined somewhere else and must leave that station first — nothing
    // here yanks them off it, because that station may be a live conversation
    // (see `AgencySessionCampaignConflict` for the full
    // reasoning). Refused with the old campaign NAMED: an agent who is told
    // only "conflict" has no way to find the station they left open.
    if (!join.ok) {
      // The agent's live session is a soft-phone session (docs/softphone.md): there
      // is no campaign to name in `session_on_other_campaign`, so it gets its own
      // 409, whose remedy is leaving the soft phone.
      const liveSession = join.session;
      if (!isCampaignSession(liveSession)) {
        const refusal: AgencySoftphoneSessionOnSoftphoneRefusal = {
          error: 'Conflict',
          code: 'session_on_softphone',
          message: 'You are on the soft phone. Leave the soft phone before joining a campaign — an agent can hold only one live station at a time.',
          session_id: liveSession.id,
        };
        return reply.code(409).send(refusal);
      }
      // `.catch` because this lookup exists ONLY to make the refusal readable.
      // Letting it reject would convert a 409 the agent can act on into a 500
      // they cannot — and `campaign_id` below already carries everything the
      // console needs to route them.
      const other = await agencyCampaignRepository.findById(liveSession.campaign_id)
        .catch((err) => {
          log.warn({ err, campaignId: liveSession.campaign_id }, 'Could not resolve conflicting campaign name');
          return null;
        });
      // Redis, not the row — the row is a durable mirror and this field is what
      // the console uses to decide whether leaving that station is safe right
      // now. Falling back to the row rather than failing when there is no
      // key: no key means no lease, so nothing is in flight and the mirror is
      // then the closest truthful reading. A 500 here would hide a conflict the
      // agent can actually resolve behind one they cannot.
      const live = await runtime.agents.get(liveSession.id);
      // ── Scoped to the TENANT, and deliberately not to the account ─────────
      // `findById` is unscoped, so the name has to be checked against something
      // here. The right scope is the constraint's scope: this session is the
      // agent's own live session, the index that refused the join spans the
      // tenant, and the conflicting campaign will OFTEN be in another account of
      // it — that cross-account case is the whole reason the index is not
      // account-scoped. Filtering on the request's account would blank the name
      // in precisely the case the agent most needs it named. A campaign from
      // another TENANT, though, could only be a corrupt row or a repurposed id,
      // and naming it would leak across the tenant boundary the dialer scopes
      // everything on.
      //
      // The `?? ` fallback is otherwise unreachable — `campaign_id` is
      // `ON DELETE CASCADE`, so a live session outlives its campaign never — and
      // is here because a TypeError on the error path would turn an actionable
      // 409 into an opaque 500.
      const otherName = other && other.tenant_id === liveSession.tenant_id
        ? other.name
        : 'another campaign';
      const conflict: AgencySessionCampaignConflict = {
        error: 'Conflict',
        code: 'session_on_other_campaign',
        // Written to stand ON ITS OWN, naming the campaign and the remedy,
        // because it is the FLOOR of what the agent sees rather than the copy
        // anyone hopes they get: a body whose only explanation lived in the
        // structured fields would reach a client that ignores them as no
        // explanation at all. The console composes richer copy from
        // `campaign_name`/`state`; nothing depends on it doing so.
        message:
          `You are still joined to "${otherName}". ` +
          `Leave that station before joining another campaign — an agent can hold only one live station at a time.`,
        campaign_id: liveSession.campaign_id,
        campaign_name: otherName,
        state: live?.state ?? liveSession.state,
      };
      log.warn({
        agentUserId: body.agent_user_id, requestedCampaignId: campaign.id,
        liveCampaignId: liveSession.campaign_id, state: conflict.state,
      }, 'Agency join refused — agent already live on another campaign');
      return reply.code(409).send(conflict);
    }

    const session = join.session;

    // The upsert's `DO UPDATE … WHERE campaign_id = EXCLUDED.campaign_id` makes
    // this unreachable, and it is asserted anyway because the failure it guards
    // is silent and expensive: a bootstrap that echoes the REQUESTED campaign
    // while the row points at another gives the console one campaign's
    // disposition catalog, break reasons and context display while every
    // reservation, attempt and stat lands on a different campaign. The agent
    // would be dispositioning calls with codes that do not belong to them.
    // Fail loudly instead — a 500 the agent can retry beats a session that
    // looks correct.
    if (session.campaign_id !== campaign.id) {
      log.error({
        sessionId: session.id, requestedCampaignId: campaign.id, rowCampaignId: session.campaign_id,
      }, 'Agency session campaign mismatch — refusing to bootstrap');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Session campaign mismatch — please retry.',
      });
    }

    // Redis, or `break` — the same rule as the station socket, and for the same
    // reason. Seeding Redis from `session.state` would be wrong: `joinOrRehydrate`
    // preserves it whenever it is not `offline`, so an agent re-bootstrapping
    // after a page reload, mid-call, would have `available` written over their
    // live `on_call` lease and the next tick would reserve them for a second
    // call. Nothing may derive availability from the durable mirror.
    const state = await runtime.rehydrateAgent(session.id, session);

    const minted = await runtime.tokens.mint(session.id);

    // Campaign-CONSTANT, which is why it belongs on this payload and not on the
    // `reserved` frame: putting it there would repeat it once per dial for the
    // whole shift, on the one frame whose latency the design guards hardest.
    // Resolved here rather than in the object literal below so its `await` is
    // plainly outside the frame path.
    const retryContext = await resolveRetryContext(campaign);

    const bootstrap: AgencySessionBootstrap = {
      session_id: session.id,
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      agent_user_id: session.agent_user_id,
      // The rehydrated state, not the row's — a bootstrap that advertised
      // `available` while Redis held `on_call` would have the console render a
      // ready agent over a live conversation.
      state,
      campaign_status: campaign.status,
      station_ws_url: `/api/v1/agency/station/${session.id}?token=${minted.token}`,
      station_token_expires_at: minted.expiresAt.toISOString(),
      disposition_catalog: campaign.disposition_catalog ?? [],
      wrapup_seconds: campaign.wrapup_seconds,
      wrapup_auto_return: campaign.wrapup_auto_return,
      record_calls: campaign.record_calls,
      break_reasons: resolveBreakReasons(campaign.break_reasons),
      context_display: campaign.context_display ?? {},
      intervals: STATION_INTERVALS,
      // Spread rather than always present: the field is optional on the
      // contract and absent for every non-retry campaign, so an older console
      // that has never seen it gets a byte-identical payload.
      ...(retryContext ? { retry_context: retryContext } : {}),
    };
    return reply.code(201).send(bootstrap);
  });

  // ── POST /sessions/:id/station-token — cheap re-mint for a reconnect ────
  // Deliberately NOT the fat bootstrap: a wifi blip needs a new upgrade
  // credential, not the campaign's whole configuration again.
  sub.post('/sessions/:id/station-token', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    // The `left_at` → `409 session_ended` check lives in `requireOwnedSession`,
    // so every session route refuses a session that has already left, not just
    // this one.
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    const minted = await runtime.tokens.mint(session.id);
    const body: AgencyStationTokenResponse = {
      session_id: session.id,
      station_ws_url: `/api/v1/agency/station/${session.id}?token=${minted.token}`,
      expires_at: minted.expiresAt.toISOString(),
    };
    return reply.send(body);
  });

  // ── POST /sessions/:id/available — the one click that opens the pool ────
  sub.post('/sessions/:id/available', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    // A soft-phone session can never be `available` (docs/softphone.md §2, §6).
    if (!isCampaignSession(session)) {
      const err: AgencySoftphoneErrorResponse = {
        error: 'Conflict', code: 'wrong_session_kind',
        message: 'This is a soft-phone session; it has no campaign to go available on.',
      };
      return reply.code(409).send(err);
    }
    // Only an agent whose socket is actually attached may go available — the
    // whole point of the break-on-return rule (an agent with no live lease comes
    // back on `break`, never `available`; see `rehydrateAgent`).
    //
    // ── KNOWN LIMIT: this is replica-local, and stays that way for now ──────
    //
    // `isLocallyOwned` answers "do *I* hold this socket", and this guard uses it
    // as "does a socket exist". Those coincide only on a single replica: behind a
    // load balancer the station socket pins to whichever replica accepted the
    // upgrade while this POST is routed independently, so an agent whose console
    // is connected and pinging normally would be told to open the station they
    // already have. That is a large part of the "run one replica" deploy
    // constraint on the agency dialer.
    //
    // `StationRegistry.stationPresence` is the cross-replica answer and is
    // implemented and tested — but it is deliberately NOT wired in here, and
    // wiring it in is not the remedy on its own. Doing so removes the incidental
    // protection this local check gives every replica-local guard BELOW it: on a
    // non-owning replica it 409s first, so nothing downstream runs there. Let the
    // gate pass instead and `runtime.wrapup.stateFor` — an in-process Map — starts
    // returning null on that replica, so the `attempt_not_dispositionable`
    // refusal silently does not fire and the reaper stamps `no_disposition` over
    // the record of what was said to a customer. `wrapup.cancel` no-ops and leaves
    // the owning replica's timer armed; `stations.send` drops the state frame
    // while `agents.set` is globally visible. `/leave`'s `hasLiveAttempt` fails
    // open the same way, letting an `on_call` agent leave and be bridged a second
    // customer.
    //
    // So scaling out needs wrap-up, breaks and the live-attempt set made
    // cross-replica, plus the `PubSubDialDispatcher` the `DialDispatcher` seam
    // exists for. Until then a spurious 409 is the safe failure and this line is
    // the right one: an agent retries in a second, where the alternative loses a
    // compliance record silently.
    if (!runtime.stations.isLocallyOwned(session.id)) {
      const err: AgencyActionErrorResponse = {
        error: 'No Station', code: 'no_station',
        message: 'Open the station socket before going available.',
      };
      return reply.code(409).send(err);
    }

    // An agent in wrap-up with a disposition outstanding may NOT walk out of it
    // through this route. Collapsing "I'm ready" and "I'm done writing up" into
    // one control would let an agent skip every disposition by clicking
    // Available — and the disposition is the record of what was said to a
    // customer, not a formality. The supervisor override is a separate route.
    const wrapup = runtime.wrapup.stateFor(session.id);
    if (wrapup && wrapup.requires_disposition && !wrapup.disposition_submitted) {
      const err: AgencyActionErrorResponse = {
        error: 'Disposition Required', code: 'attempt_not_dispositionable',
        message: 'Submit a disposition for your last call before going available.',
      };
      return reply.code(409).send(err);
    }
    // ── …and neither may an agent with a dial ringing they cannot see ──────
    //
    // `agents.set` is an unconditional Redis write, not a CAS. Under late
    // binding the console shows an idle station for the whole ring — that is the
    // entire point of the flag — so Available is a control the agent is
    // perfectly entitled to press while an unbound dial is in flight, and a
    // reconnect that paints "Ringing — get ready" from `ready.state` actively
    // invites it.
    //
    // One click did three things: it overwrote the `reserved` lease
    // `executeDial` is renewing (the renewer is state-matched, so it then fails
    // and stops itself), it let the next pacing tick reserve the same agent for
    // a SECOND contact, and it left the first customer to answer into an agent
    // who is now on another call — or into `abandonAnsweredCall`, against the 3%
    // ceiling. `/leave` has this guard because the agent can see no call; this
    // route needs it for exactly the same reason.
    //
    // Scoped to UNANNOUNCED attempts. An agent who can see their call is making
    // an informed choice, and the wrap-up gate above already covers the case
    // that matters there. (A live *announced* attempt is arguably also worth
    // refusing — `on_call` has the same unconditional-write problem — but that
    // is a known open gap on a path late binding does not change, so it is left
    // as it is here.)
    //
    // Same `agent_on_live_call` code as `/leave`, and for the same reason: a new
    // `AgencyActionErrorCode` has to be added to the contract union, its
    // `AGENCY_ACTION_ERROR_CODES` lists and the console's copy, and a wording
    // variant does not earn that.
    if (runtime.dialer.hasUnannouncedAttempt(session.id)) {
      const err: AgencyActionErrorResponse = {
        error: 'Conflict', code: 'agent_on_live_call',
        message: 'A call is being placed for you — this can take up to a minute. You are already in the pool for it.',
      };
      return reply.code(409).send(err);
    }

    // Any wrap-up that IS allowed to end ends here rather than being orphaned
    // with a live timer that would later return an agent who is already back.
    //
    // `agent_returned`, not `disposition_submitted`: submitting a disposition
    // resolves the wrap-up on its own path, so reaching here means none was
    // submitted and none was required — the agent simply finished early. The
    // distinction is load-bearing for the average wrap-up statistic, which these
    // fastest wrap-ups would otherwise be missing from entirely.
    runtime.wrapup.cancel(session.id, 'agent_returned');

    // Refused, atomically in the same Lua write, while the session holds a soft-phone
    // call — live or awaiting its outcome (docs/softphone.md §4.1 step 1, §6).
    // `unavailable` (Redis did not answer) keeps this route's behaviour from before
    // the guard: the write was logged and the mirror written; the lease is the
    // authority and pacing reads Redis, which then holds no `available`.
    const set = await setAvailableGuarded(runtime.agents, session.id);
    if (!set.ok && set.refusal.code !== 'unavailable') {
      if (set.refusal.code === 'manual_call_live') {
        const err: AgencySoftphoneCallPendingRefusal = {
          error: 'Conflict', code: 'manual_call_live', call: set.refusal.call,
          message: 'Save the outcome of your soft-phone call before going available.',
        };
        return reply.code(409).send(err);
      }
      const err: AgencySoftphoneErrorResponse = {
        error: 'Conflict', code: 'wrong_session_kind',
        message: 'This is a soft-phone session; it has no campaign to go available on.',
      };
      return reply.code(409).send(err);
    }
    await agencyAgentSessionRepository.setState(session.id, 'available');
    runtime.stations.send(session.id, { event: 'agent_state', state: 'available', since: new Date().toISOString() });
    return reply.send({ session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'available', since: new Date().toISOString() });
  });

  // ── POST /sessions/:id/force-available — supervisor override ────────────
  // Deliberately NOT the agent's own control. The public API layer gates this at
  // `agency.supervise` (account_admin floor), which the `agent` role, the lowest
  // in the hierarchy, never reaches — so the route that can skip a disposition is
  // one the person who would benefit from skipping it cannot call.
  sub.post('/sessions/:id/force-available', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    // Q8 (Manas, 2026-10-09): the one session route a supervisor may drive for another
    // agent (`on_behalf`, which the public API layer sets only for `agency.supervise`,
    // this route's floor).
    const session = await requireOwnedSession(request, reply, { supervisorMayAct: true });
    if (!session) return reply;
    // A soft-phone session has no campaign pool to return the agent to, and can never
    // be `available` (docs/softphone.md §2, §6).
    if (!isCampaignSession(session)) {
      const err: AgencySoftphoneErrorResponse = {
        error: 'Conflict', code: 'wrong_session_kind',
        message: 'This is a soft-phone session; it has no campaign to make the agent available on.',
      };
      return reply.code(409).send(err);
    }
    // A campaign session on the soft phone owing an outcome stays out of the pool:
    // the supervisor is told so with the call (docs/softphone.md §4.1 step 1, §6),
    // read from the database first as `available` does, and again when the release's
    // own Lua guard refused (a dial that committed in between).
    const manualCallLive = (call: AgencyManualCall) => {
      const err: AgencySoftphoneCallPendingRefusal = {
        error: 'Conflict', code: 'manual_call_live', call,
        message: 'The agent has a soft-phone call open: its outcome must be saved before they can go available.',
      };
      return reply.code(409).send(err);
    };
    const forced = await runtime.wrapup.force(session.id);
    let state: AgencyAgentState;
    if (forced) {
      // The forced wrap-up already released the agent (a queued break applies there).
      state = (await runtime.agents.get(session.id))?.state ?? 'offline';
    } else {
      const owed = await owedSoftphoneCall(runtime.agents, session.id);
      if (owed) return manualCallLive(owed);
      // Not in wrap-up — fall through to a plain return rather than 409ing. A
      // supervisor pressing this on an agent who just finished should not get an
      // error for winning a race by half a second.
      const released = await runtime.dialer.releaseAgent(session.id);
      if (released.result === 'manual_call_live' || released.result === 'softphone_session') {
        const call = await owedSoftphoneCall(runtime.agents, session.id);
        if (call) return manualCallLive(call);
        const err: AgencySoftphoneErrorResponse = {
          error: 'Conflict', code: 'wrong_session_kind',
          message: 'This session is on the soft phone; it cannot be made available.',
        };
        return reply.code(409).send(err);
      }
      // What was written: `break` for a queued break, `offline` when the station is gone.
      state = released.state;
    }
    return reply.send({ session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state, since: new Date().toISOString() });
  });

  // ── POST /sessions/:id/break ───────────────────────────────────────────
  // `* → break`, with a reason code, QUEUED when the agent is mid-call and
  // applied at the end of wrap-up. Never mid-conversation.
  sub.post('/sessions/:id/break', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    // A soft-phone session has no campaign and so no break catalog; it is always on
    // the reserved `soft_phone` break (docs/softphone.md §6).
    if (!isCampaignSession(session)) {
      const err: AgencySoftphoneErrorResponse = {
        error: 'Conflict', code: 'wrong_session_kind',
        message: 'This is a soft-phone session; it has no campaign breaks.',
      };
      return reply.code(409).send(err);
    }
    const campaign = await agencyCampaignRepository.findById(session.campaign_id);
    if (!campaign) {
      return reply.code(404).send({ error: 'Not Found', message: 'Campaign not found' });
    }

    const body = request.body as { reason?: unknown } | undefined;
    const check = validateBreakReason(campaign.break_reasons, body?.reason);
    if (!check.ok) {
      // Echo the valid set: a console holding a stale catalog then recovers in one
      // round trip instead of stranding an agent who cannot go on break mid-shift.
      const err: AgencyActionErrorResponse = {
        error: 'Validation failed',
        code: 'unknown_break_reason',
        message: `Unknown break reason. Valid codes: ${check.allowed.join(', ')}`,
        allowed_codes: check.allowed,
      };
      return reply.code(400).send(err);
    }

    const live = await runtime.agents.get(session.id);
    const since = new Date().toISOString();

    // Redis is the authority on the agent's state, not the DB row — the same rule
    // the pacing tick follows. A DB row reading `available` for an agent who is
    // actually bridged would apply a break mid-conversation.
    if (breakMustWait(live?.state)) {
      runtime.breaks.queue(session.id, check.reason);
      // Echoed on the frame too, not just this response: the queue outlives the
      // request, so an agent who reconnects must still be told a break is pending.
      //
      // ── …except while the deferring call is one the agent has never seen ────
      //
      // Under late binding an unbound dial holds the agent at `reserved` for the
      // whole ring, and `breakMustWait` defers on `reserved`. Echoing that state
      // would put `state: 'reserved'` on the wire for a call the agent was never
      // told about — which `StateRail` renders as the warning-toned banner
      // "Ringing — get ready", instructing them to expect a call that two times
      // in three never arrives. That is precisely the frame
      // `FF_AGENCY_LATE_BINDING` exists to remove, re-entered through a control
      // the agent pressed themselves.
      //
      // So the frame is SUPPRESSED rather than softened. Reporting `available`
      // instead was considered and rejected: `state` is authoritative by
      // contract ("the console must not infer state",
      // {@link AgencyStationAgentStateFrame}), so a state we know to be false is
      // worse than no frame. Nothing is lost by staying quiet — the pending
      // break still reaches the agent by both of its other paths: this HTTP
      // response carries `pending_state`/`break_reason` (the only fields the
      // console's `requestBreak` reads), and a socket that reconnects mid-ring
      // learns it from `ready.pending_state`. When the dial resolves,
      // `releaseAgent` sends the authoritative `agent_state` that applies the
      // queued break — the one frame deliberately left unsuppressed, for exactly
      // this case.
      if (!runtime.dialer.hasUnannouncedAttempt(session.id)) {
        runtime.stations.send(session.id, {
          event: 'agent_state',
          state: live!.state,
          since,
          pending_state: 'break',
          pending_break_reason: check.reason.code,
        });
      }
      const queued: AgencySessionStateResponse = {
        session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: live!.state, since,
        pending_state: 'break', break_reason: check.reason.code,
      };
      return reply.send(queued);
    }

    await runtime.agents.set(session.id, 'break', { leaseMs: AGENT_LEASE_MS.break });
    await agencyAgentSessionRepository.setState(session.id, 'break', check.reason.code);
    runtime.stations.send(session.id, {
      event: 'agent_state', state: 'break', since, break_reason: check.reason.code,
    });
    const applied: AgencySessionStateResponse = {
      session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'break', since, break_reason: check.reason.code,
    };
    return reply.send(applied);
  });

  // ── POST /sessions/:id/break/cancel ────────────────────────────────────
  // Take back a break that has not landed yet. Without this the window between
  // requesting one mid-call and it applying at wrap-up end is un-undoable:
  // `/available` acts on the current state and leaves the queue untouched, so the
  // break would still arrive the moment wrap-up ended.
  sub.post('/sessions/:id/break/cancel', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    // A soft-phone session's only break is the reserved `soft_phone` one it was opened
    // in, and nothing is ever queued on it (docs/softphone.md §6). A CAMPAIGN session's
    // queued switch to the soft phone is an ordinary queued break (`breaks.queue` with
    // `soft_phone`, `SoftphoneService.switchToSoftphone`), and cancelling it here is the
    // console's ✕ on the queued-switch pill: it falls through to the cancel below.
    if (!isCampaignSession(session)) {
      const err: AgencySoftphoneErrorResponse = {
        error: 'Conflict', code: 'wrong_session_kind',
        message: 'This is a soft-phone session; it has no campaign break to cancel. Close the soft phone instead.',
      };
      return reply.code(409).send(err);
    }

    const cancelled = runtime.breaks.cancel(session.id);
    const live = await runtime.agents.get(session.id);
    const since = new Date().toISOString();

    if (!cancelled && live?.state === 'break') {
      // 409 rather than a silent no-op. An agent who presses "cancel break" and is
      // left on break has been told nothing, and the console can now offer the
      // control that would actually work.
      const err: AgencyActionErrorResponse = {
        error: 'Break Already Started', code: 'break_already_applied',
        message: 'Your break has already started. Go available when you are ready.',
      };
      return reply.code(409).send(err);
    }

    if (cancelled) {
      // Suppressed for an unannounced dial, symmetrically with the queue route
      // above — see the long note there. This frame exists to confirm the cancel
      // landed, and confirming it with `state: 'reserved'` hands the agent the
      // "Ringing — get ready" banner for a call they were never shown: the queue
      // route declines to leak it and this one would hand it straight back,
      // through a control the agent pressed themselves.
      //
      // ⚠️ This frame does more work than the queue route's, so the suppression
      // costs something and the cost is stated rather than glossed. The console
      // applies `stateBreakQueue(frame.pending_state, …)` UNCONDITIONALLY, and this
      // frame's *omission* of the pending fields is what takes the queued-break
      // pill down — an `if (frame.pending_state)` on the client would strand it
      // forever, which its own comment says at length. Withholding the frame is
      // therefore withholding a clearing signal, not just a state.
      //
      // Two other paths still deliver it, which is why this is acceptable: the
      // response body below lands first and is what clears the pill for the
      // window that clicked ("the HTTP response wins the instant after a click;
      // the frames then confirm or correct it"), and `ready` restates the — now
      // empty — queue on any reconnect. What is genuinely lost is a SECOND
      // concurrently-open console for the same agent, which will keep showing a
      // stale pill until its next transition or reconnect.
      //
      // That trade is worth making: a stale pill in a duplicate window is a
      // smaller harm than handing the agent who just cancelled a break the
      // "Ringing — get ready" banner for a call they were never shown. It would
      // stop being the right trade if `state` ever became optional on this frame,
      // which is still an open contract question.
      if (!runtime.dialer.hasUnannouncedAttempt(session.id)) {
        runtime.stations.send(session.id, {
          event: 'agent_state', state: live?.state ?? session.state, since,
        });
      }
    }
    // Nothing queued and not on break ⇒ idempotent success (double-click safety).
    const body: AgencySessionStateResponse = {
      session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: live?.state ?? session.state, since,
    };
    return reply.send(body);
  });

  // ── POST /sessions/:id/leave ───────────────────────────────────────────
  //
  // ── Why this refuses mid-attempt, and why that is not a UI concern ───────
  //
  // Leaving clears the Redis lease, sets `left_at` and detaches the station.
  // With no guard, an `on_call` agent could leave and immediately join campaign
  // B — the row is left, so the upsert INSERTS rather than conflicting — and be
  // reserved and bridged while campaign A's attempt is still live on the wire.
  // That is the exact double-bridge `uq_agency_agent_live_tenant` exists to make unreachable,
  // one click away instead of free, and the DB constraint cannot see it: both
  // rows satisfy the index because the first one left.
  //
  // `releaseStationOnClose` in `runtime.ts` has held precisely this guard for
  // the socket-close path all along, on the same reasoning. A deliberate leave
  // is the same event with an intention attached, so it gets the same rule. The
  // console is specified to disable Leave station during
  // `reserved`/`on_call`/`wrapup`, but that is a courtesy to the agent — this is
  // the enforcement, and it has to be here because a disabled button is not a
  // guarantee about what reaches the route.
  //
  // Deliberately NOT hanging the call up on the agent's behalf: ending a live
  // conversation is `POST /attempts/:id/hangup`, an explicit act with its own
  // ownership rule. A leave that silently dropped a customer would be a worse
  // outcome than the refusal.
  sub.post('/sessions/:id/leave', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;

    // The dialer's own live set, not the Redis state or the row: it is written
    // before the dial is placed and cleared only when the attempt settles, so it
    // covers `dialing` through `bridged` AND the deferred-hangup window — during
    // which the socket is already gone and every other signal reads idle.
    // A live soft-phone call is the same refusal: the station socket is its media
    // leg (docs/softphone.md §4.1). One awaiting its outcome does not hold the
    // leave; the lapse sweep closes a call whose session left.
    if (runtime.softphone.hasLiveCall(session.id) && !runtime.dialer.hasLiveAttempt(session.id)) {
      const err: AgencyActionErrorResponse = {
        error: 'Conflict', code: 'agent_on_live_call',
        message: 'Hang up your soft-phone call before leaving the station.',
      };
      return reply.code(409).send(err);
    }
    if (runtime.dialer.hasLiveAttempt(session.id)) {
      // ── Under late binding the agent can see NO call, so the message had to
      //    change — and only the message (`FF_AGENCY_LATE_BINDING`) ───────────
      //
      // An unbound dial is in flight: the customer's phone is ringing and the
      // agent's console shows an idle station, because the whole point of late
      // binding is that they are not shown a ringing call. "Finish or hang up
      // your current call" is then a statement about their screen that is
      // false, and the only action it suggests — hang up — is one they have no
      // affordance for. So it names what is actually happening and what to wait
      // for.
      //
      // **The refusal itself stays**, and that is a trade-off rather than an
      // oversight. Allowing the leave would clear the Redis lease and detach the
      // station, so when the carrier answers a moment later the `answered` arm
      // finds no socket and MANUFACTURES an abandoned call — a real customer
      // greeted by an apology clip, counted against the 3% ceiling, produced by
      // a button press. The alternative we did not take is to cancel the dial
      // and then allow the leave; that is the right shape and it is blocked on
      // the carrier, because `ProviderCapabilities.cancelRinging` is false for
      // VoiceLink (its `endCall` is a documented no-op) — which is exactly the
      // cohort late binding ships to first. Cancelling there would return 200,
      // detach the agent, and leave the phone ringing anyway.
      //
      // The wait is bounded, but NOT by anything an operator can tune, and not
      // by "the campaign's ring timeout" — there is no such setting.
      // `ringTimeoutSeconds` exists on `TelephonyProvider` and is honoured by
      // the plivo and vobiz adapters, but it is populated from a DID's
      // `ring_timeout_seconds` on the inbound/IVR path; `agency_campaigns` has
      // no such column and the agency dial path passes none. On VoiceLink
      // specifically the dial request takes no ring-timeout parameter at all.
      //
      // What actually bounds it is the carrier's own terminal-state report —
      // 45-75s on VoiceLink, which is why `CARRIER_END_CONFIRM_TIMEOUT_SECONDS`
      // is 45 (see the note on it in `webrtc-bridge-manager.ts`). So the honest
      // ceiling is about a minute, and the message says so rather than implying
      // a knob exists.
      //
      // The code stays `agent_on_live_call` deliberately. A new
      // `AgencyActionErrorCode` member has to be added to the contract union, its
      // `AGENCY_ACTION_ERROR_CODES` lists and the console's copy, and a wording
      // variant does not earn that.
      const err: AgencyActionErrorResponse = {
        error: 'Conflict', code: 'agent_on_live_call',
        message: runtime.dialer.hasUnannouncedAttempt(session.id)
          ? 'A call is being placed for you — this can take up to a minute. You can leave as soon as it connects or stops ringing.'
          : 'Finish or hang up your current call before leaving the station.',
      };
      return reply.code(409).send(err);
    }

    await runtime.agents.clear(session.id);
    await agencyAgentSessionRepository.leave(session.id);
    await runtime.stations.detach(session.id);
    return reply.send({ session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'offline', since: new Date().toISOString() });
  });
}
