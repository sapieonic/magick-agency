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
import { onSoftphoneBreak, owedInboundCallId, owedSoftphoneCall, setAvailableGuarded } from '../../../agency/softphone/session-guard.js';
import type { AgencyInboundCallLiveRefusal } from '@magick-agency/contracts/api/agency/inbound';
import { validateBreakReason, breakMustWait, resolveBreakReasons } from '@magick-agency/domain/break-manager';
import { SOFTPHONE_BREAK_REASON } from '@magick-agency/contracts/agency';
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
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import {
  accountNameInTenant, claimStationOrReply, joinEndingIdleElsewhere, mintStationTokenOr503, refuseIfHeldElsewhere,
  leaveSession, requireOwnedSession, resolveRetryContext, sendActionError, sendSessionInOtherTenant, stationDeviceFields,
  stationIntervalsFor,
} from './helpers.js';
import { SOFTPHONE_SESSION_AUDIT_KEY, type SoftphoneSessionExitAudit } from './softphone-answer.js';
import { INBOUND_CLOSE_AUDIT_KEY, type InboundCloseAudit } from './inbound-close-audit.js';
import { isAppPauseBreakReason, runDeviceAway } from './device-away.js';
import { breakReasonFor } from '../../../agency/station-socket.js';
import { readAgentQueueState } from '../../../agency/pacing/agent-queue.js';

/**
 * `/available`, force-available and `/leave` while a wrap-up redial is in flight
 * (`AgencyDialer.hasRedialInFlight`). `agent_on_live_call`, as for any live call: the
 * redial is one, or is about to be.
 */
const REDIAL_IN_FLIGHT_REFUSAL: AgencyActionErrorResponse = {
  error: 'Conflict', code: 'agent_on_live_call',
  message: 'You are redialling the customer. Save the outcome once that call has ended.',
};

const log = createChildLogger({ component: 'agency-routes' });

/** The `softphone_audit` key for an answer that left the soft phone, else nothing. */
function exitAudit(left: boolean, audit: SoftphoneSessionExitAudit): Record<string, SoftphoneSessionExitAudit> {
  return left ? { [SOFTPHONE_SESSION_AUDIT_KEY]: audit } : {};
}

/**
 * May this non-supervising agent join `campaignId`? Yes when they are actively staffed on
 * it (`isActiveOnCampaign`, the rows `/my-assignments` lists), or when their one live
 * session in the tenant is already a campaign session on it: that join is a REHYDRATE
 * (a reload, an app resume), not a new session.
 *
 * The rehydrate is allowed on purpose. Unassigning closes the staffing row and touches no
 * live session (`proxy-agency-staffing/campaign-agents.ts`; an offboarding also revokes
 * the membership, and RBAC then refuses before this runs). Refusing the rehydrate would
 * not end that session: it would strand it, possibly mid-call, on a station the agent can
 * no longer open, while their lease keeps them dialable. So an agent unassigned
 * mid-shift keeps working until they leave, and the next join is refused.
 *
 * The live-session read runs only for an unstaffed caller, so a staffed join costs one
 * indexed probe. The check and the join are two statements: a staffing change landing
 * between them decides only whether this one join started, as it would a moment earlier.
 */
async function mayStartOrResume(tenantId: string, campaignId: string, agentUserId: string): Promise<boolean> {
  if (await agencyCampaignAgentRepository.isActiveOnCampaign(tenantId, campaignId, agentUserId)) return true;
  const live = await agencyAgentSessionRepository.findLiveForAgent(tenantId, agentUserId);
  return live !== null && isCampaignSession(live) && live.campaign_id === campaignId;
}

/**
 * Registered by `agencyRoutes` inside its authenticated scope (`sub`, the one carrying
 * `authMiddleware`), so every route here runs behind it.
 */

/** The force-available refusal's sentence while the agent is on an inbound call (offered or connected: an owed outcome is closed instead). */
const FORCE_INBOUND_MESSAGE = 'The agent is on an inbound call: they can be made available once it has ended.';

/** 409 `inbound_call_live` (docs/inbound.md §6): the session holds an inbound call. */
function inboundCallLive(inboundCallId: string, message: string): AgencyInboundCallLiveRefusal {
  return { error: 'Conflict', code: 'inbound_call_live', inbound_call_id: inboundCallId, message };
}

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

    // Staffing gates a NEW session (`not_staffed`), after the flag and the campaign so an
    // unknown campaign is still the 404. `supervise` is the public API layer's reading of
    // the caller's role; absent is `false`, so a caller that forgets it gets the check.
    if (body.supervise !== true && !(await mayStartOrResume(tenantId, campaign.id, body.agent_user_id))) {
      const refusal: AgencyActionErrorResponse = {
        error: 'Forbidden',
        code: 'not_staffed',
        message: 'You\'re not assigned to this campaign. Ask your supervisor to add you.',
      };
      return reply.code(403).send(refusal);
    }

    // OS3: the device joining, and whether the agent chose to take the station here. A rehydrate
    // of the agent's session on THIS campaign from another device than the one holding its
    // station, without `take_over`, is refused before the upsert writes anything (a device that
    // resumes on its own must not take the station back); the claim after it is the atomic check.
    const device = stationDeviceFields(body);
    if (await refuseIfHeldElsewhere(reply, tenantId, body.agent_user_id, device,
      (live) => live.kind === 'campaign' && live.campaign_id === campaign.id && live.account_id === accountId)) {
      return reply;
    }

    const joinInput = {
      tenantId, accountId,
      campaignId: campaign.id,
      agentUserId: body.agent_user_id,
      replicaId: runtime.replicaId,
    };
    // OS7: a session in another tenant with nothing in it (no station attached, nothing in flight)
    // is ended, as its own Leave would, and the join tried once more.
    const join = await joinEndingIdleElsewhere(runtime, () => agencyAgentSessionRepository.joinOrRehydrate(joinInput));

    // One live session per agent, across tenants (OS1). The agent is
    // still joined somewhere else and must leave that station first — nothing
    // here yanks them off it, because that station may be a live conversation
    // (see `AgencySessionCampaignConflict` for the full
    // reasoning). Refused with the old campaign NAMED: an agent who is told
    // only "conflict" has no way to find the station they left open.
    if (!join.ok && join.reason === 'other_tenant') {
      // OS1: live in another tenant, and working there (OS7 ended it otherwise). Named by tenant
      // only: nothing of that tenant's campaigns or accounts crosses the boundary.
      log.warn({ agentUserId: body.agent_user_id, requestedCampaignId: campaign.id },
        'Agency join refused — agent already live in another tenant');
      return sendSessionInOtherTenant(reply, join.session.tenant_id);
    }
    if (!join.ok) {
      // The agent's live session is a soft-phone session (docs/softphone.md): there
      // is no campaign to name in `session_on_other_campaign`, so it gets its own
      // 409, whose remedy is leaving the soft phone.
      // Named with the account it is in, which may be a sibling of this one: `leave`
      // is scoped to the session's account, so the console closes it with that one.
      const liveSession = join.session;
      if (!isCampaignSession(liveSession)) {
        const refusal: AgencySoftphoneSessionOnSoftphoneRefusal = {
          error: 'Conflict',
          code: 'session_on_softphone',
          message: 'You are on the soft phone. Leave the soft phone before joining a campaign — an agent can hold only one live station at a time.',
          session_id: liveSession.id,
          account_id: liveSession.account_id,
          account_name: await accountNameInTenant(liveSession.account_id, liveSession.tenant_id),
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
      // The session's own id and account, so the client can leave it from here: `leave`
      // is scoped to the session's account, which is often a sibling of this one (see
      // above). Only the caller's own session is ever named: `joinOrRehydrate` found it
      // by (tenant, the authenticated agent), the same lookup that refused the join. The
      // account name is best effort, read in this tenant (null when the read failed), as
      // on `session_on_softphone` above.
      const accountName = await accountNameInTenant(liveSession.account_id, liveSession.tenant_id);
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
        session_id: liveSession.id,
        account_id: liveSession.account_id,
        account_name: accountName,
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

    // OS3: this device holds the station now (a fresh session, the holder itself, no holder, or a
    // take-over), or another device does and this join is refused.
    if (!await claimStationOrReply(reply, session, device, {
      onGone: () => sendActionError(reply, 409, 'session_ended', undefined, 'This session has ended. Join the campaign again.'),
      awayRing: runtime.awayRing,
    })) return reply;

    // Redis, or `break` — the same rule as the station socket, and for the same
    // reason. Seeding Redis from `session.state` would be wrong: `joinOrRehydrate`
    // preserves it whenever it is not `offline`, so an agent re-bootstrapping
    // after a page reload, mid-call, would have `available` written over their
    // live `on_call` lease and the next tick would reserve them for a second
    // call. Nothing may derive availability from the durable mirror.
    const state = await runtime.rehydrateAgent(session.id, session);
    // From the row as joined, as `ready` does (`breakReasonFor`): the reason a client that
    // was killed while paused needs to say why on its way back.
    const breakReason = breakReasonFor(state, session);

    const minted = await mintStationTokenOr503(runtime, session.id, reply);
    if (!minted) return reply;

    // Campaign-CONSTANT, which is why it belongs on this payload and not on the
    // `reserved` frame: putting it there would repeat it once per dial for the
    // whole shift, on the one frame whose latency the design guards hardest.
    // Resolved here rather than in the object literal below so its `await` is
    // plainly outside the frame path.
    // Contact assignment (CA3): this agent's own queue at join, on a `strict` / `preferred`
    // campaign (undefined for `pool`). Best effort, as the retry context is: a failed read
    // omits the field rather than refusing the join, and pacing's `queue` frame follows.
    // The two reads are independent and run together, each with its own error handling.
    const [retryContext, queue] = await Promise.all([
      resolveRetryContext(campaign),
      Promise.resolve().then(() => readAgentQueueState(campaign, session.agent_user_id)).catch((err: unknown) => {
        log.warn({ err, sessionId: session.id, campaignId: campaign.id }, 'Could not read the agent queue — bootstrapping without it');
        return undefined;
      }),
    ]);

    const bootstrap: AgencySessionBootstrap = {
      session_id: session.id,
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      agent_user_id: session.agent_user_id,
      // The rehydrated state, not the row's — a bootstrap that advertised
      // `available` while Redis held `on_call` would have the console render a
      // ready agent over a live conversation.
      state,
      ...(breakReason ? { break_reason: breakReason } : {}),
      campaign_status: campaign.status,
      station_ws_url: `/api/v1/agency/station/${session.id}?token=${minted.token}`,
      station_token_expires_at: minted.expiresAt.toISOString(),
      disposition_catalog: campaign.disposition_catalog ?? [],
      wrapup_seconds: campaign.wrapup_seconds,
      wrapup_auto_return: campaign.wrapup_auto_return,
      // Wrap-up redial (0008): the campaign's setting at join. `=== true` so the
      // payload always carries a boolean, never `undefined` or `null`.
      allow_wrapup_redial: campaign.allow_wrapup_redial === true,
      // Contact assignment (0009): the campaign's mode and agent-retry setting at join, and
      // this agent's queue in `strict` / `preferred` mode (absent in `pool` mode).
      assignment_mode: campaign.assignment_mode ?? 'pool',
      allow_agent_retry: campaign.allow_agent_retry === true,
      ...(queue ? { queue } : {}),
      record_calls: campaign.record_calls,
      break_reasons: resolveBreakReasons(campaign.break_reasons),
      context_display: campaign.context_display ?? {},
      // By the joining app (`client_kind`, from `X-Client` on the public layer): a mobile
      // station is held to the shorter grace the sweep enforces on it.
      intervals: stationIntervalsFor(body.client_kind),
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
    // OS3: a reconnect from a device that no longer holds the station is refused, never minted:
    // the agent moved it to another device, and this one must not take it back on its own. Only
    // `take_over` (the agent's "Use it here") moves it.
    // A mint naming no device (a client from before OS3) is refused while a device holds the
    // station: it is a reconnect, and must not take the station back either.
    if (!await claimStationOrReply(reply, session, stationDeviceFields(request.body), {
      reconnect: true,
      onGone: () => sendActionError(reply, 409, 'session_ended', undefined, 'This session has ended.'),
      awayRing: runtime.awayRing,
    })) return reply;
    const minted = await mintStationTokenOr503(runtime, session.id, reply);
    if (!minted) return reply;
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
    // ── …nor an agent with a wrap-up redial in flight ─────────────────────
    //
    // From the moment Redial is pressed (the wrap-up is taken, so `stateFor` above is
    // null) until the redial ends and wrap-up reopens, the conversation's outcome is
    // owed and nothing else here says so. Going available then would put the agent in
    // the pool mid-redial with the write-up never taken.
    if (runtime.dialer.hasRedialInFlight(session.id)) {
      return reply.code(409).send(REDIAL_IN_FLIGHT_REFUSAL);
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

    // On the soft phone's break before the write: going available ends it (SP7), and
    // the public layer audits that (`softphone_audit`, `softphone-audit.ts`).
    const leavingSoftphone = onSoftphoneBreak(await runtime.agents.get(session.id), session);

    // Refused, atomically in the same Lua write, while the session holds a soft-phone
    // call — live or awaiting its outcome (docs/softphone.md §4.1 step 1, §6).
    // `unavailable` (Redis did not answer) keeps this route's behaviour from before
    // the guard: the write was logged and the mirror written; the lease is the
    // authority and pacing reads Redis, which then holds no `available`.
    //
    // Except when leaving the soft phone, and for a `manual` claim that would not
    // clear: then Redis still says `break` (and may still hold the claim), so answering
    // `available` would show the agent ready while pacing never reserves them, and
    // audit a soft-phone exit that did not happen. Nothing is written; retry
    // (`503 dial_failed`, as `POST /softphone/return` answers the same result).
    const set = await setAvailableGuarded(runtime.agents, session.id);
    if (!set.ok && (set.refusal.code === 'claim_not_released' || (set.refusal.code === 'unavailable' && leavingSoftphone))) {
      const err: AgencySoftphoneErrorResponse = {
        error: 'Service Unavailable', code: 'dial_failed',
        message: 'Could not change your status just now; nothing changed. Try again.',
      };
      return reply.code(503).send(err);
    }
    if (!set.ok && set.refusal.code !== 'unavailable') {
      if (set.refusal.code === 'inbound_call_live') {
        return reply.code(409).send(inboundCallLive(
          set.refusal.inboundCallId, 'Save the outcome of your inbound call before going available.'));
      }
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
    return reply.send({
      session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'available', since: new Date().toISOString(),
      ...exitAudit(leavingSoftphone, { campaign_id: session.campaign_id, from_state: 'break', via: 'available', withdrawn: false }),
    });
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
    // A wrap-up redial in flight is a live call owing the conversation's outcome: no
    // wrap-up to force, and a plain release would put the agent in the pool mid-call.
    // The supervisor waits for it to end (wrap-up reopens, and can then be forced).
    if (runtime.dialer.hasRedialInFlight(session.id)) {
      return reply.code(409).send({
        ...REDIAL_IN_FLIGHT_REFUSAL,
        message: 'The agent is redialling a customer from wrap-up. Force them available once that call has ended.',
      });
    }
    // A forced wrap-up never starts on the soft phone; a plain release from it ends it.
    const liveNow = await runtime.agents.get(session.id);
    // Mode B: an agent on `away_ring` is away from the app, with no station to be made available
    // on: the release would write them `offline` (and end their ringing) rather than put them in
    // the pool. Refused, nothing changed; force-break and sign-off work as today.
    if (liveNow?.state === 'break' && liveNow.ring) {
      return sendActionError(reply, 409, 'agent_away_ring', undefined, 'They\'re away from the app; their phone rings for inbound calls.');
    }
    const leavingSoftphone = onSoftphoneBreak(liveNow, session);
    const forced = await runtime.wrapup.force(session.id);
    let state: AgencyAgentState;
    let endedSoftphone = false;
    // The inbound call this force closed, for the public layer's audit row (`inbound-close-audit.ts`).
    let inboundClosed: Record<string, InboundCloseAudit> = {};
    if (forced) {
      // The forced wrap-up already released the agent (a queued break applies there).
      state = (await runtime.agents.get(session.id))?.state ?? 'offline';
    } else {
      const owed = await owedSoftphoneCall(runtime.agents, session.id);
      if (owed) return manualCallLive(owed);
      // An inbound call whose outcome the agent owes is closed here as its lapse would close it
      // (`no_disposition`; the public layer audits `agency_inbound_call.closed`, closed by a
      // supervisor) and the agent is returned below like any wrap-up (docs/inbound.md §6). A call
      // still offered or connected is not forced: the supervisor waits for it to end. Read from
      // the database first, as the soft phone's is.
      const closing = await runtime.inboundCalls.closeOwedForSupervisor(session.id);
      if (closing.kind === 'live') return reply.code(409).send(inboundCallLive(closing.inboundCallId, FORCE_INBOUND_MESSAGE));
      if (closing.kind === 'closed') {
        inboundClosed = { [INBOUND_CLOSE_AUDIT_KEY]: { inbound_call_id: closing.call.id, campaign_id: closing.call.matched_campaign_id } };
      }
      // Not in wrap-up — fall through to a plain return rather than 409ing. A
      // supervisor pressing this on an agent who just finished should not get an
      // error for winning a race by half a second.
      const released = await runtime.dialer.releaseAgent(session.id);
      if (released.result === 'inbound_call_owed') {
        const held = await owedInboundCallId(runtime.agents, session.id) ?? await runtime.agents.inboundCallOf(session.id);
        if (held) return reply.code(409).send({ ...inboundCallLive(held, FORCE_INBOUND_MESSAGE), ...inboundClosed });
        const err: AgencySoftphoneErrorResponse = {
          error: 'Service Unavailable', code: 'dial_failed',
          message: 'Could not change the agent\'s status just now; nothing changed. Try again.',
        };
        return reply.code(503).send({ ...err, ...inboundClosed });
      }
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
      endedSoftphone = leavingSoftphone && released.state === 'available' && released.result === 'ok';
    }
    return reply.send({
      session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state, since: new Date().toISOString(),
      ...exitAudit(endedSoftphone, { campaign_id: session.campaign_id, from_state: 'break', via: 'force_available', withdrawn: false }),
      ...inboundClosed,
    });
  });

  // ── POST /sessions/:id/break ───────────────────────────────────────────
  // `* → break`, with a reason code, QUEUED when the agent is mid-call and
  // applied at the end of wrap-up. Never mid-conversation.
  sub.post('/sessions/:id/break', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const session = await requireOwnedSession(request, reply);
    if (!session) return reply;
    // The mobile app's own pauses, device-away and (IQ51) phone-call: no catalog lists
    // them, and they have their own rules (never replacing a break the agent chose, and
    // answering 200 with the current state when there is nothing to protect, a soft-phone
    // session included). `device-away.ts`.
    const asked = (request.body as { reason?: unknown } | undefined)?.reason;
    if (isAppPauseBreakReason(asked)) {
      const result = await runDeviceAway(runtime, session, asked);
      if (result.ok) return reply.send(result.body);
      // Mode B: `away_ring` refused (typed, 409); the app falls back to `device_away`.
      if (result.refused) return reply.code(409).send(result.refused);
      // Every pass lost its compare-and-swap to a reservation or a release: a conflict
      // with the state, not a fault, so a 409 the error mask passes unchanged.
      const err: AgencyActionErrorResponse = {
        error: 'Conflict', code: 'state_changing',
        message: 'Your status changed while pausing you; nothing changed. Try again.',
      };
      return reply.code(409).send(err);
    }
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
      // The queue holds one break: another reason queued over a queued switch to the
      // soft phone REPLACES it, so the switch is withdrawn here and audited as such
      // (SP7, `via: 'break'` with the reason that took its place), as the ✕ on the
      // queued-switch pill is (`break/cancel`). Without it the trail would read
      // `softphone_started` (`queued: true`) with no end.
      const withdrawingSwitch = runtime.breaks.peek(session.id)?.code === SOFTPHONE_BREAK_REASON
        && check.reason.code !== SOFTPHONE_BREAK_REASON;
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
      return reply.send({
        ...queued,
        ...exitAudit(withdrawingSwitch, {
          campaign_id: session.campaign_id, from_state: live!.state, via: 'break', withdrawn: true, break_reason: check.reason.code,
        }),
      });
    }

    // From the soft phone's break to another one: that ends the soft phone (SP7).
    const leavingSoftphone = onSoftphoneBreak(live, session) && check.reason.code !== SOFTPHONE_BREAK_REASON;
    // …which it may not while a soft-phone call is live or owes its outcome: the call
    // belongs to the soft phone the agent would be leaving, and the console would stop
    // showing it. The same rule as `available` (`setAvailableGuarded`), read from the
    // database, which a lapsed lease cannot have lost — and checked and written under
    // the session row's lock, which the dial takes too (`setBreakLeavingSoftphone`), so
    // a Call pressed just before the break cannot slip in between the check and the
    // write. Redis already says `break`, so the row is written first.
    if (leavingSoftphone) {
      let left = false;
      for (let pass = 0; pass < 2; pass++) {
        left = (await agencyAgentSessionRepository.setBreakLeavingSoftphone(session.id, check.reason.code)).ok;
        if (left) break;
        const owed = await owedSoftphoneCall(runtime.agents, session.id);
        if (owed) {
          const err: AgencySoftphoneCallPendingRefusal = {
            error: 'Conflict', code: 'manual_call_live', call: owed,
            message: 'Save the outcome of your soft-phone call before taking another break.',
          };
          return reply.code(409).send(err);
        }
        // The call settled between the two reads: nothing is owed now, so write again.
      }
      if (!left) {
        const err: AgencySoftphoneErrorResponse = {
          error: 'Service Unavailable', code: 'dial_failed',
          message: 'Could not change your status just now; nothing changed. Try again.',
        };
        return reply.code(503).send(err);
      }
      await runtime.agents.set(session.id, 'break', { leaseMs: AGENT_LEASE_MS.break });
    } else {
      await runtime.agents.set(session.id, 'break', { leaseMs: AGENT_LEASE_MS.break });
      await agencyAgentSessionRepository.setState(session.id, 'break', check.reason.code);
    }
    runtime.stations.send(session.id, {
      event: 'agent_state', state: 'break', since, break_reason: check.reason.code,
    });
    const applied: AgencySessionStateResponse = {
      session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'break', since, break_reason: check.reason.code,
    };
    return reply.send({
      ...applied,
      ...exitAudit(leavingSoftphone, {
        campaign_id: session.campaign_id, from_state: 'break', via: 'break', withdrawn: false, break_reason: check.reason.code,
      }),
    });
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

    // A queued switch to the soft phone withdrawn by the ✕ is audited as that (SP7),
    // not as a plain break cancel: the public layer reads `softphone_audit`.
    const withdrawingSwitch = runtime.breaks.peek(session.id)?.code === SOFTPHONE_BREAK_REASON;
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
    return reply.send({
      ...body,
      ...exitAudit(cancelled && withdrawingSwitch, {
        campaign_id: session.campaign_id, from_state: live?.state ?? null, via: 'break_cancel', withdrawn: true,
      }),
    });
  });

  // ── POST /sessions/:id/leave ───────────────────────────────────────────
  //
  // ── Why this refuses mid-attempt, and why that is not a UI concern ───────
  //
  // Leaving clears the Redis lease, sets `left_at` and detaches the station.
  // With no guard, an `on_call` agent could leave and immediately join campaign
  // B — the row is left, so the upsert INSERTS rather than conflicting — and be
  // reserved and bridged while campaign A's attempt is still live on the wire.
  // That is the exact double-bridge `uq_agency_agent_live_agent` exists to make unreachable,
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
    // An inbound call offered to or connected with the session holds the station the same way
    // (docs/inbound.md §2): leaving would drop a customer the agent was about to hear, or is
    // talking to. One owing its outcome does not: the lapse sweep closes a call whose session left.
    if (runtime.inbound?.findCallForSession(session.id)) {
      const err: AgencyActionErrorResponse = {
        error: 'Conflict', code: 'agent_on_live_call',
        message: 'Finish or hang up your inbound call before leaving the station.',
      };
      return reply.code(409).send(err);
    }
    // A wrap-up redial being set up has no live attempt yet (the dialer registers it a
    // moment later): leaving now would detach the station the redial is about to ring
    // into. Refused like the live call it is about to be.
    if (runtime.dialer.hasRedialInFlight(session.id) && !runtime.dialer.hasLiveAttempt(session.id)) {
      return reply.code(409).send({
        ...REDIAL_IN_FLIGHT_REFUSAL,
        message: 'Your redial is being placed. You can leave once that call has ended.',
      });
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

    // Mode B: a session left while on `away_ring` (its phone parked, so the leave came from
    // another device: the app on screen would have ended the absence on its return) tells that
    // phone (`leaveSession`). A ring in flight refused the leave above.
    await leaveSession(runtime, session, await runtime.agents.get(session.id));
    return reply.send({ session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'offline', since: new Date().toISOString() });
  });
}
