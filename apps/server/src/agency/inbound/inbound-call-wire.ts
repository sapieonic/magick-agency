import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_INBOUND_CONNECT_DELAY_MS,
  AGENCY_INBOUND_RING_MS,
  type AgencyDisposition,
  type AgencyInboundCall,
  type AgencyInboundCallMatch,
  type AgencyInboundCatalogSource,
  type AgencyInboundDispositionSource,
  type AgencyInboundStickyReason,
} from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyAttemptRepository,
  agencyCampaignRepository,
  agencyContactRepository,
  agencyInboundRouteRepository,
  type AgencyInboundCallRecord,
} from '../../db/repositories/agency.repository.js';
// The pure row → wire projection the station panel's history uses too (from its leaf, as there).
import { projectPriorAttempt } from '../../db/repositories/agency/projections.js';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../../db/models/agency.model.js';
import { inboundOutcomeWindowMs } from './inbound-wrapup.js';

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
 */

/** What the panel needs beside the spine row. */
export interface InboundPanelContext {
  route: { id: string; name: string } | null;
  match: AgencyInboundCallMatch | null;
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

/** The catalog an inbound call's outcome resolves against (see the header). */
export function resolveInboundCatalog(
  matched: boolean,
  campaign: Pick<AgencyCampaignRecord, 'disposition_catalog'> | null,
  route: { disposition_catalog: AgencyDisposition[] } | null,
): { catalog: AgencyDisposition[]; source: AgencyInboundCatalogSource; stored: AgencyInboundDispositionSource } {
  if (matched) {
    return {
      catalog: nonEmpty(campaign?.disposition_catalog) ? campaign!.disposition_catalog : [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
      source: 'campaign',
      stored: 'campaign',
    };
  }
  if (nonEmpty(route?.disposition_catalog)) return { catalog: route!.disposition_catalog, source: 'route', stored: 'route' };
  return { catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], source: 'builtin', stored: 'route' };
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
  call: Pick<AgencyInboundCallRecord, 'id' | 'tenant_id' | 'route_id' | 'matched_contact_id' | 'matched_campaign_id'>,
  opts: { stickyCandidates?: ReadonlyArray<{ userId: string; reason: AgencyInboundStickyReason }> } = {},
): Promise<InboundPanelContext> {
  const safe = <T>(what: string, p: () => Promise<T>): Promise<T | null> => Promise.resolve().then(p).catch((err: unknown) => {
    log.warn({ err, inboundCallId: call.id, what }, 'Could not read part of an inbound call\'s panel');
    return null;
  });
  const [route, contact, campaign] = await Promise.all([
    call.route_id ? safe('route', () => agencyInboundRouteRepository.findForCall(call.tenant_id, call.route_id!)) : null,
    call.matched_contact_id ? safe('contact', () => agencyContactRepository.findById(call.matched_contact_id!)) : null,
    call.matched_campaign_id ? safe('campaign', () => agencyCampaignRepository.findById(call.matched_campaign_id!)) : null,
  ]);
  const ownCampaign = campaign && campaign.tenant_id === call.tenant_id ? campaign : null;
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
  const { catalog, source } = resolveInboundCatalog(call.matched_campaign_id !== null, ownCampaign, route);
  return {
    route: route ? { id: route.id, name: route.name } : null,
    match,
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
    catalog_source: ctx.catalogSource,
    disposition_catalog: ctx.catalog,
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
    dispositioned_by_user_id: call.dispositioned_by_user_id,
    dispositioned_on_behalf: call.dispositioned_on_behalf,
    settled_at: iso(call.settled_at),
  };
}
