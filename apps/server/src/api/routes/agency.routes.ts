import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, getTenantId, getAccountId } from '../middleware/auth.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../feature-flags/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { getPool } from '@magick-agency/db';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyCampaignRepository,
  agencyContactRepository,
} from '../../db/repositories/agency.repository.js';
import {
  checkActor,
  dispositionErrorMessage,
  dispositionRefusal,
  resolveDisposition,
  validateDispositionFields,
} from '../../agency/disposition.js';
import { resolveDispositionDecision } from '../../agency/disposition-policy.js';
import { markDnc } from '../../agency/dnc-mark.js';
import type { AgencyRuntime } from '../../agency/runtime.js';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { AGENT_LEASE_MS } from '../../agency/agent-state-machine.js';
import { DEFERRED_HANGUP_MS, STATION_HEARTBEAT_GRACE_MS } from '@magick-agency/domain/timers';
import { validateBreakReason, breakMustWait, resolveBreakReasons } from '@magick-agency/domain/break-manager';
import { callingWindowState, nextWindowOpen, resolveCallingWindow } from '../../agency/calling-hours.js';
import type {
  AgencyActionErrorCode,
  AgencyActionErrorResponse,
  AgencyCreateSessionRequest,
  AgencyDisposition,
  AgencyDispositionRequest,
  AgencyDispositionResponse,
  AgencyDncRequest,
  AgencyDncResponse,
  AgencyDncScope,
  AgencyHangupRequest,
  AgencyHangupResponse,
  AgencyNotesRequest,
  AgencyNotesResponse,
  AgencyRetryContext,
  AgencySessionBootstrap,
  AgencySessionCampaignConflict,
  AgencySessionStateResponse,
  AgencyStationIntervals,
  AgencyStationTokenResponse,
} from '@magick-agency/contracts/agency';

// The banner copy is built server-side from the frozen selector, so the sentence the
// agent reads and the query that produced their roster cannot disagree. A leaf
// module — see its header.
import { renderSelectionSummary } from '@magick-agency/domain/retry-summary';

const log = createChildLogger({ component: 'agency-routes' });

/**
 * The retry banner for a campaign that is one, or `undefined` for the ~100% of
 * campaigns that are not.
 *
 * ── Best-effort, and never able to fail the bootstrap ────────────────────────
 *
 * This is one line of copy above the contact panel. The bootstrap is the payload
 * between "the agent clicks join" and "the console renders", so a failed read
 * here must cost the banner, never the shift — the same rule, and the same
 * `.catch`, as the session-conflict route's campaign-name lookup.
 *
 * ── A retry whose parent is GONE still gets a banner ─────────────────────────
 *
 * `parent_campaign_id` is `ON DELETE SET NULL`, so
 * `retry_generation > 0` with no resolvable parent is a real state rather than a
 * corrupt row. "These contacts were called before, for these reasons" stays true
 * and useful without the parent's name, so the name degrades to a neutral
 * placeholder — exactly as the join-conflict refusal degrades to "another
 * campaign" — instead of the whole banner disappearing.
 *
 * ── Scoped to the TENANT, deliberately not to the account ────────────────────
 *
 * `findById` is unscoped, so the name has to be checked against something. The
 * right scope is the one the lineage itself spans: a retry is created inside one
 * account by `requireOwned`, so an ancestor in another account of the same tenant
 * cannot arise today — but a name from another TENANT could only be a corrupt row
 * or a repurposed id, and naming it would leak across the tenant boundary the
 * dialer scopes everything on.
 *
 * The selector is read from the CHILD's own row and the labels from the PARENT's
 * catalog: the selector was authored against the parent's roster, so a code the
 * parent had and the child does not would otherwise render as a bare slug.
 */
async function resolveRetryContext(
  campaign: AgencyCampaignRecord,
): Promise<AgencyRetryContext | undefined> {
  if (campaign.retry_generation <= 0) return undefined;

  const parent = campaign.parent_campaign_id
    ? await agencyCampaignRepository.findById(campaign.parent_campaign_id).catch((err) => {
        log.warn(
          { err, campaignId: campaign.id, parentCampaignId: campaign.parent_campaign_id },
          'Could not resolve retry parent — bootstrapping without the parent name',
        );
        return null;
      })
    : null;

  // ── Scoped on BOTH, not just the tenant ────────────────────────────────────
  //
  // `retryFromCampaign` copies the parent's `account_id` onto the child, so a
  // mismatch is unreachable today — this is the platform's "every resource is
  // scoped by tenant AND account" rule applied where the only thing that would
  // otherwise catch it is that invariant holding forever. What crosses the
  // boundary if it ever stops is a campaign NAME, rendered into a banner on the
  // screen of an agent in a different account.
  const inScope =
    parent && parent.tenant_id === campaign.tenant_id && parent.account_id === campaign.account_id
      ? parent
      : null;
  const summary = renderSelectionSummary(campaign.retry_selector, inScope?.disposition_catalog ?? []);
  // An empty summary means the stored selector narrowed to nothing readable — a
  // shape from another release. A banner reading `Retry 1 of "X" —` with nothing
  // after the dash is worse than no banner, so the field is omitted entirely and
  // the console's `retry_context?` branch renders the ordinary panel.
  if (!summary) {
    log.warn(
      { campaignId: campaign.id },
      'Retry campaign has no renderable selector — bootstrapping without the retry banner',
    );
    return undefined;
  }

  return {
    generation: campaign.retry_generation,
    parent_campaign_name: inScope?.name ?? 'a previous campaign',
    selection_summary: summary,
  };
}

/**
 * Advertised to the client so nothing hardcodes a heartbeat.
 *
 * Typed against the contract rather than inferred, so a field added to
 * `AgencyStationIntervals` is a compile error here instead of a silently absent
 * value the console falls back to a guess for.
 */
const STATION_INTERVALS: AgencyStationIntervals = {
  heartbeat_ms: 10_000,
  // Read from `timers.js` rather than restated, because it is now ENFORCED by the
  // silent-station sweep as well as advertised here. Two copies of a number one of
  // which closes sockets is a number that drifts, and the drift would be silent in
  // the worse direction: a console told it has 30s while the server hangs up at 20.
  heartbeat_grace_ms: STATION_HEARTBEAT_GRACE_MS,
  reservation_lease_ms: AGENT_LEASE_MS.reserved_predial,
  countdown_ms: 3_000,
  deferred_hangup_ms: DEFERRED_HANGUP_MS,
};

export async function agencyRoutes(app: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // This module is the session and attempt handlers only, registered on the
  // internal handler instance (`core-handlers.ts`, reached in-process via `callCore`;
  // decision B16). The station WebSocket is not served here: it lives in
  // `agency/station-socket.ts` (`handleStationSocket`) and is mounted only at
  // `/proxy/agency/station/:sessionId` by `proxy-agency-station.routes.ts`, which also
  // rewrites the `station_ws_url` minted below (`/api/v1/agency/station/<id>?token=…`)
  // onto that path. The roster hand-off is `agency/agency-roster.client.ts`.

  await app.register(async (sub) => {
    sub.addHook('preHandler', authMiddleware);

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
        // `.catch` because this lookup exists ONLY to make the refusal readable.
        // Letting it reject would convert a 409 the agent can act on into a 500
        // they cannot — and `campaign_id` below already carries everything the
        // console needs to route them.
        const other = await agencyCampaignRepository.findById(join.session.campaign_id)
          .catch((err) => {
            log.warn({ err, campaignId: join.session.campaign_id }, 'Could not resolve conflicting campaign name');
            return null;
          });
        // Redis, not the row — the row is a durable mirror and this field is what
        // the console uses to decide whether leaving that station is safe right
        // now. Falling back to the row rather than failing when there is no
        // key: no key means no lease, so nothing is in flight and the mirror is
        // then the closest truthful reading. A 500 here would hide a conflict the
        // agent can actually resolve behind one they cannot.
        const live = await runtime.agents.get(join.session.id);
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
        const otherName = other && other.tenant_id === join.session.tenant_id
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
          campaign_id: join.session.campaign_id,
          campaign_name: otherName,
          state: live?.state ?? join.session.state,
        };
        log.warn({
          agentUserId: body.agent_user_id, requestedCampaignId: campaign.id,
          liveCampaignId: join.session.campaign_id, state: conflict.state,
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
      const state = await runtime.rehydrateAgent(session.id);

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

      await runtime.agents.set(session.id, 'available', { leaseMs: AGENT_LEASE_MS.available });
      await agencyAgentSessionRepository.setState(session.id, 'available');
      runtime.stations.send(session.id, { event: 'agent_state', state: 'available', since: new Date().toISOString() });
      return reply.send({ session_id: session.id, campaign_id: session.campaign_id, state: 'available', since: new Date().toISOString() });
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
      const forced = await runtime.wrapup.force(session.id);
      if (!forced) {
        // Not in wrap-up — fall through to a plain return rather than 409ing. A
        // supervisor pressing this on an agent who just finished should not get an
        // error for winning a race by half a second.
        await runtime.dialer.releaseAgent(session.id);
      }
      return reply.send({ session_id: session.id, campaign_id: session.campaign_id, state: 'available', since: new Date().toISOString() });
    });

    // ── POST /sessions/:id/break ───────────────────────────────────────────
    // `* → break`, with a reason code, QUEUED when the agent is mid-call and
    // applied at the end of wrap-up. Never mid-conversation.
    sub.post('/sessions/:id/break', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const session = await requireOwnedSession(request, reply);
      if (!session) return reply;
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
          session_id: session.id, campaign_id: session.campaign_id, state: live!.state, since,
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
        session_id: session.id, campaign_id: session.campaign_id, state: 'break', since, break_reason: check.reason.code,
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
        session_id: session.id, campaign_id: session.campaign_id, state: live?.state ?? session.state, since,
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
      return reply.send({ session_id: session.id, campaign_id: session.campaign_id, state: 'offline', since: new Date().toISOString() });
    });

    // ── POST /attempts/:id/disposition ─────────────────────────────────────
    // Served at `/proxy/agency/attempts/:id/disposition`, gated there at
    // `agency.attempts.dispose`. The ownership rule lives here, because "is the
    // reserved agent for this attempt" is a dialer-runtime fact the RBAC gate
    // cannot check — and `agency.attempts.dispose` floors at `agent` over a LINEAR
    // hierarchy, so every role above holds it by design and the permission matrix
    // will never produce a 403 for it. There is no second place this can live.
    /**
     * ── POST /attempts/:id/hangup — the agent ends the call ────
     *
     * An HTTP route rather than a station-socket control frame: HTTP is the
     * supported surface for agent actions, the public API layer floors this at
     * `agency.attempts.handle`, the console calls it, and a control frame gives the
     * console no status to act on. The contract's `AgencyStationHangupFrame` is
     * withdrawn and nothing reads it, so this is the only way to hang up.
     */
    sub.post('/attempts/:id/hangup', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const found = await requireOwnedAttempt(request, reply);
      if (!found) return reply;
      const { attempt } = found;

      // Ownership, exactly as on disposition. Without it any tenant member holding
      // `agency.attempts.handle` — which every agent holds — could hang up any
      // other agent's live conversation. This is the check the contract promises:
      // the server verifies the caller is the reserved agent.
      const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
      const actor = checkActor(reservedUserId, (request.body ?? {}) as AgencyHangupRequest);
      if (!actor.ok) {
        return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
      }

      // An agent's hangup routinely races the customer's. Erroring on an attempt
      // that just ended would show a failure for the thing that already happened,
      // so a terminal row is an idempotent success.
      const ended = await runtime.dialer.hangupAttempt(attempt.id);
      if (!ended && attempt.state !== 'ended') {
        return sendActionError(reply, 409, 'attempt_not_live');
      }

      // Re-read rather than echo `attempt`: `hangupAttempt` awaits the bridge, so
      // by now the row is usually terminal. Usually, not always — the terminal
      // write rides the bridge's `ended` lifecycle event and `emitLifecycle` does
      // not await its listeners. The station socket's `released` frame is the
      // console's authority for "the call is over"; this response says the hangup
      // was accepted, and `AgencyHangupResponse` says so too.
      const fresh = await agencyAttemptRepository.findById(attempt.id).catch(() => null);
      const body: AgencyHangupResponse = {
        attempt_id: attempt.id,
        campaign_id: attempt.campaign_id,
        state: fresh?.state ?? attempt.state,
        outcome: fresh?.outcome ?? attempt.outcome ?? null,
      };
      return reply.send(body);
    });

    sub.post('/attempts/:id/disposition', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const found = await requireOwnedAttempt(request, reply);
      if (!found) return reply;
      const { attempt, campaign } = found;
      const body = (request.body ?? {}) as AgencyDispositionRequest;

      // ── 1. Who is acting (steps 1–4 on `AgencyActorFields`) ──────────────
      // Ahead of catalog validation deliberately: a caller who has no business
      // with this attempt must not learn the campaign's catalog from the
      // `allowed_codes` echo on a validation error.
      const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
      const actor = checkActor(reservedUserId, body);
      if (!actor.ok) {
        return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
      }

      // ── 2. Is there anything here to disposition ─────────────────────────
      const refusal = dispositionRefusal(attempt);
      if (refusal) return sendActionError(reply, 409, refusal);

      // ── 3. The code, then the fields it makes mandatory ──────────────────
      const resolved = resolveDisposition(campaign.disposition_catalog, body.disposition_code);
      if (!resolved.ok) {
        return sendActionError(reply, 400, 'unknown_disposition_code', resolved.allowed);
      }
      const fields = validateDispositionFields(resolved.entry, body, new Date());
      if (!fields.ok) return sendActionError(reply, 400, fields.code);

      // ── 4. The write. Same code ⇒ success; different code ⇒ 409 ──────────
      // One guarded UPDATE does both, so a double-click cannot interleave a read
      // with a write and quietly overwrite the record of a conversation.
      const updated = await agencyAttemptRepository.recordDisposition({
        attemptId: attempt.id,
        dispositionCode: resolved.entry.code,
        notes: fields.notes,
        callbackAt: fields.callbackAt,
        actorUserId: actor.actorUserId,
        onBehalf: actor.onBehalf,
      });
      if (!updated) {
        // The predicate only fails on a DIFFERENT code — a same-code replay is a
        // successful write above. Silently rewriting the record of what was said
        // to a customer is not a retry.
        return sendActionError(reply, 409, 'already_dispositioned');
      }

      // ── 5. The contact: `completed`, or `pending` for a callback or retry ──
      // A callback is honoured rather than merely captured: storing the datetime
      // and doing nothing would have an agent promise a customer a call that never
      // comes. It re-enters the roster as an ordinary contact — whichever agent is
      // available takes it, which is why nothing binds it to this session.
      //
      // No `bump_attempt`: the attempt was already counted when it ended. Bumping
      // here would charge a contact twice for one dial and, at `max_attempts: 3`,
      // exhaust someone after two real conversations.
      //
      // ── The precedence, applied ──────────────────────────────────────────
      // A disposition's `retry`/`terminal`/`suppress` OVERRIDES the outcome
      // policy, so this is the site that has to honour them — a `voicemail`
      // code's `retry` and a `do_not_call` code's `suppress` are not just
      // captured in the catalog, they decide the contact's next state.
      //
      // `attemptsUsed` is the STORED count, with no bump: the attempt was already
      // charged when it ended. Bumping here would charge a contact twice for one
      // dial and, at `max_attempts: 3`, exhaust someone after two real
      // conversations. That is the opposite convention from the dial path, which
      // passes the post-bump count — hence a read rather than a reuse.
      //
      // Read ONLY when the decision can turn on it — a disposition `retry` with no
      // callback. Every other arm (`suppress`, `terminal`, a callback, a plain
      // label) ignores `attemptsUsed`, so the common path costs no query, and the
      // `0` those arms are handed cannot silently become load-bearing later without
      // this condition being revisited.
      //
      // `.catch(() => null)` is not defensive noise: a DB blip must not fail an
      // agent's disposition, because the conversation is over and this write is the
      // only record of it — the same posture `resolveCallbackDialTime` already
      // takes on its own read of this row. The fallback is 0, which is permissive:
      // it schedules a retry rather than declaring a budget spent on no evidence.
      const needsAttemptCount = !!resolved.entry.retry && !fields.callbackAt;
      const contactRow = needsAttemptCount
        ? await agencyContactRepository.findById(attempt.contact_id).catch(() => null)
        : null;
      const decision = resolveDispositionDecision(resolved.entry, {
        now: new Date(),
        attemptsUsed: contactRow?.attempt_count ?? 0,
        callbackAt: fields.callbackAt,
      });
      const contactState = decision.contactState;
      // ── The callback is scheduled for when we can actually dial ──────────
      //
      // A `callback_at` outside the contact's calling window is honoured by
      // DEFERRING it to the next window open, not by refusing it. Refusing would
      // block a legitimate "call me Saturday" on a Mon–Fri campaign, and the
      // operator's window is the compliance boundary; the pre-dial calling-hours
      // gate would refuse that dial anyway, so writing the raw time would only
      // make the contact wake up, get deferred, and wake again.
      //
      // The response then reports THIS instant rather than the raw request, because
      // the agent says the time out loud to a customer. `callback_at` on the attempt
      // row keeps the raw request — what was promised and what we scheduled are two
      // different facts and the audit needs both.
      const scheduledAt = fields.callbackAt
        ? await resolveCallbackDialTime(campaign, attempt.contact_id, fields.callbackAt)
        : null;
      // `scheduledAt` wins over the decision's own instant when there is one: for a
      // callback they are the same moment, one deferred into the calling window, and
      // the deferred one is what we will actually dial. A DISPOSITION RETRY's delay
      // (`voicemail`, 240 minutes) is deliberately written raw and NOT deferred —
      // matching the dial path's outcome-retry write, and leaving the calling-hours
      // question to the pre-dial gate. Only the callback is deferred, because only
      // the callback was said out loud to a customer.
      //
      // ⚠️ Gated on the DECISION having scheduled something, not merely on a
      // `callback_at` having been submitted. `scheduledAt` is derived from the
      // callback arm, and that arm can LOSE: the precedence puts `suppress` and
      // `terminal` above it, and `callback_at` is only ever *required* by
      // `requires_datetime` — never *refused* without it — so a sticky console field
      // or a supervisor correcting a code without clearing the time submits
      // `do_not_call` or `not_interested` WITH a datetime. Ungated, the losing arm's
      // instant would override the winning decision's `null`: the contact would be
      // written `suppressed`/`completed` while carrying a future `next_attempt_at`,
      // and the response would tell the console a DNC'd customer is to be dialed on
      // Wednesday.
      // Inert for dialing — `claimDialable` gates on `state = 'pending'` — but it is
      // the precedence contradicting itself in the field a console and a compliance
      // export both read.
      const nextAttemptAt = decision.nextAttemptAt ? (scheduledAt ?? decision.nextAttemptAt) : null;
      await agencyContactRepository.markState(attempt.contact_id, contactState, {
        last_outcome: attempt.outcome,
        last_disposition: resolved.entry.code,
        ...(nextAttemptAt ? { next_attempt_at: nextAttemptAt } : {}),
        ...(decision.suppressedReason ? { suppressed_reason: decision.suppressedReason } : {}),
      });
      // ⚠️ `markState` writes `next_attempt_at = COALESCE($6, next_attempt_at)`, so a
      // contact moved to `suppressed`/`completed`/`exhausted` with no new instant
      // KEEPS its previous one. Harmless today — `claimDialable` gates on
      // `state = 'pending'`, so nothing reads it — but it means a test asserting "no
      // retry was scheduled" here would be observing a stale value rather than an
      // absence. Assert the STATE. Nothing clears the column yet.
      log.info(
        {
          contactId: attempt.contact_id, attemptId: attempt.id,
          dispositionCode: resolved.entry.code, contactState,
          dispositionReason: decision.reason, nextAttemptAt,
        },
        'Contact released by the disposition policy',
      );

      // ── 6. Release the wrap-up, if this attempt is the one holding it ─────
      // `noteDisposition` is a no-op unless the session is in wrap-up FOR THIS
      // attempt, which is what lets a supervisor write up an old call without
      // pulling a live agent off a new one.
      if (attempt.reserved_agent_id) {
        await runtime.wrapup.noteDisposition(attempt.reserved_agent_id, attempt.id);
      }

      const live = attempt.reserved_agent_id ? await runtime.agents.get(attempt.reserved_agent_id) : null;
      const response: AgencyDispositionResponse = {
        attempt_id: attempt.id,
        contact_id: attempt.contact_id,
        campaign_id: attempt.campaign_id,
        disposition_code: resolved.entry.code,
        contact_state: contactState,
        // When we will dial, not what was asked for. The echo is a separate field
        // precisely so a console cannot mistake one for the other.
        //
        // Also carries a DISPOSITION RETRY's instant (`voicemail`'s 240 minutes),
        // not just a callback's: the console shows the agent when this contact comes
        // back, and reporting `null` for a retry that is genuinely scheduled would be
        // a worse lie than reporting a raw time. `callback_requested_at` stays null on
        // that arm, which is how a console tells the two apart.
        next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null,
        callback_requested_at: fields.callbackAt ? fields.callbackAt.toISOString() : null,
        // ADVISORY, and it races the socket by design — releasing the wrap-up
        // returns the agent to the pool and the tick runs every 250ms, so a new
        // `reserved` frame can reach the console before this response does.
        agent_state: live?.state ?? 'offline',
      };
      return reply.send(response);
    });

    // ── POST /attempts/:id/dnc ─────────────────────────────────────────────
    //
    // The agent's "do not call" button. Registered inside THIS scope, which is the
    // one carrying `authMiddleware` — auth is registered per route-plugin rather
    // than globally, so a route landed outside it ships unauthenticated.
    //
    // Two writes, committed together in one transaction (decision B8):
    //
    //   1. **Every roster row in THIS campaign carrying this number** is
    //      suppressed. `claimDialable` claims only `state = 'pending'`, so those
    //      contacts leave the roster at once — which is what makes "marked DNC at
    //      T, not dialed by the retry at T+5" true.
    //   2. **The compliance record**: a `dnc_entries` row written by `markDnc`
    //      (`agency/dnc-mark.ts`), whose reach is the request's `scope` — this
    //      campaign by default, the whole tenant when the console escalates. The
    //      dial-time check (`DncRegistry.check`) reads that table, widened by
    //      scope. `dnc_recorded` reports whether the row landed.
    //
    // ⚠️ The two scopes differ ONLY in the `dnc_entries` row. Write (1) is
    // unconditional: the contact in front of the agent leaves the roster the same
    // way either way. Making it conditional on scope would leave a `tenant` mark
    // relying on the dial-time check alone to keep this campaign's rows from
    // being claimed.
    //
    // ⚠️ Why (1) is by PHONE and not by contact id. The schema has no
    // phone-unique index on purpose, so a campaign holding one number twice is
    // normal, supported data. A by-contact-id write would leave the duplicate
    // `pending`, so the number the customer just asked us to stop calling would
    // still be claimed from this campaign and rest on the dial-time check alone.
    // Do not narrow this to the contact id.
    sub.post('/attempts/:id/dnc', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const found = await requireOwnedAttempt(request, reply);
      if (!found) return reply;
      const { attempt, campaign } = found;
      const body = (request.body ?? {}) as AgencyDncRequest;

      // ── 1. Validate everything BEFORE writing anything ───────────────────
      // Same ordering discipline as the disposition route: a 400 must not leave a
      // half-applied request behind. The optional `disposition_code` is validated
      // here rather than ignored — silently dropping a field the public API layer
      // accepts and forwards is the exact failure class to avoid.
      //
      // ── The SCOPE, which is the field with the customer-facing promise on it ─
      //
      // ABSENT ⇒ `campaign`, the NARROWER of the two. A caller that knows nothing
      // about scope — an older console, a script — thereby fails safe instead of
      // suppressing a number across campaigns the customer never mentioned.
      //
      // An unrecognised value is REFUSED, not defaulted. The console's escalation
      // is labelled to the agent as "any campaign, forever" and an agent may read
      // that out to the customer; quietly writing the campaign-scoped row for a
      // misspelled `tenant` would make a compliance statement to a customer false,
      // behind a 200 and a green dashboard. Loud is the only safe direction here.
      //
      // ⚠️ The public API layer's `dncSchema` must keep declaring `scope`: if Zod
      // strips it there, the escalation silently becomes a campaign mark here.
      if (body.scope !== undefined && body.scope !== 'campaign' && body.scope !== 'tenant') {
        return sendActionError(reply, 400, 'invalid_dnc_scope', ['campaign', 'tenant']);
      }
      const scope: AgencyDncScope = body.scope ?? 'campaign';

      let disposition: { entry: AgencyDisposition; actorUserId: string; onBehalf: boolean } | null = null;
      if (body.disposition_code !== undefined) {
        const resolved = resolveDisposition(campaign.disposition_catalog, body.disposition_code);
        if (!resolved.ok) {
          return sendActionError(reply, 400, 'unknown_disposition_code', resolved.allowed);
        }
        // A disposition is the record of who said what about a customer, so it is
        // never written unattributed. The public API layer sends the authenticated
        // actor (`resolveAgencyActor`); a request without one is a loud 400 rather
        // than a silent drop, and deliberately NOT defaulted to the attempt's
        // reserved agent: a supervisor marking someone else's attempt would be
        // recorded as that agent.
        const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
        const actor = checkActor(reservedUserId, body);
        if (!actor.ok) {
          return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
        }
        disposition = { entry: resolved.entry, actorUserId: actor.actorUserId, onBehalf: actor.onBehalf };
      }

      const contact = await agencyContactRepository.findById(attempt.contact_id);
      if (!contact) {
        return reply.code(404).send({ error: 'Not Found', message: 'Contact not found' });
      }

      // Decision B8: steps 2–4 run in ONE transaction on one client — the roster
      // suppression, the optional disposition and the `dnc_entries` row commit or roll
      // back together. The mark is part of the agent's bookkeeping, so a failed insert
      // rolls the suppression back and the route answers a 5xx with nothing claimed
      // (`markDnc` rethrows when given `deps.client`). A number that is not usable E.164
      // is not a failure: `markDnc` writes nothing and says so (`dnc_recorded: false`),
      // and the marked contact still leaves the roster. The wrap-up release waits for
      // the COMMIT.
      let suppressedContactIds: string[] = [];
      let forwarded!: Awaited<ReturnType<typeof markDnc>>;
      let noteDispositionFor: string | null = null;
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        // ── 2. Suppress the roster rows ──────────────────────────────────────
        // All three steps share this transaction, so a throw at any of them rolls
        // the others back: the response never confirms a suppression that did not
        // happen, and a DNC confirmation an agent reads out to a customer must not
        // be a guess. A throw is a 5xx with nothing claimed.
        //
        // ⚠️ Unconditional in BOTH scopes, and not an oversight. A `tenant`
        // escalation's `dnc_entries` row also blocks this number at dial time
        // everywhere, but taking the rows off the roster here is what keeps them
        // from being claimed at all. The contact on the line leaves the roster the
        // same way whatever scope was asked for.
        //
        // ⚠️ `suppressByPhone` preserves `markState`'s `next_attempt_at` behaviour
        // exactly: a contact that already had a retry instant KEEPS it (the column
        // is left out of the UPDATE, which is what `COALESCE(NULL, next_attempt_at)`
        // did). Inert — `claimDialable` gates on `pending` — but it means the STATE
        // is the thing that took these contacts off the roster, and the thing any
        // test here must assert. Clearing the column does not belong in a
        // compliance route.
        //
        // `attempt.contact_id` is passed as the row that is suppressed WHATEVER
        // happens: a roster number that is not usable E.164 matches nothing by
        // phone, and the contact in front of the agent must still leave the roster —
        // the guarantee a naive by-phone write silently drops. The disposition rides that row alone; stamping it
        // on a housemate's row because they share a landline would invent a record
        // of a conversation that never happened.
        suppressedContactIds = await agencyContactRepository.suppressByPhone(
          campaign.id,
          contact.phone_e164,
          'dnc',
          {
            alwaysContactId: attempt.contact_id,
            ...(disposition ? { lastDisposition: disposition.entry.code } : {}),
          },
          { client },
        );

        // ── 3. The optional disposition, if one was asked for ────────────────
        // A null return means the attempt already carries a DIFFERENT code. The
        // disposition route calls that a 409, and rightly — but here the disposition
        // is the secondary half, and refusing the whole request over it would leave
        // a customer who asked not to be called again sitting on the roster. Logged,
        // not raised.
        if (disposition) {
          const updated = await agencyAttemptRepository.recordDisposition({
            attemptId: attempt.id,
            dispositionCode: disposition.entry.code,
            notes: null,
            callbackAt: null,
            actorUserId: disposition.actorUserId,
            onBehalf: disposition.onBehalf,
          }, { client });
          if (!updated) {
            log.warn(
              { attemptId: attempt.id, dispositionCode: disposition.entry.code },
              'Attempt already carries a different disposition — the DNC suppression still stands',
            );
          } else if (attempt.reserved_agent_id) {
            // No-op unless the session is in wrap-up FOR THIS attempt, exactly as on
            // the disposition route. Run after COMMIT (below), so a rolled-back
            // disposition never releases wrap-up.
            noteDispositionFor = attempt.reserved_agent_id;
          }
        }

        // ── 4. The durable compliance record, `dnc_entries` ──────────────────
        forwarded = await markDnc({
          tenantId: attempt.tenant_id,
          // ── The SCOPE of the `dnc_entries` row, and the ONE place it is set ──
          //
          // Present ⇒ a CAMPAIGN-scoped row: the dial-time check stops this
          // campaign calling the number, and other campaigns are untouched.
          //
          // Absent ⇒ a TENANT-WIDE row, which blocks the number at dial time in
          // every campaign the tenant runs, now and in future. That is not a
          // fallback or a leftover — it is the escalation the console offers under a
          // permission and describes to the agent as "any campaign, forever", and
          // this omission is the only thing in the dialer runtime that produces it.
          // Deleting the conditional here (either arm of it) makes that label a
          // false statement to a customer on an irreversible compliance action,
          // with a 200 and `dnc_recorded: true` behind it.
          //
          // The campaign id is the server's own — `requireOwnedAttempt` resolved it
          // from the attempt. The client asserts only which of the two scopes it
          // wants, never an id (`AgencyDncRequest.scope`).
          ...(scope === 'campaign' ? { campaignId: campaign.id } : {}),
          phoneE164: contact.phone_e164,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
          // Who suppressed this number, for the compliance record. Two sources, in
          // order of how much they have been checked:
          //
          //   - the disposition arm's actor, which `checkActor` has already
          //     validated against the attempt's reservation;
          //   - otherwise the authenticated caller the public API layer sends,
          //     unchecked, because a plain mark-DNC deliberately has no ownership
          //     rule — a supervisor suppressing a number mid-shift is a real action.
          //
          // Still **never derived locally**. `resolveReservedAgentUserId` is right
          // here and is not consulted: filling the field from the attempt's reserved
          // agent would record whoever happened to hold the call rather than whoever
          // asked, and on a compliance record a confidently-wrong actor is worse
          // than a NULL one.
          ...(disposition
            ? { addedBy: disposition.actorUserId }
            : (typeof body.agent_user_id === 'string' && body.agent_user_id
              ? { addedBy: body.agent_user_id }
              : {})),
        }, { client });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
        throw err;
      } finally {
        client.release();
      }
      if (noteDispositionFor) {
        await runtime.wrapup.noteDisposition(noteDispositionFor, attempt.id);
      }

      log.info(
        {
          contactId: attempt.contact_id, attemptId: attempt.id,
          campaignId: campaign.id,
          // What the customer was actually promised. Logged because it is the one
          // property of this press that is invisible in every other signal: a
          // `tenant` escalation and a `campaign` mark produce the same 200, the
          // same `contact_state`, and the same suppressed-row count.
          dncScope: scope,
          // How many roster rows this press actually took off the campaign.
          // Logged rather than merely counted: >1 means this campaign held the
          // number more than once, the case the by-phone suppression exists for.
          suppressedContacts: suppressedContactIds.length,
          dncRecorded: forwarded.recorded, alreadyPresent: forwarded.alreadyPresent,
          dispositionCode: disposition?.entry.code ?? null,
        },
        'Contact marked do-not-call by an agent',
      );

      const response: AgencyDncResponse = {
        attempt_id: attempt.id,
        contact_id: attempt.contact_id,
        campaign_id: attempt.campaign_id,
        // What was actually suppressed, in the normalized form the dial-time DNC
        // check compares against — not what the roster row happened to hold.
        phone_e164: forwarded.phoneE164 ?? contact.phone_e164,
        // Always `suppressed` on success, by contract, and it outranks the
        // disposition precedence: a `sale` code would resolve to `completed`, but
        // the customer asked not to be called again and that wins.
        contact_state: 'suppressed',
        dnc_recorded: forwarded.recorded,
      };
      return reply.send(response);
    });

    // ── POST /attempts/:id/notes ───────────────────────────────────────────
    // Separate from the disposition because the two happen at different times:
    // agents type while the customer is talking. Safe to call repeatedly, live
    // and through wrap-up, so an autosave need not know which phase it is in. It
    // does NOT end wrap-up and does NOT satisfy `requires_disposition`.
    sub.post('/attempts/:id/notes', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const found = await requireOwnedAttempt(request, reply);
      if (!found) return reply;
      const { attempt } = found;
      const body = (request.body ?? {}) as AgencyNotesRequest;

      const reservedUserId = await resolveReservedAgentUserId(attempt.reserved_agent_id);
      const actor = checkActor(reservedUserId, body);
      if (!actor.ok) {
        return sendActionError(reply, actor.code === 'missing_actor' ? 400 : 403, actor.code);
      }
      if (typeof body.notes !== 'string') {
        return sendActionError(reply, 400, 'note_required');
      }

      // Deliberately NOT gated on `dispositionRefusal`. Notes are accepted while
      // the attempt is live — before `bridged_at` exists on a call the agent is
      // already typing into — and on an auto-closed one, where what the agent
      // wrote is the only record of the conversation left.
      const updated = await agencyAttemptRepository.saveNotes(attempt.id, body.notes);
      if (!updated) return reply.code(404).send({ error: 'Not Found', message: 'Attempt not found' });

      const response: AgencyNotesResponse = {
        attempt_id: updated.id,
        notes: updated.notes ?? '',
        updated_at: updated.updated_at.toISOString(),
      };
      return reply.send(response);
    });
  });

  /** A 4xx in the closed `AgencyActionErrorResponse` shape the public API layer passes through. */
  function sendActionError(
    reply: FastifyReply,
    status: number,
    code: AgencyActionErrorCode,
    allowedCodes?: string[],
    // Q8 (Manas, 2026-10-09): the session routes' `missing_actor` reuses this shape with a
    // session-specific sentence (the default copy speaks of dispositioning a call).
    message?: string,
  ) {
    const body: AgencyActionErrorResponse = {
      error: status === 409 ? 'Conflict' : status === 403 ? 'Forbidden' : 'Validation failed',
      code,
      message: message ?? dispositionErrorMessage(code),
      ...(allowedCodes ? { allowed_codes: allowedCodes } : {}),
    };
    return reply.code(status).send(body);
  }

  /**
   * The attempt and its campaign, scoped to the caller's tenant/account.
   *
   * Scoped 404 rather than 403, matching every other resource route: whether an
   * attempt id exists in another tenant is not a fact this caller may learn.
   * That is distinct from `not_your_attempt`, which is a 403 *within* the
   * caller's own account and is the ownership rule's answer, not this one's.
   */
  async function requireOwnedAttempt(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    if (!(await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, { tenantId, accountId }))) {
      reply.code(403).send({
        error: 'Feature Not Enabled', code: 'feature_disabled',
        message: 'Agency dialer is not enabled for this account.',
      } satisfies AgencyActionErrorResponse);
      return null;
    }
    const attempt = await agencyAttemptRepository.findById(request.params.id);
    if (!attempt || attempt.tenant_id !== tenantId || attempt.account_id !== accountId) {
      reply.code(404).send({ error: 'Not Found', message: 'Attempt not found' });
      return null;
    }
    const campaign = await agencyCampaignRepository.findById(attempt.campaign_id);
    if (!campaign) {
      reply.code(404).send({ error: 'Not Found', message: 'Campaign not found' });
      return null;
    }
    return { attempt, campaign };
  }

  /**
   * The user id behind an attempt's reserved *session* id.
   *
   * `reserved_agent_id` is a session id and `agent_user_id` is a user id —
   * different kinds of id, and comparing them to each other would make the
   * ownership check reject everyone while looking correct.
   */
  async function resolveReservedAgentUserId(sessionId: string | null): Promise<string | null> {
    if (!sessionId) return null;
    const session = await agencyAgentSessionRepository.findById(sessionId);
    return session?.agent_user_id ?? null;
  }

  /**
   * The session named in the URL, if it belongs to this caller **and is still
   * live**.
   *
   * ── Why `left_at` is checked HERE and not per route ────────────────────────
   *
   * Checked per route, it is easy to miss one, and a session route that operates
   * on a left session produces a silently dead agent: `POST /sessions/:id/available`
   * would set the Redis lease and mirror `available` onto a row with `left_at` set,
   * so the console renders a ready agent and gets no error, while
   * `findLiveForCampaign` (which the pacing tick reads) excludes left rows and
   * never dials them. Nothing anywhere is red. `uq_agency_agent_live_tenant` makes that state
   * routine rather than exotic — the dedupe
   * closes sessions out from under whoever is holding them — so the guard belongs
   * on the shared path where a new route inherits it instead of having to
   * remember it.
   *
   * `409 session_ended` rather than `404`: the session is real and the caller may
   * legitimately have been on it a moment ago. The code already exists for exactly
   * this ("re-bootstrap rather than retrying") and the console already knows it.
   */
  async function requireOwnedSession(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    opts: { supervisorMayAct?: boolean } = {},
  ) {
    // Q8 (Manas, 2026-10-09): the session must be the CALLER's, not merely in the
    // caller's account. Checking tenant + account + `left_at` alone would let an agent
    // holding a colleague's session id mint that session's station token (opening and
    // superseding their station socket and receiving their next customer's audio), set
    // it available or on break, or make it leave. The public API layer sends the
    // authenticated actor exactly as it does for attempt actions (`resolveAgencyActor`:
    // `agent_user_id` is the session user, and `on_behalf` is set only for
    // `agency.supervise`; zod strips any client copy), and this guard enforces it:
    //  - no actor ⇒ 400 `missing_actor`, checked BEFORE the lookup so it says nothing
    //    about whether the id exists (unreachable through the public API layer, which
    //    always sends one);
    //  - not the session's agent ⇒ the SAME 404 as an id that does not exist in this
    //    account, so a non-owner learns nothing (and is checked before `left_at`, whose
    //    409 would otherwise confirm the session is real);
    //  - a supervisor (`on_behalf`) passes only where the route opts in. Of the session
    //    routes only `force-available` does: it is the one supervisory session action
    //    (the console's AgentFloor). station-token, available, break, break/cancel and
    //    leave are the agent's own presence; no flow lets a supervisor drive them for
    //    someone else, and a supervisor minting another agent's station token would be
    //    the same hijack this closes.
    const actor = (request.body ?? {}) as { agent_user_id?: unknown; on_behalf?: unknown };
    const actorUserId = typeof actor.agent_user_id === 'string' ? actor.agent_user_id.trim() : '';
    if (!actorUserId) {
      // The attempt routes' exact shape (`error: 'Validation failed'`), via their helper.
      sendActionError(reply, 400, 'missing_actor', undefined, 'The request did not identify which agent is acting on this session.');
      return null;
    }
    const session = await agencyAgentSessionRepository.findById(request.params.id);
    const actsOnIt = session
      ? session.agent_user_id === actorUserId || (opts.supervisorMayAct === true && actor.on_behalf === true)
      : false;
    if (!session || session.tenant_id !== getTenantId(request) || session.account_id !== getAccountId(request)
      || !actsOnIt) {
      reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      return null;
    }
    if (session.left_at) {
      const err: AgencyActionErrorResponse = {
        error: 'Session Ended', code: 'session_ended',
        message: 'This session has ended. Start a new one.',
      };
      reply.code(409).send(err);
      return null;
    }
    return session;
  }
}

/**
 * The instant a requested callback will actually be dialed.
 *
 * Falls back to the requested time in two cases, both deliberate. If the contact
 * row cannot be read, the campaign default zone applies — the same timezone
 * fallback the calling-hours gate uses. If the window has no next opening at all (an empty `calling_days`, a
 * `start == end` window, an unusable timezone) we return the request unchanged
 * rather than inventing a time: the pre-dial gate parks such a contact and is the
 * authority, and a fabricated instant here would be a second, quieter lie.
 */
async function resolveCallbackDialTime(
  campaign: AgencyCampaignRecord,
  contactId: string,
  requestedAt: Date,
): Promise<Date> {
  const contact = await agencyContactRepository.findById(contactId).catch(() => null);
  const window = resolveCallingWindow(campaign, { timezone: contact?.timezone ?? null });
  // Evaluated AT the requested instant, not now: the question is whether the
  // window is open when the agent promised, which for a callback is days away.
  if (callingWindowState(window, requestedAt) === 'open') return requestedAt;
  return nextWindowOpen(window, requestedAt) ?? requestedAt;
}
