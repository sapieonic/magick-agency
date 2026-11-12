/*
 * Shared by the session and attempt handlers: the retry banner, the advertised station
 * intervals, the action-error reply, the session and attempt ownership checks, the
 * callback dial time, and the account name a live-session refusal carries. Part of
 * `agency.routes.ts`.
 */
import type { AwayRingService } from '../../../agency/away-ring.js';
import { AWAY_RING_BREAK_REASON, DEVICE_AWAY_BREAK_REASON } from '@magick-agency/contracts/agency';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getTenantId, getAccountId } from '../../middleware/auth.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import {
  agencyAgentSessionRepository,
  agencyAttemptRepository,
  agencyCampaignRepository,
  agencyContactRepository,
} from '../../../db/repositories/agency.repository.js';
import { dispositionErrorMessage } from '../../../agency/disposition.js';
import type { AgencyAgentSessionRecord, AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { AGENT_LEASE_MS } from '../../../agency/agent-state-machine.js';
import { StationTokenUnavailableError, type StationTokenStore } from '../../../agency/station-token.js';
import { DEFERRED_HANGUP_MS, STATION_HEARTBEAT_GRACE_MS, stationHeartbeatGraceMs } from '@magick-agency/domain/timers';
import { resolveCallingWindow, scheduleCallbackInWindow } from '../../../agency/calling-hours.js';
import {
  AGENCY_STATION_DEVICE_ID_PATTERN,
  type AgencyActionErrorCode,
  type AgencyActionErrorResponse,
  type AgencyClientKind,
  type AgencyRetryContext,
  type AgencySessionInOtherTenantRefusal,
  type AgencyStationIntervals,
  type AgencyStationOnOtherDeviceRefusal,
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
export async function resolveRetryContext(
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
export const STATION_INTERVALS: AgencyStationIntervals = {
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

/** The mobile app's intervals: {@link STATION_INTERVALS} with the mobile heartbeat grace. */
const MOBILE_STATION_INTERVALS: AgencyStationIntervals = Object.freeze({
  ...STATION_INTERVALS,
  heartbeat_grace_ms: stationHeartbeatGraceMs('mobile'),
});

/**
 * The intervals a session is served, by the client kind its join named
 * (`client_kind` on the internal body, which the public API layer parses from
 * `X-Client`). Only `heartbeat_grace_ms` differs: a mobile station is held to the grace
 * the sweep enforces on it (`stationGraceFor`), from the same source. Anything that is
 * not exactly `mobile` is the web's, so a body without the field is unchanged.
 */
export function stationIntervalsFor(clientKind: unknown): AgencyStationIntervals {
  return clientKind === 'mobile' ? MOBILE_STATION_INTERVALS : STATION_INTERVALS;
}

/** A 4xx in the closed `AgencyActionErrorResponse` shape the public API layer passes through. */
export function sendActionError(
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
export async function requireOwnedAttempt(
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
export async function resolveReservedAgentUserId(sessionId: string | null): Promise<string | null> {
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
 * never dials them. Nothing anywhere is red. `uq_agency_agent_live_agent` makes that state
 * routine rather than exotic — the dedupe
 * closes sessions out from under whoever is holding them — so the guard belongs
 * on the shared path where a new route inherits it instead of having to
 * remember it.
 *
 * `409 session_ended` rather than `404`: the session is real and the caller may
 * legitimately have been on it a moment ago. The code already exists for exactly
 * this ("re-bootstrap rather than retrying") and the console already knows it.
 */
export async function requireOwnedSession(
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
export async function resolveCallbackDialTime(
  campaign: AgencyCampaignRecord,
  contactId: string,
  requestedAt: Date,
): Promise<Date> {
  const contact = await agencyContactRepository.findById(contactId).catch(() => null);
  const window = resolveCallingWindow(campaign, { timezone: contact?.timezone ?? null });
  return scheduleCallbackInWindow(window, requestedAt);
}

/**
 * The name of an account of this tenant, for a refusal that names where the agent's
 * live session is (`session_on_softphone`, `session_on_campaign`: one live session per
 * agent per tenant, so it may be in a sibling account). Best-effort, as the
 * conflicting campaign's name is: a failed read is NULL and the refusal still carries
 * `account_id`, never a 500 in place of an actionable 409. Tenant-scoped
 * (`findByIdInTenant`), so a corrupt row can never name another tenant's account.
 */
export async function accountNameInTenant(accountId: string, tenantId: string): Promise<string | null> {
  try {
    return (await accountRepository.findByIdInTenant(accountId, tenantId))?.name ?? null;
  } catch (err) {
    log.warn({ err, accountId }, 'Could not resolve the live session\'s account name');
    return null;
  }
}

/**
 * Mint a station token for a route's response, or answer `503 station_token_unavailable`
 * when it cannot be stored (D9): null means the reply has been sent. Both clients retry a
 * 503 (the console's re-mint, the app's retry ladder).
 */
export async function mintStationTokenOr503(
  runtime: { tokens: StationTokenStore },
  sessionId: string,
  reply: FastifyReply,
): Promise<{ token: string; expiresAt: Date } | null> {
  try {
    return await runtime.tokens.mint(sessionId);
  } catch (err) {
    if (!(err instanceof StationTokenUnavailableError)) throw err;
    await reply.code(503).send({
      error: 'Service Unavailable', code: 'station_token_unavailable', message: 'Try again in a moment.',
    });
    return null;
  }
}

// ─── One station per agent (OS1, OS3; contracts `agency/station-device.ts`) ─────────────

/** The device of one join, soft-phone open or token mint, as {@link stationDeviceFields} reads it. */
export interface StationDevice {
  deviceId: string | null;
  takeOver: boolean;
}

/**
 * The device fields of a join, a soft-phone open or a token mint, read from the internal body.
 * The public layer has already validated them (`stationDeviceSchema`); a malformed value here
 * (an internal caller) is treated as absent, which is an older client's behaviour, never a 500.
 * `take_over` without a device id means nothing.
 */
export function stationDeviceFields(body: unknown): StationDevice {
  const b = (body ?? {}) as { device_id?: unknown; take_over?: unknown };
  const deviceId = typeof b.device_id === 'string' && AGENCY_STATION_DEVICE_ID_PATTERN.test(b.device_id) ? b.device_id : null;
  return { deviceId, takeOver: deviceId !== null && b.take_over === true };
}

/**
 * The read-only pre-check of a join or a soft-phone open (OS3): when the agent's live session in
 * this tenant is the one the request would rehydrate (`isSameSession`) and another device holds its
 * station, and the request named a device without taking over, answer 409
 * `station_on_other_device` BEFORE the upsert writes anything. True: refused (the reply is sent;
 * a boolean, not the reply, which is a thenable an async return would unwrap). The claim after the
 * upsert ({@link claimStationOrReply}) is the atomic check; this only spares a refused join its
 * writes, and reads nothing when the request cannot be refused (no device, or a take-over).
 */
export async function refuseIfHeldElsewhere(
  reply: FastifyReply,
  tenantId: string,
  agentUserId: string,
  device: StationDevice,
  isSameSession: (live: AgencyAgentSessionRecord) => boolean,
): Promise<boolean> {
  if (device.deviceId === null || device.takeOver) return false;
  const live = await agencyAgentSessionRepository.findLiveForAgent(tenantId, agentUserId);
  if (!live || !isSameSession(live)) return false;
  if (live.station_device_id === null || live.station_device_id === device.deviceId) return false;
  await sendStationOnOtherDevice(reply, live.id, live.client_kind);
  return true;
}

/**
 * OS3: claim `session`'s station for this device (`claimStationDevice`), or answer the refusal:
 * 409 `station_on_other_device` when another device holds it, `onGone` when the session has left.
 * True: this device holds it, go on. Every route that rehydrates a session or mints its station
 * token claims first, before the rehydrate and the mint, so a refused request neither seeds Redis
 * nor replaces the holder's token. `reconnect`: a token mint, where a request naming no device is
 * refused while one holds the station.
 *
 * `session` is the row as the route just read or wrote it: when it already names this device (or
 * names none and none was sent), the claim would write nothing, so no statement runs.
 */
export async function claimStationOrReply(
  reply: FastifyReply,
  session: Pick<AgencyAgentSessionRecord, 'id' | 'station_device_id'> & Partial<Pick<AgencyAgentSessionRecord, 'agent_user_id' | 'break_reason'>>,
  device: StationDevice,
  options: {
    reconnect?: boolean;
    onGone: () => FastifyReply | Promise<FastifyReply>;
    /**
     * Mode B (IQ67, M5): told when the claim moved the station off a device the session was ringing
     * (`claimStationDevice`'s `endedAwayRing`), so Redis's `ring` is cleared and the old device gets
     * `ring_off` (`taken_over`). The campaign join and the token mint pass the runtime's.
     */
    awayRing?: Pick<AwayRingService, 'endOnTakeOver'>;
  },
): Promise<boolean> {
  if (session.station_device_id === device.deviceId) return true;
  const claim = await agencyAgentSessionRepository.claimStationDevice(
    session.id, device, { reconnect: options.reconnect ?? false });
  if (claim.ok && claim.endedAwayRing) {
    // The row the route holds was read before the claim rewrote it: the bootstrap words the break
    // from it (`breakReasonFor`), and the agent is no longer on `away_ring`.
    if (session.break_reason === AWAY_RING_BREAK_REASON) session.break_reason = DEVICE_AWAY_BREAK_REASON;
    if (options.awayRing && session.agent_user_id) {
      await options.awayRing.endOnTakeOver(session.id, session.agent_user_id, claim.endedAwayRing.previousDeviceId)
        .catch((err: unknown) => log.warn({ err, sessionId: session.id }, 'Could not end away-ring on a take-over'));
    }
  }
  if (claim.ok) return true;
  if (claim.reason === 'held_elsewhere') await sendStationOnOtherDevice(reply, session.id, claim.client_kind);
  else await options.onGone();
  return false;
}

/** 409 `station_on_other_device` (OS3): another device holds the session's station. */
export function sendStationOnOtherDevice(
  reply: FastifyReply,
  sessionId: string,
  clientKind: AgencyClientKind,
): FastifyReply {
  const refusal: AgencyStationOnOtherDeviceRefusal = {
    error: 'Conflict',
    code: 'station_on_other_device',
    message: clientKind === 'mobile'
      ? 'Your station is open on your phone. Use it there, or take it over here.'
      : 'Your station is open on another device. Use it there, or take it over here.',
    session_id: sessionId,
    client_kind: clientKind,
  };
  return reply.code(409).send(refusal);
}

/**
 * 409 `session_in_other_tenant` (OS1): the agent is live in another tenant. Names only the tenant
 * (the agent's own membership); the tenant name is best effort.
 */
export async function sendSessionInOtherTenant(reply: FastifyReply, tenantId: string): Promise<FastifyReply> {
  const tenantName = await tenantRepository.findById(tenantId)
    .then((t) => t?.name ?? null)
    .catch((err: unknown) => {
      log.warn({ err, tenantId }, 'Could not resolve the live session\'s tenant name');
      return null;
    });
  const refusal: AgencySessionInOtherTenantRefusal = {
    error: 'Conflict',
    code: 'session_in_other_tenant',
    message: tenantName
      ? `You are live in ${tenantName}. Leave your station there first: an agent can hold only one live station at a time.`
      : 'You are live in another organisation. Leave your station there first: an agent can hold only one live station at a time.',
    tenant_id: tenantId,
    tenant_name: tenantName,
  };
  return reply.code(409).send(refusal);
}

/**
 * The part of the runtime {@link endIdleSessionElsewhere} reads: the same signals the agent's own
 * `leave` checks, plus station presence across processes.
 */
interface IdleSessionRuntime {
  stations: {
    stationPresence(sessionId: string): Promise<'connected' | 'absent' | 'unknown'>;
    detach(sessionId: string): Promise<unknown> | unknown;
  };
  agents: {
    get(sessionId: string): Promise<{ state: string } | null>;
    clear(sessionId: string): Promise<unknown>;
  };
  dialer: { hasLiveAttempt(sessionId: string): boolean; hasRedialInFlight(sessionId: string): boolean };
  softphone: { hasLiveCall(sessionId: string): boolean };
  inbound?: { findCallForSession(sessionId: string): unknown } | null;
}

/**
 * OS7: end the agent's session in ANOTHER tenant when nothing is there: no station attached in any
 * process (`stationPresence` says `absent`; `unknown` keeps it), no lease beyond `offline` /
 * `break` (no reservation, call or wrap-up), and no live campaign attempt, redial being set up,
 * soft-phone call or inbound call. Then it is left exactly as the agent's own `leave` leaves it
 * (lease cleared, row left, station detached), and the caller retries its join.
 *
 * Why: one live session per agent across tenants (OS1) would otherwise let a session forgotten in a
 * tenant (a laptop closed without Leave, a membership since revoked, the dialler since switched
 * off there) lock the agent out of every other tenant, with nothing in this one able to end it.
 * A session that is working (a station attached, or anything in flight) is never ended from
 * here: the join is refused `session_in_other_tenant` as before.
 *
 * Total: any read or write that fails leaves the session alone (false).
 */
export async function endIdleSessionElsewhere(
  runtime: IdleSessionRuntime,
  session: Pick<AgencyAgentSessionRecord, 'id' | 'tenant_id'>,
  leave: (sessionId: string) => Promise<void> = (id) => agencyAgentSessionRepository.leave(id),
): Promise<boolean> {
  try {
    const id = session.id;
    if (runtime.dialer.hasLiveAttempt(id) || runtime.dialer.hasRedialInFlight(id)) return false;
    if (runtime.softphone.hasLiveCall(id) || runtime.inbound?.findCallForSession(id)) return false;
    if ((await runtime.stations.stationPresence(id)) !== 'absent') return false;
    const lease = await runtime.agents.get(id);
    if (lease && lease.state !== 'offline' && lease.state !== 'break') return false;
    await runtime.agents.clear(id);
    await leave(id);
    await runtime.stations.detach(id);
    log.info({ sessionId: id, tenantId: session.tenant_id },
      'Ended an idle session in another tenant so the agent can join here (OS7)');
    return true;
  } catch (err) {
    log.warn({ err, sessionId: session.id }, 'Could not end an idle session in another tenant — refusing the join');
    return false;
  }
}

/**
 * A join or soft-phone open (`join`), retried once when the only thing in the way was an idle
 * session in another tenant that {@link endIdleSessionElsewhere} ended (OS7). Any other result,
 * an `other_tenant` refusal included, is returned as it came.
 */
export async function joinEndingIdleElsewhere<R extends { ok: boolean }>(
  runtime: IdleSessionRuntime,
  join: () => Promise<R>,
): Promise<R> {
  const first = await join();
  const refused = first as { ok: boolean; reason?: string; session?: Pick<AgencyAgentSessionRecord, 'id' | 'tenant_id'> };
  if (!refused.ok && refused.reason === 'other_tenant' && refused.session
    && await endIdleSessionElsewhere(runtime, refused.session)) {
    return join();
  }
  return first;
}
