import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_INBOUND_CONNECT_DELAY_MS,
  AGENCY_INBOUND_RING_MS,
  type AgencyDisposition,
  type AgencyInboundCall,
  type AgencyInboundCallCampaign,
  type AgencyInboundCallMatch,
  type AgencyInboundCatalogSource,
  type AgencyInboundDispositionSource,
  type AgencyInboundStickyReason,
} from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyAttemptRepository,
  agencyCallSettingsRepository,
  agencyCampaignRepository,
  agencyContactRepository,
  agencyInboundRouteRepository,
  REQUIRE_CAMPAIGN_OFF,
  type AgencyInboundCallRecord,
  type RequireCampaign,
} from '../../db/repositories/agency.repository.js';
// The pure row → wire projection the station panel's history uses too (from its leaf, as there).
import { projectPriorAttempt } from '../../db/repositories/agency/projections.js';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../../db/models/agency.model.js';
import { inboundOutcomeWindowMs } from './inbound-wrapup.js';
import { dispositionsWithKnownIcons } from '../station-tiles.js';

const log = createChildLogger({ component: 'agency-inbound-wire' });

/**
 * ─── AN INBOUND CALL AS THE AGENT'S PANEL RENDERS IT (`AgencyInboundCall`; docs/inbound.md §6) ───
 *
 * Two halves, so the offer frame can go out synchronously (IB1: the panel is on screen before any
 * audio, with no `await` between the reservation and the frame):
 *  - {@link loadInboundPanelContext}: everything the row does not carry, read ONCE (when the call
 *    queues, or for a finish route's answer): the route's name, the matched contact with its
 *    campaign's name, context display and prior attempts, and the outcome catalog (IQ10);
 *  - {@link inboundCallToWire}: pure, the spine row plus that context, for every frame.
 *
 * ── The catalog (IQ10, docs/inbound.md §6) ────────────────────────────────────────
 * A call matched to a campaign takes the CAMPAIGN's catalog, whatever the campaign's status now
 * (as the soft phone's `call_campaign`), stored as source `campaign`; an empty one (or a campaign
 * row gone) is the built-in catalog, still `campaign` (the soft phone's rule: a bridged call
 * always owes an outcome, so a catalog with no codes would leave it unsavable). An unmatched call
 * takes the route's catalog (`route`), or the built-in one when the route has none (`builtin`,
 * stored `route`).
 *
 * ── A call filed under a campaign its caller is not on (docs/call-log.md §5, CL4, CL12, CL20) ──
 * An unknown caller's call filed under a campaign (the route's campaign for unknown callers, or
 * one chosen at wrap-up; `campaign_id` set, `matched_campaign_id` NULL) takes THAT campaign's
 * catalog, shown as `campaign`, without the entries that ask for a promise to pay: there is no
 * contact to keep a promise on (the soft phone's `promise_needs_contact`, decided here once so
 * the panel never offers what the save would refuse). The route's own catalog is for a call with
 * no campaign at all. The outcome is still STORED `route`: `disposition_source` says `campaign`
 * exactly when the caller matched a campaign's list (0027's CHECK, kept as it is so an older
 * image's lapse write stays valid after a rollback); which campaign a filed call is under is on
 * the row (`campaign_id`, `campaign_source`).
 */

/** What the panel needs beside the spine row. */
export interface InboundPanelContext {
  route: { id: string; name: string } | null;
  match: AgencyInboundCallMatch | null;
  /** The campaign the call is filed under (`campaign_id`), named; null when it is under none. */
  campaign: AgencyInboundCallCampaign | null;
  /** The account's "Every call must belong to a campaign", as read with the panel (off when unread). */
  requireCampaign: RequireCampaign;
  catalogSource: AgencyInboundCatalogSource;
  catalog: AgencyDisposition[];
  /**
   * The caller's sticky candidates in rank order (the router's member-filtered list), so the
   * panel can name the reason of whichever of them took the call. Empty when not known (a finish
   * route's read): the row's own `sticky_user_id` / `sticky_reason` then decide.
   */
  stickyCandidates: ReadonlyArray<{ userId: string; reason: AgencyInboundStickyReason }>;
}

function nonEmpty(catalog: unknown): catalog is AgencyDisposition[] {
  return Array.isArray(catalog) && catalog.length > 0;
}

/**
 * The catalog an inbound call's outcome resolves against (see the header). `filed`: the call is
 * filed under a campaign its caller is not on (`campaign` null when that campaign's row is gone).
 */
export function resolveInboundCatalog(
  matched: boolean,
  campaign: Pick<AgencyCampaignRecord, 'disposition_catalog'> | null,
  route: { disposition_catalog: AgencyDisposition[] } | null,
  filed: { campaign: Pick<AgencyCampaignRecord, 'disposition_catalog'> | null } | null = null,
): { catalog: AgencyDisposition[]; source: AgencyInboundCatalogSource; stored: AgencyInboundDispositionSource } {
  if (matched) {
    return {
      catalog: nonEmpty(campaign?.disposition_catalog) ? campaign!.disposition_catalog : [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
      source: 'campaign',
      stored: 'campaign',
    };
  }
  if (filed) {
    const own = nonEmpty(filed.campaign?.disposition_catalog) ? filed.campaign!.disposition_catalog : [];
    const usable = own.filter((entry) => entry.requires_promise !== true);
    return {
      catalog: usable.length > 0 ? usable : [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
      source: 'campaign',
      stored: 'route',
    };
  }
  if (nonEmpty(route?.disposition_catalog)) return { catalog: route!.disposition_catalog, source: 'route', stored: 'route' };
  return { catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], source: 'builtin', stored: 'route' };
}

/**
 * Whether the account's "Every call must belong to a campaign" applies to `call` (CL19): the
 * setting is on and the call arrived at or after it was switched on. A call that began before
 * the switch may finish as it is.
 */
export function campaignRequiredFor(call: Pick<AgencyInboundCallRecord, 'arrived_at'>, required: RequireCampaign): boolean {
  if (!required.on) return false;
  return required.since === null || new Date(call.arrived_at).getTime() >= required.since.getTime();
}

/** The matched contact's earlier dials, lineage-scoped as the station panel's. Never throws. */
async function priorsFor(contact: AgencyContactRecord, callId: string) {
  try {
    const rows = await agencyAttemptRepository.findPriorForContactLineage(contact.root_contact_id ?? contact.id, callId);
    return rows.map(projectPriorAttempt);
  } catch (err) {
    log.warn({ err, contactId: contact.id }, 'Could not load prior attempts for an inbound call');
    return [];
  }
}

/**
 * Read what the panel needs beside the row (see the header). Never throws: a read that fails
 * leaves that part empty (no match shown, the built-in catalog), logged, so a caller is never
 * kept from an agent by a panel read.
 */
export async function loadInboundPanelContext(
  call: Pick<AgencyInboundCallRecord,
    'id' | 'tenant_id' | 'account_id' | 'route_id' | 'matched_contact_id' | 'matched_campaign_id' | 'campaign_id' | 'campaign_source'>,
  opts: { stickyCandidates?: ReadonlyArray<{ userId: string; reason: AgencyInboundStickyReason }> } = {},
): Promise<InboundPanelContext> {
  const safe = <T>(what: string, p: () => Promise<T>): Promise<T | null> => Promise.resolve().then(p).catch((err: unknown) => {
    log.warn({ err, inboundCallId: call.id, what }, 'Could not read part of an inbound call\'s panel');
    return null;
  });
  // The campaign the call is filed under, when it is not the match's (an unknown caller's).
  const filedId = call.campaign_id && call.campaign_id !== call.matched_campaign_id ? call.campaign_id : null;
  const [route, contact, campaign, filedRead, required] = await Promise.all([
    call.route_id ? safe('route', () => agencyInboundRouteRepository.findForCall(call.tenant_id, call.route_id!)) : null,
    call.matched_contact_id ? safe('contact', () => agencyContactRepository.findById(call.matched_contact_id!)) : null,
    call.matched_campaign_id ? safe('campaign', () => agencyCampaignRepository.findById(call.matched_campaign_id!)) : null,
    filedId ? safe('filed campaign', () => agencyCampaignRepository.findById(filedId)) : null,
    // Display only (the panel's "required" mark): the outcome's own check reads it again.
    call.account_id ? safe('call settings', () => agencyCallSettingsRepository.requireCampaign(call.tenant_id, call.account_id!)) : null,
  ]);
  const ownCampaign = campaign && campaign.tenant_id === call.tenant_id ? campaign : null;
  const filedCampaign = filedRead && filedRead.tenant_id === call.tenant_id ? filedRead : null;
  const filedUnder = call.campaign_id
    ? (call.campaign_id === call.matched_campaign_id ? ownCampaign : filedCampaign)
    : null;
  let match: AgencyInboundCallMatch | null = null;
  if (contact && contact.tenant_id === call.tenant_id && call.matched_campaign_id && contact.campaign_id === call.matched_campaign_id) {
    match = {
      contact_id: contact.id,
      campaign_id: contact.campaign_id,
      campaign_name: ownCampaign?.name ?? '',
      contact_state: contact.state,
      context: contact.context ?? {},
      context_display: ownCampaign?.context_display ?? {},
      prior_attempts: await priorsFor(contact, call.id),
    };
  }
  const { catalog, source } = resolveInboundCatalog(
    call.matched_campaign_id !== null, ownCampaign, route, filedId ? { campaign: filedCampaign } : null,
  );
  return {
    route: route ? { id: route.id, name: route.name } : null,
    match,
    campaign: call.campaign_id
      ? { campaign_id: call.campaign_id, campaign_name: filedUnder?.name ?? '', source: call.campaign_source ?? 'contact' }
      : null,
    requireCampaign: required ?? { ...REQUIRE_CAMPAIGN_OFF },
    catalogSource: source,
    catalog,
    stickyCandidates: opts.stickyCandidates ?? [],
  };
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/**
 * The panel row: the spine `call` with its `ctx`. `sessionAgentUserId` is the agent of the
 * session the call is offered to or connected with (the panel's `sticky.is_you` is about them,
 * whoever reads it). The call must have been offered (`session_id`); `connectDelayMs` dates
 * `connects_at` while it is on offer.
 */
export function inboundCallToWire(
  call: AgencyInboundCallRecord,
  ctx: InboundPanelContext,
  sessionAgentUserId: string | null,
  connectDelayMs: number = AGENCY_INBOUND_CONNECT_DELAY_MS,
): AgencyInboundCall {
  const offeredAt = call.offered_at ? new Date(call.offered_at) : null;
  const push = call.offer_channel === 'push';
  const waitedFrom = call.queued_at ?? call.arrived_at;
  const owed = call.state === 'ended' && call.bridged_at !== null && call.settled_at === null && call.ended_at !== null;
  const takerRank = sessionAgentUserId ? ctx.stickyCandidates.find((c) => c.userId === sessionAgentUserId) : undefined;
  const sticky = takerRank
    ? { reason: takerRank.reason, is_you: true }
    : call.sticky_user_id && call.sticky_reason
      ? { reason: call.sticky_reason, is_you: call.sticky_user_id === sessionAgentUserId }
      : null;
  return {
    id: call.id,
    session_id: call.session_id ?? '',
    state: call.state,
    outcome: call.outcome,
    from_e164: call.from_e164,
    to_e164: call.to_e164,
    route: ctx.route,
    caller_dnc: call.caller_dnc,
    sticky,
    match: ctx.match,
    // The row's own filing wins over a context read before it changed (a Change at wrap-up).
    campaign: call.campaign_id === (ctx.campaign?.campaign_id ?? null) ? ctx.campaign : null,
    // An unknown caller's campaign is a filing choice until the outcome is saved (CL4).
    campaign_changeable: call.matched_campaign_id === null && call.settled_at === null
      && call.state === 'ended' && call.bridged_at !== null,
    campaign_required: campaignRequiredFor(call, ctx.requireCampaign),
    catalog_source: ctx.catalogSource,
    // BE-13: an icon the contract does not list is dropped, never sent (`station-tiles.ts`).
    disposition_catalog: dispositionsWithKnownIcons(ctx.catalog),
    recording: call.recording_requested,
    waited_seconds: offeredAt ? Math.max(0, Math.floor((offeredAt.getTime() - new Date(waitedFrom).getTime()) / 1000)) : 0,
    offered_at: (offeredAt ?? new Date(call.arrived_at)).toISOString(),
    // Mode B (IQ66): a push offer has no `connects_at` (it binds once the app has accepted and its
    // station attached); its ring deadline stands until it is answered.
    connects_at: call.state === 'offered' && offeredAt && !push ? new Date(offeredAt.getTime() + connectDelayMs).toISOString() : null,
    // A row offered before Mode B's writers has no channel: a station's.
    offer_channel: call.offer_channel ?? (offeredAt ? 'station' : null),
    ring_expires_at: push && call.state === 'offered' && call.ringing_at && !call.accepted_at
      ? new Date(new Date(call.ringing_at).getTime() + AGENCY_INBOUND_RING_MS).toISOString()
      : null,
    accepted_at: push ? iso(call.accepted_at) : null,
    bridged_at: iso(call.bridged_at),
    ended_at: iso(call.ended_at),
    talk_seconds: call.state === 'ended' ? call.talk_seconds : null,
    // The route's window captured on the call (IQ52), the sweep's own rule (`inbound-wrapup.ts`).
    outcome_due_at: owed ? new Date(new Date(call.ended_at!).getTime() + inboundOutcomeWindowMs(call)).toISOString() : null,
    disposition_code: call.disposition_code,
    notes: call.notes,
    callback_at: iso(call.callback_at),
    promise_date: call.promise_date ?? null,
    promise_amount: call.promise_amount ?? null,
    dispositioned_by_user_id: call.dispositioned_by_user_id,
    dispositioned_on_behalf: call.dispositioned_on_behalf,
    settled_at: iso(call.settled_at),
  };
}
