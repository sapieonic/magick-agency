/*
 * The soft phone's internal handlers (docs/softphone.md §6), on the internal handler
 * instance under `/api/v1/agency` (decision B16): the soft-phone session, bootstrap, the
 * calls (place, details, hang up, outcome, DNC, list, detail, recording), the settings,
 * and the switch of a campaign session to the soft phone and back (§4.2). Part of
 * `agency.routes.ts`, inside its authenticated scope.
 *
 * The public routes (`../proxy-agency-softphone.routes.ts`) own RBAC, the
 * `agency_softphone_enabled` flag, body validation, enrichment and the audit rows; these
 * handlers own the runtime and repository calls and the refusal mapping
 * (`./softphone-answer.ts`). The actor arrives as the session routes' does: on a body
 * `agent_user_id` + `on_behalf` (`on_behalf` = the caller holds `agency.supervise`, which
 * the public layer derives from the role), on a GET `?actor_user_id=` + `?supervise=true`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SOFTPHONE_BREAK_REASON,
  type AgencyCallFieldValues,
  type AgencySoftphoneBootstrap,
  type AgencySoftphoneCampaign,
  type AgencySoftphoneProfileSummary,
  type AgencySoftphoneSessionResponse,
  type AgencySoftphoneSessionSummary,
  type AgencySoftphoneSettingsUpdateRequest,
} from '@magick-agency/contracts/agency';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { callAnalysisProfileRepository } from '@magick-agency/db/repositories/call-analysis-profile.repository';
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { createChildLogger } from '@magick-agency/observability';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import {
  agencyAgentSessionRepository,
  agencyCampaignRepository,
  agencyManualCallRepository,
  agencySoftphoneSettingsRepository,
  validateSoftphoneSettings,
} from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord, AgencyManualCallRecord } from '../../../db/models/agency.model.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import type { SoftphoneActor } from '../../../agency/softphone/types.js';
import { resolveManualCatalog } from '../../../agency/softphone/manual-disposition.js';
import { usableCallerIds } from '../../../agency/pacing/caller-id-pool.js';
import { callingWindowState } from '../../../agency/calling-hours.js';
import { defaultPhoneCountryCode } from '../../../utils/phone-normalizer.js';
import { formatWebRtcCallResponse } from '../../responses/webrtc-call.response.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { readKeysetCursor } from '../helpers/read-cursor.js';
import { SOFTPHONE_LIST_DEFAULT_LIMIT, softphoneListFilters, softphoneListQuerySchema } from '../helpers/softphone-list-query.js';
import { requireOwnedSession, sendActionError, STATION_INTERVALS } from './helpers.js';
import {
  sendSoftphoneRefusal,
  type SoftphoneCallActAudit,
  type SoftphoneCoreAnswer,
  type SoftphoneDispositionAudit,
  type SoftphoneDncAudit,
  type SoftphonePlaceAudit,
  type SoftphoneSettingsAudit,
  type SoftphoneSwitchAudit,
} from './softphone-answer.js';

const log = createChildLogger({ component: 'agency-softphone-routes' });

/** At most this many campaigns are offered as tags (a supervisor sees the whole account). */
const TAGGABLE_CAMPAIGNS_MAX = 500;

/** Where this instance serves a manual call's recording bytes (the public layer repoints it). */
export function softphoneRecordingPath(callId: string): string {
  return `/api/v1/agency/softphone/calls/${callId}/recording`;
}

// ─── The actor ──────────────────────────────────────────────────────────────

function refuseMissingActor(reply: FastifyReply): null {
  sendActionError(reply, 400, 'missing_actor', undefined, 'The request did not identify which agent is acting.');
  return null;
}

/** The body's actor (`agent_user_id`, `on_behalf`), as the session routes read it. */
function bodyActor(request: FastifyRequest, reply: FastifyReply): SoftphoneActor | null {
  const body = (request.body ?? {}) as { agent_user_id?: unknown; on_behalf?: unknown };
  const userId = typeof body.agent_user_id === 'string' ? body.agent_user_id : '';
  if (!UUID_RE.test(userId)) return refuseMissingActor(reply);
  return {
    tenantId: getTenantId(request),
    accountId: getAccountId(request),
    userId,
    supervise: body.on_behalf === true,
  };
}

/** A GET's actor (`?actor_user_id=`, `?supervise=true`). */
function queryActor(request: FastifyRequest, reply: FastifyReply): SoftphoneActor | null {
  const query = (request.query ?? {}) as { actor_user_id?: unknown; supervise?: unknown };
  const userId = typeof query.actor_user_id === 'string' ? query.actor_user_id : '';
  if (!UUID_RE.test(userId)) return refuseMissingActor(reply);
  return {
    tenantId: getTenantId(request),
    accountId: getAccountId(request),
    userId,
    supervise: query.supervise === 'true',
  };
}

/**
 * The two switch routes are SESSION routes, so they take the session routes' guard
 * (`requireOwnedSession`): the caller's own session in this tenant and account, else the
 * same 404 as an unknown id (decision Q8; no supervisor reach), and a left session is
 * 409 `session_ended`. The runtime re-checks ownership itself.
 */
async function ownSessionActor(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<SoftphoneActor | null> {
  const session = await requireOwnedSession(request, reply);
  if (!session) return null;
  return {
    tenantId: getTenantId(request), accountId: getAccountId(request), userId: session.agent_user_id, supervise: false,
  };
}

/** A call the actor may read: their own, or any in the account with `supervise`. Tenant- and account-scoped. */
async function visibleCall(callId: string, actor: SoftphoneActor): Promise<AgencyManualCallRecord | null> {
  const call = await agencyManualCallRepository.findById(callId, { tenantId: actor.tenantId, accountId: actor.accountId });
  if (!call) return null;
  return call.agent_user_id === actor.userId || actor.supervise ? call : null;
}

function answer<TAnswer, TAudit>(reply: FastifyReply, status: number, body: TAnswer, audit: TAudit): FastifyReply {
  const envelope: SoftphoneCoreAnswer<TAnswer, TAudit> = { answer: body, audit };
  return reply.code(status).send(envelope);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function profileSummaries(
  ids: ReadonlyArray<string | null>,
  tenantId: string,
  accountId: string,
): Promise<Map<string, AgencySoftphoneProfileSummary>> {
  const distinct = [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)))];
  const found = await Promise.all(distinct.map((id) =>
    callAnalysisProfileRepository.findByIdScoped(id, tenantId, accountId).catch(() => null)));
  const out = new Map<string, AgencySoftphoneProfileSummary>();
  for (const profile of found) if (profile) out.set(profile.id, { id: profile.id, name: profile.name });
  return out;
}

function taggableCampaign(
  campaign: AgencyCampaignRecord,
  profiles: Map<string, AgencySoftphoneProfileSummary>,
  now: Date,
): AgencySoftphoneCampaign {
  const window = {
    start: campaign.calling_window_start,
    end: campaign.calling_window_end,
    days: campaign.calling_days,
    timezone: campaign.default_timezone,
  };
  return {
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    status: campaign.status,
    caller_ids: usableCallerIds(campaign),
    disposition_catalog: resolveManualCatalog(campaign, true, { disposition_catalog: [] }).catalog,
    calling_window: window,
    calling_window_open: callingWindowState(window, now) === 'open',
    record_calls: campaign.record_calls,
    analysis_profile: campaign.analysis_profile_id ? profiles.get(campaign.analysis_profile_id) ?? null : null,
    context_display: campaign.context_display ?? {},
  };
}

async function buildBootstrap(runtime: AgencyRuntime, actor: SoftphoneActor): Promise<AgencySoftphoneBootstrap> {
  const { tenantId, accountId } = actor;
  const [settings, numbers, campaigns, staffed, live] = await Promise.all([
    agencySoftphoneSettingsRepository.get(tenantId, accountId),
    tenantPhoneAssignmentRepository.findAvailableForAccount(tenantId, accountId),
    agencyCampaignRepository.list(tenantId, accountId, TAGGABLE_CAMPAIGNS_MAX, 0),
    actor.supervise ? Promise.resolve(null) : agencyCampaignAgentRepository.listActiveForUser(tenantId, actor.userId),
    agencyAgentSessionRepository.findLiveForAgent(tenantId, actor.userId),
  ]);

  // The same rule as `SoftphoneService.taggable`: in the account, and staffed unless a supervisor.
  const staffedIds = staffed ? new Set(staffed.map((s) => s.campaign_id)) : null;
  const taggable = campaigns.rows.filter((c) => staffedIds === null || staffedIds.has(c.id));
  const profiles = await profileSummaries(
    [...taggable.map((c) => c.analysis_profile_id), settings.analysis_profile_id], tenantId, accountId,
  );
  const now = new Date();

  const callerIds = numbers
    .map((n) => n.phone_number)
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .map((n) => n.trim());
  // What an untagged dial with no caller ID uses (`selectCallerId`): the settings'
  // default while it is still one of the account's numbers, else the first.
  const defaultCallerId = settings.default_caller_id && callerIds.includes(settings.default_caller_id)
    ? settings.default_caller_id
    : callerIds[0] ?? null;

  let session: AgencySoftphoneSessionSummary | null = null;
  let call: AgencySoftphoneBootstrap['call'] = null;
  if (live && !live.left_at) {
    const [state, campaign] = await Promise.all([
      runtime.agents.get(live.id).catch(() => null),
      live.campaign_id ? agencyCampaignRepository.findById(live.campaign_id).catch(() => null) : Promise.resolve(null),
    ]);
    const liveState = state?.state ?? live.state;
    const pending = runtime.breaks.peek(live.id);
    session = {
      session_id: live.id,
      kind: live.kind,
      campaign_id: live.campaign_id,
      // Tenant-scoped, like the campaign join's conflict: the live session may be in
      // another account of this tenant, and its name is the agent's own context.
      campaign_name: campaign && campaign.tenant_id === live.tenant_id ? campaign.name : null,
      state: liveState,
      break_reason: live.break_reason,
      on_softphone: liveState === 'break' && live.break_reason === SOFTPHONE_BREAK_REASON,
      ...(pending ? { pending_state: 'break' as const, pending_break_reason: pending.code } : {}),
    };
    // The call is read only for a session in THIS account: a session in a sibling
    // account is named so the console can say where the agent is, nothing more.
    if (live.account_id === accountId) call = await runtime.softphone.getLiveForSession(live.id);
  }

  return {
    taggable_campaigns: taggable.map((c) => taggableCampaign(c, profiles, now)),
    untagged: {
      caller_ids: callerIds,
      default_caller_id: defaultCallerId,
      disposition_catalog: resolveManualCatalog(null, false, settings).catalog,
      record_calls: settings.record_calls,
      analysis_profile: settings.analysis_profile_id ? profiles.get(settings.analysis_profile_id) ?? null : null,
    },
    call_fields: settings.call_fields,
    default_country_code: `+${defaultPhoneCountryCode()}`,
    session,
    call,
  };
}

// ─── Settings ───────────────────────────────────────────────────────────────

const SETTINGS_KEYS = [
  'disposition_catalog', 'call_fields', 'analysis_profile_id', 'record_calls', 'default_caller_id',
] as const;

/** The body's problems: the shape (`validateSoftphoneSettings`), then the caller ID and the profile in this account. */
async function settingsIssues(
  body: unknown,
  tenantId: string,
  accountId: string,
): Promise<Array<{ path: string; message: string }>> {
  const issues = validateSoftphoneSettings(body);
  if (issues.length > 0) return issues;
  const settings = body as AgencySoftphoneSettingsUpdateRequest;
  if (settings.default_caller_id !== null) {
    const numbers = await tenantPhoneAssignmentRepository.findAvailableForAccount(tenantId, accountId);
    if (!numbers.some((n) => n.phone_number === settings.default_caller_id)) {
      issues.push({ path: 'default_caller_id', message: 'default_caller_id must be one of this account\'s numbers.' });
    }
  }
  if (settings.analysis_profile_id !== null) {
    const profile = await callAnalysisProfileRepository.findByIdScoped(settings.analysis_profile_id, tenantId, accountId);
    if (!profile || !profile.is_active) {
      issues.push({ path: 'analysis_profile_id', message: 'analysis_profile_id must be an active profile of this account.' });
    }
  }
  return issues;
}

// ─── The routes ─────────────────────────────────────────────────────────────

export async function registerSoftphoneRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── POST /softphone/sessions — open (or rehydrate) the caller's soft-phone session ──
  sub.post('/softphone/sessions', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const join = await agencyAgentSessionRepository.joinSoftphone({
      tenantId: actor.tenantId, accountId: actor.accountId, agentUserId: actor.userId, replicaId: runtime.replicaId,
    });
    if (!join.ok) {
      // Live on a campaign: the remedy is the switch on THAT session (§4.2), named here.
      // Name and state are best-effort, as on the campaign join's conflict: a failed
      // lookup must not turn an actionable 409 into a 500.
      const blocker = join.session;
      const [campaign, liveState] = await Promise.all([
        agencyCampaignRepository.findById(blocker.campaign_id).catch(() => null),
        runtime.agents.get(blocker.id).catch(() => null),
      ]);
      return sendSoftphoneRefusal(reply, {
        code: 'session_on_campaign',
        session_id: blocker.id,
        campaign_id: blocker.campaign_id,
        campaign_name: campaign && campaign.tenant_id === blocker.tenant_id ? campaign.name : 'another campaign',
        state: liveState?.state ?? blocker.state,
      });
    }
    const session = join.session;
    // Redis, or `break` — and for a soft-phone session always `break/soft_phone`, with
    // its unsettled call re-claimed (`rehydrateAgent`, docs/softphone.md §4.1 step 1).
    const state = await runtime.rehydrateAgent(session.id, session);
    const minted = await runtime.tokens.mint(session.id);
    const body: AgencySoftphoneSessionResponse = {
      session_id: session.id,
      kind: 'softphone',
      state,
      break_reason: SOFTPHONE_BREAK_REASON,
      station_ws_url: `/api/v1/agency/station/${session.id}?token=${minted.token}`,
      station_token_expires_at: minted.expiresAt.toISOString(),
      intervals: STATION_INTERVALS,
    };
    return reply.code(join.created ? 201 : 200).send(body);
  });

  // ── GET /softphone/bootstrap ──────────────────────────────────────────────
  sub.get('/softphone/bootstrap', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    return reply.send(await buildBootstrap(runtime, actor));
  });

  // ── POST /softphone/calls — place a call ──────────────────────────────────
  sub.post('/softphone/calls', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const body = request.body as {
      session_id?: unknown; to?: unknown; caller_id?: unknown; campaign_id?: unknown;
      fields?: AgencyCallFieldValues; overrides?: { dnc_note?: string; hours_note?: string };
    };
    if (typeof body.session_id !== 'string' || typeof body.to !== 'string') {
      return reply.code(400).send({ error: 'Validation failed', details: { session_id: 'required', to: 'required' } });
    }
    const placed = await runtime.softphone.placeCall(actor, {
      sessionId: body.session_id,
      to: body.to,
      ...(typeof body.caller_id === 'string' ? { callerId: body.caller_id } : {}),
      campaignId: typeof body.campaign_id === 'string' ? body.campaign_id : null,
      ...(body.fields !== undefined ? { fields: body.fields } : {}),
      ...(body.overrides !== undefined ? { overrides: body.overrides } : {}),
    });
    if (!placed.ok) return sendSoftphoneRefusal(reply, placed.refusal);
    const audit: SoftphonePlaceAudit = {
      session_id: placed.call.session_id,
      campaign_id: placed.call.tag?.campaign_id ?? null,
      dnc_override: placed.dncOverride ? { note: placed.dncOverride.note, entry_id: placed.dncOverride.entryId } : null,
      hours_override_note: placed.hoursOverrideNote,
    };
    return answer(reply, 201, placed.call, audit);
  });

  // ── GET /softphone/calls — the caller's calls, or the account's with supervise ──
  sub.get('/softphone/calls', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const { actor_user_id: _a, supervise: _s, ...raw } = (request.query ?? {}) as Record<string, unknown>;
    const parsed = softphoneListQuerySchema.safeParse(raw);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    const query = parsed.data;
    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;
    const limit = query.limit ?? SOFTPHONE_LIST_DEFAULT_LIMIT;
    const filters = softphoneListFilters(query);
    const scope = { tenantId: actor.tenantId, accountId: actor.accountId };
    if (!actor.supervise) {
      // An agent lists their own calls only; naming anyone else is a refusal, not an
      // empty page that would read as "they made no calls".
      if (query.agent_user_id && query.agent_user_id !== actor.userId) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You can list only your own soft-phone calls.' });
      }
      return reply.send(await agencyManualCallRepository.listForAgent({
        ...scope, agentUserId: actor.userId, filters, limit, ...(cursor ? { after: cursor } : {}),
      }));
    }
    return reply.send(await agencyManualCallRepository.listForAccount({
      ...scope,
      filters: { ...filters, ...(query.agent_user_id ? { agentUserId: query.agent_user_id } : {}) },
      limit,
      ...(cursor ? { after: cursor } : {}),
    }));
  });

  // ── GET /softphone/calls/:id — the call, its overrides and (supervise) its media leg ──
  // The media leg carries the recording, the transcript and the AI analysis, which are
  // `agency.supervise`'s even on the caller's own call, as a campaign call's are
  // (`rbac.ts`): an agent reads the call record (`call`, `overrides`, availability)
  // with `media: null`. The public route strips it too.
  sub.get<{ Params: { id: string } }>('/softphone/calls/:id', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    const row = await visibleCall(request.params.id, actor);
    if (!row) return sendSoftphoneRefusal(reply, { code: 'call_not_found' });
    const call = await runtime.manualDialer.wireFor(row);
    if (!call) return sendSoftphoneRefusal(reply, { code: 'call_not_found' });
    const media = row.webrtc_call_id
      ? await webrtcCallRepository.findByIdScoped(row.webrtc_call_id, actor.tenantId, actor.accountId, 'agency')
      : null;
    const shownMedia = actor.supervise && media ? formatWebRtcCallResponse(media, softphoneRecordingPath(row.id)) : null;
    return reply.send({
      call,
      overrides: {
        dnc_note: row.dnc_override_note,
        dnc_entry_id: row.dnc_override_entry_id,
        hours_note: row.hours_override_note,
      },
      media: shownMedia,
      call_availability: !row.webrtc_call_id ? 'never_placed' : media ? 'available' : 'purged',
    });
  });

  // ── GET /softphone/calls/:id/recording — the bytes, through the authenticated proxy ──
  // `agency.supervise` only, the caller's own call included (the detail's rule above;
  // the public route's floor is the same). The same refusals as the attempt's recording
  // (`call_purged`, `call_never_placed`, and the proxy's `No recording available`); the
  // carrier URL never reaches a client.
  sub.get<{ Params: { id: string } }>('/softphone/calls/:id/recording', async (request, reply) => {
    const actor = queryActor(request, reply);
    if (!actor) return reply;
    if (!actor.supervise) {
      // The RBAC refusal's body, as the public floor answers it.
      return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions. Required: agency.supervise' });
    }
    const row = await visibleCall(request.params.id, actor);
    if (!row) return sendSoftphoneRefusal(reply, { code: 'call_not_found' });
    const media = row.webrtc_call_id
      ? await webrtcCallRepository.findByIdScoped(row.webrtc_call_id, actor.tenantId, actor.accountId, 'agency')
      : null;
    if (!media) {
      const purged = row.webrtc_call_id !== null;
      return reply.code(404).send({
        error: 'Not Found',
        code: purged ? 'call_purged' : 'call_never_placed',
        message: purged ? 'The call for this soft-phone dial is no longer available' : 'No call was placed for this soft-phone dial',
      });
    }
    // Dynamic imports, as the attempt's recording route: keep the config-loading
    // modules out of this module's import graph.
    const { proxyCallRecording } = await import('../../../utils/recording-proxy.js');
    const { config } = await import('../../../config/index.js');
    return proxyCallRecording(media, request, reply, config.voicelinkRecording.allowedHosts);
  });

  // ── PATCH /softphone/calls/:id — call details and notes, last write wins ──
  sub.patch<{ Params: { id: string } }>('/softphone/calls/:id', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const body = request.body as { fields?: AgencyCallFieldValues; notes?: string };
    const updated = await runtime.softphone.updateDetails(actor, request.params.id, {
      ...(body.fields !== undefined ? { fields: body.fields } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    });
    if (!updated.ok) return sendSoftphoneRefusal(reply, updated.refusal);
    return reply.send(updated.call);
  });

  // ── POST /softphone/calls/:id/hangup ──────────────────────────────────────
  sub.post<{ Params: { id: string } }>('/softphone/calls/:id/hangup', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const hung = await runtime.softphone.hangup(actor, request.params.id);
    if (!hung.ok) return sendSoftphoneRefusal(reply, hung.refusal);
    const audit: SoftphoneCallActAudit = { on_behalf: hung.onBehalf, campaign_id: hung.call.tag?.campaign_id ?? null };
    return answer(reply, 200, hung.call, audit);
  });

  // ── POST /softphone/calls/:id/disposition — save the outcome ──────────────
  sub.post<{ Params: { id: string } }>('/softphone/calls/:id/disposition', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const body = request.body as { code?: unknown; notes?: string; callback_at?: string; fields?: AgencyCallFieldValues };
    if (typeof body.code !== 'string') {
      return reply.code(400).send({ error: 'Validation failed', details: { code: 'required' } });
    }
    const saved = await runtime.softphone.submitDisposition(actor, request.params.id, {
      code: body.code,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.callback_at !== undefined ? { callbackAt: body.callback_at } : {}),
      ...(body.fields !== undefined ? { fields: body.fields } : {}),
    });
    if (!saved.ok) return sendSoftphoneRefusal(reply, saved.refusal);
    const campaignId = saved.response.call.tag?.campaign_id ?? null;
    const audit: SoftphoneDispositionAudit = {
      on_behalf: saved.onBehalf,
      campaign_id: campaignId,
      disposition_code: saved.response.call.disposition_code ?? body.code,
      replay: saved.replay,
      dnc_entry: saved.dncEntry ? { ...saved.dncEntry, scope: campaignId ? 'campaign' : 'account' } : null,
    };
    return answer(reply, 200, saved.response, audit);
  });

  // ── POST /softphone/calls/:id/dnc — mark the dialled number Do Not Call ──
  sub.post<{ Params: { id: string } }>('/softphone/calls/:id/dnc', async (request, reply) => {
    const actor = bodyActor(request, reply);
    if (!actor) return reply;
    const body = request.body as { reason?: unknown };
    const marked = await runtime.softphone.markDnc(actor, request.params.id,
      typeof body.reason === 'string' ? { reason: body.reason } : {});
    if (!marked.ok) return sendSoftphoneRefusal(reply, marked.refusal);
    // The tag, for the audit row's campaign: the response names the scope, not the campaign.
    const row = await agencyManualCallRepository.findById(request.params.id, { tenantId: actor.tenantId, accountId: actor.accountId });
    const audit: SoftphoneDncAudit = {
      on_behalf: marked.onBehalf,
      campaign_id: row?.campaign_id ?? null,
      scope: marked.response.scope,
      dnc_recorded: marked.response.dnc_recorded,
      dnc_entry: marked.dncEntry ? { ...marked.dncEntry, scope: marked.response.scope } : null,
    };
    return answer(reply, 200, marked.response, audit);
  });

  // ── GET /softphone/settings ───────────────────────────────────────────────
  sub.get('/softphone/settings', async (request, reply) => {
    const settings = await agencySoftphoneSettingsRepository.get(getTenantId(request), getAccountId(request));
    return reply.send({ settings });
  });

  // ── PUT /softphone/settings — replace the account's settings ──────────────
  sub.put('/softphone/settings', async (request, reply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    const issues = await settingsIssues(request.body, tenantId, accountId);
    if (issues.length > 0) return sendSoftphoneRefusal(reply, { code: 'settings_invalid', details: issues });
    const next = request.body as AgencySoftphoneSettingsUpdateRequest;
    const before = await agencySoftphoneSettingsRepository.get(tenantId, accountId);
    const settings = await agencySoftphoneSettingsRepository.upsert(tenantId, accountId, {
      disposition_catalog: next.disposition_catalog,
      call_fields: next.call_fields,
      analysis_profile_id: next.analysis_profile_id,
      record_calls: next.record_calls,
      default_caller_id: next.default_caller_id,
    });
    const audit: SoftphoneSettingsAudit = {
      changed: SETTINGS_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(settings[key])),
    };
    return answer(reply, 200, { settings }, audit);
  });

  // ── POST /sessions/:id/softphone — switch a campaign session to the soft phone (§4.2) ──
  sub.post<{ Params: { id: string } }>('/sessions/:id/softphone', async (request, reply) => {
    const actor = await ownSessionActor(request, reply);
    if (!actor) return reply;
    const switched = await runtime.softphone.switchToSoftphone(request.params.id, actor);
    if (!switched.ok) return sendSoftphoneRefusal(reply, switched.refusal);
    const audit: SoftphoneSwitchAudit = {
      campaign_id: switched.campaignId, from_state: switched.fromState, queued: switched.queued, withdrawn: false,
      unchanged: switched.unchanged,
    };
    return answer(reply, 200, switched.response, audit);
  });

  // ── POST /sessions/:id/softphone/return — back to the campaign ────────────
  sub.post<{ Params: { id: string } }>('/sessions/:id/softphone/return', async (request, reply) => {
    const actor = await ownSessionActor(request, reply);
    if (!actor) return reply;
    const returned = await runtime.softphone.returnFromSoftphone(request.params.id, actor);
    if (!returned.ok) return sendSoftphoneRefusal(reply, returned.refusal);
    const audit: SoftphoneSwitchAudit = {
      campaign_id: returned.campaignId,
      from_state: returned.fromState,
      queued: false,
      // `returnFromSoftphone` answers the session's unchanged state when it withdrew a
      // switch still queued behind a call; only an ended break lands on `available`.
      withdrawn: returned.response.state !== 'available',
      unchanged: false,
    };
    log.debug({ sessionId: request.params.id, withdrawn: audit.withdrawn }, 'Soft-phone return');
    return answer(reply, 200, returned.response, audit);
  });
}
