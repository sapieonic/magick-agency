/**
 * The customer-history answer, assembled from the rows the repository read
 * (`docs/customer-history.md` §3 the summary, §4 the timeline). PURE: no I/O. The rows are already
 * scoped to the visible accounts in SQL (CH2); this file applies what is shown of each row (CH8),
 * groups retry chains (CH7), judges callbacks and recordings, merges every source into one
 * timeline in one order, filters it and cuts pages from it.
 *
 * ── Why the merge is here and not in SQL ─────────────────────────────────────────
 * Every source is read whole for the ONE number (each read an exact-match index probe,
 * CH9), because three things on a page need rows the page itself does not show: a callback's
 * status is judged by the NEXT call placed to the number, a redial names its chain's FIRST
 * attempt, and the summary's totals and filter options cover every call. With every row in hand
 * the order (`at DESC, key DESC`) is one comparison over one list, so a page never skips or
 * repeats an entry, whatever the filters, and entries sharing one instant to the microsecond are
 * split by `key` alone.
 */
import type {
  CustomerCallbackStatus,
  CustomerHistoryCampaign,
  CustomerHistoryContact,
  CustomerHistoryDncEntry,
  CustomerHistoryField,
  CustomerHistoryLiveCall,
  CustomerHistoryOpenCallback,
  CustomerHistoryOpenOverride,
  CustomerHistorySummary,
  CustomerHistoryUser,
  CustomerRecordingState,
  CustomerTimelineChannel,
  CustomerTimelineEntry,
  CustomerTimelinePage,
} from '@magick-agency/contracts/api/agency/customer-history';
import type { AgencyAttemptOutcome, AgencyCampaignStatus, AgencyContactState } from '@magick-agency/contracts/agency';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { DncSource } from '@magick-agency/contracts/api/agency/dnc';
import type {
  CustomerHistoryAttemptRow,
  CustomerHistoryCampaignRow,
  CustomerHistoryContactRow,
  CustomerHistoryDncRow,
  CustomerHistoryManualCallRow,
  CustomerHistoryUploadRow,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes, heroColumns } from '../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { dncEntryScope } from '../dnc-registry.js';
import { userIdOf } from '../insights/shared.js';
import { encodeTimelineCursor, isAfter, compareTimeline, toWireInstant, type TimelinePosition } from './cursor.js';
import type { TimelineFilter } from './requests.js';
import {
  canOpenCallPage,
  canSeeCallNotes,
  canSeeDncDetail,
  type CustomerHistoryViewer,
} from './visibility.js';

/** A callback is kept when the next call is placed by its time plus this (inclusive; insights IN4). */
export const CALLBACK_ON_TIME_MS = 15 * 60_000;
/** Columns of a row shown when its campaign names no hero columns. */
export const FALLBACK_FIELD_COUNT = 4;

/** Everything one number's history is built from. */
export interface CustomerHistoryData {
  now: Date;
  viewer: CustomerHistoryViewer;
  contacts: readonly CustomerHistoryContactRow[];
  campaigns: ReadonlyMap<string, CustomerHistoryCampaignRow>;
  attempts: readonly CustomerHistoryAttemptRow[];
  manualCalls: readonly CustomerHistoryManualCallRow[];
  dnc: readonly CustomerHistoryDncRow[];
  /** Media legs that still exist (`agency_calls`), by id. */
  mediaLegs: ReadonlyMap<string, { recording_url: string | null }>;
  uploads: readonly CustomerHistoryUploadRow[];
  /** Display names by user id (NULL when unresolved). */
  names: ReadonlyMap<string, string | null>;
}

/** One timeline entry with what the order and the filters read. */
export interface TimelineItem extends TimelinePosition {
  entry: CustomerTimelineEntry;
  /** The entry's root campaign (CH7), NULL when it has none (an untagged call, a tenant DNC entry). */
  root: string | null;
  /** A call entry's facts for the call-only filters; NULL for the other kinds. */
  call: { channel: CustomerTimelineChannel; outcome: string | null; code: string | null; agent: string | null } | null;
}

// ─── Small pieces ────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function userOf(id: string | null | undefined, names: ReadonlyMap<string, string | null>): CustomerHistoryUser | null {
  if (!id) return null;
  return { user_id: id, name: names.get(id) ?? null };
}

export function campaignWire(row: CustomerHistoryCampaignRow): CustomerHistoryCampaign {
  return {
    id: row.id,
    name: row.name,
    status: row.status as AgencyCampaignStatus,
    account_id: row.account_id,
    root_id: row.root_id,
    retry_generation: row.retry_generation,
  };
}

/**
 * The recording state (§4): `no_call` with no media leg, `expired` when retention purged the leg
 * (its `agency_calls` row is gone), `available` when the leg has a recording, else `not_recorded`.
 */
export function recordingState(
  webrtcCallId: string | null,
  legs: ReadonlyMap<string, { recording_url: string | null }>,
): CustomerRecordingState {
  if (!webrtcCallId) return 'no_call';
  const leg = legs.get(webrtcCallId);
  if (!leg) return 'expired';
  return leg.recording_url ? 'available' : 'not_recorded';
}

/**
 * Whether a booked callback was kept (§4): the next call placed to the number after the booking.
 * Placed by `due + 15 min` (inclusive, an early call included) → `kept`; later → `late`; none
 * yet: `upcoming` before `due`, `due` within 15 minutes after it, `missed` past that.
 *
 * @param placed every placed call to the number (`dialed_at`), the booking call among them
 */
export function callbackStatus(input: {
  bookingCallId: string;
  bookedAtMs: number;
  dueAtMs: number;
  placed: ReadonlyArray<{ id: string; dialedAtMs: number }>;
  nowMs: number;
}): { status: CustomerCallbackStatus; dialledAtMs: number | null } {
  let next: number | null = null;
  for (const p of input.placed) {
    if (p.id === input.bookingCallId || p.dialedAtMs <= input.bookedAtMs) continue;
    if (next === null || p.dialedAtMs < next) next = p.dialedAtMs;
  }
  const deadline = input.dueAtMs + CALLBACK_ON_TIME_MS;
  if (next !== null) return { status: next <= deadline ? 'kept' : 'late', dialledAtMs: next };
  if (input.nowMs < input.dueAtMs) return { status: 'upcoming', dialledAtMs: null };
  if (input.nowMs <= deadline) return { status: 'due', dialledAtMs: null };
  return { status: 'missed', dialledAtMs: null };
}

/** The first attempt of a wrap-up redial chain: follow `redial_of_attempt_id` back as far as it is known. */
export function chainAttemptId(
  attempt: Pick<CustomerHistoryAttemptRow, 'id' | 'redial_of_attempt_id'>,
  byId: ReadonlyMap<string, Pick<CustomerHistoryAttemptRow, 'id' | 'redial_of_attempt_id'>>,
): string {
  let current = attempt;
  const seen = new Set<string>([current.id]);
  while (current.redial_of_attempt_id) {
    const prev = byId.get(current.redial_of_attempt_id);
    if (!prev || seen.has(prev.id)) return current.redial_of_attempt_id;
    seen.add(prev.id);
    current = prev;
  }
  return current.id;
}

const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim().length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
};

/** The row's hero columns (the campaign's `context_display.hero`), else its first columns. */
export function contactFields(context: Record<string, unknown> | null, campaign: CustomerHistoryCampaignRow | null): CustomerHistoryField[] {
  const ctx = context && typeof context === 'object' ? context : {};
  const hero = campaign ? heroColumns({ context_display: (campaign.context_display ?? {}) as AgencyCampaignRecord['context_display'] }) : [];
  const columns = hero.length > 0 ? hero : Object.keys(ctx).slice(0, FALLBACK_FIELD_COUNT);
  const out: CustomerHistoryField[] = [];
  for (const column of columns) {
    const value = cell(ctx[column]);
    if (value !== null) out.push({ column, value });
  }
  return out;
}

/** The campaign's real import whose run covers `at` (CH12 b), else null. */
export function uploadFileName(campaignId: string, at: Date, uploads: readonly CustomerHistoryUploadRow[], now: Date): string | null {
  const t = at.getTime();
  let best: CustomerHistoryUploadRow | null = null;
  for (const u of uploads) {
    if (u.campaign_id !== campaignId) continue;
    const start = (u.started_at ?? u.created_at).getTime();
    const end = (u.finished_at ?? now).getTime();
    if (t < start || t > end) continue;
    if (!best || (u.started_at ?? u.created_at).getTime() > (best.started_at ?? best.created_at).getTime()) best = u;
  }
  return best ? best.file_name : null;
}

/** The person who added a DNC entry: a user id resolved to a name; else the stored text (an import, an API key). */
function dncAddedBy(raw: string | null, names: ReadonlyMap<string, string | null>): string | null {
  if (raw === null) return null;
  const id = userIdOf(raw);
  if (id) return names.get(id) ?? null;
  return raw;
}

function dncEntry(row: CustomerHistoryDncRow, data: CustomerHistoryData): CustomerHistoryDncEntry {
  const detail = canSeeDncDetail(data.viewer, row.account_id);
  const campaign = row.campaign_id ? data.campaigns.get(row.campaign_id) ?? null : null;
  return {
    id: row.id,
    scope: dncEntryScope(row),
    account_id: row.account_id,
    account_name: row.account_id ? data.viewer.accounts.get(row.account_id)?.name ?? null : null,
    campaign: row.campaign_id ? { id: row.campaign_id, name: campaign?.name ?? null } : null,
    source: row.source as DncSource,
    reason: detail ? row.reason : null,
    added_by: detail ? dncAddedBy(row.added_by, data.names) : null,
    created_at: row.created_at.toISOString(),
  };
}

/** Every user id the answer names, for one name lookup. */
export function userIdsOf(data: Pick<CustomerHistoryData, 'contacts' | 'attempts' | 'manualCalls' | 'dnc'>): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => { if (id) ids.add(id); };
  for (const c of data.contacts) add(c.assigned_user_id);
  for (const a of data.attempts) { add(a.agent_user_id); add(a.dispositioned_by_user_id); }
  for (const m of data.manualCalls) { add(m.agent_user_id); add(m.dispositioned_by_user_id); }
  for (const d of data.dnc) add(userIdOf(d.added_by));
  return [...ids];
}

/** Every placed call to the number (either channel), for the callback judgement. */
function placedCalls(data: CustomerHistoryData): Array<{ id: string; dialedAtMs: number }> {
  const out: Array<{ id: string; dialedAtMs: number }> = [];
  for (const a of data.attempts) if (a.dialed_at) out.push({ id: a.id, dialedAtMs: a.dialed_at.getTime() });
  for (const m of data.manualCalls) if (m.dialed_at) out.push({ id: m.id, dialedAtMs: m.dialed_at.getTime() });
  return out;
}

// ─── The timeline ────────────────────────────────────────────────────────────

/** Every entry the caller can see, in the timeline's order (`at DESC, key DESC`). */
export function buildTimeline(data: CustomerHistoryData): TimelineItem[] {
  const { viewer, names, campaigns } = data;
  const items: TimelineItem[] = [];
  const attemptsById = new Map(data.attempts.map((a) => [a.id, a]));
  const placed = placedCalls(data);
  const nowMs = data.now.getTime();

  const pushCallback = (input: {
    channel: CustomerTimelineChannel; id: string; accountId: string; campaign: CustomerHistoryCampaignRow | null;
    callbackAt: Date; bookedAt: string; bookedBy: string | null;
  }) => {
    const judged = callbackStatus({
      bookingCallId: input.id,
      bookedAtMs: Date.parse(input.bookedAt),
      dueAtMs: input.callbackAt.getTime(),
      placed,
      nowMs,
    });
    const key = `callback:${input.id}`;
    items.push({
      at: input.bookedAt, key, root: input.campaign?.root_id ?? null, call: null,
      entry: {
        key, kind: 'callback', at: toWireInstant(input.bookedAt), account_id: input.accountId,
        source: { channel: input.channel, id: input.id },
        campaign: input.campaign ? campaignWire(input.campaign) : null,
        due_at: input.callbackAt.toISOString(),
        booked_by: userOf(input.bookedBy, names),
        status: judged.status,
        dialled_at: judged.dialledAtMs === null ? null : new Date(judged.dialledAtMs).toISOString(),
      },
    });
  };

  for (const a of data.attempts) {
    const campaign = campaigns.get(a.campaign_id);
    if (!campaign) continue;
    const showNotes = canSeeCallNotes(viewer, a.account_id, a.agent_user_id);
    const hadNotes = (a.notes !== null && a.notes.length > 0) || (a.override_note !== null && a.override_note.length > 0);
    const key = `campaign_call:${a.id}`;
    items.push({
      at: a.at, key, root: campaign.root_id,
      call: { channel: 'campaign', outcome: a.outcome, code: a.disposition_code, agent: a.agent_user_id },
      entry: {
        key, kind: 'campaign_call', at: toWireInstant(a.at), account_id: a.account_id,
        attempt_id: a.id,
        contact_id: a.contact_id,
        campaign: campaignWire(campaign),
        attempt_number: a.attempt_number,
        agent: userOf(a.agent_user_id, names),
        outcome: a.outcome as AgencyAttemptOutcome | null,
        disposition_code: a.disposition_code,
        talk_seconds: a.talk_seconds,
        notes: showNotes ? a.notes : null,
        notes_hidden: !showNotes && hadNotes,
        callback_at: iso(a.callback_at),
        redial_of_attempt_id: a.redial_of_attempt_id,
        chain_attempt_id: chainAttemptId(a, attemptsById),
        redial_number: a.redial_number,
        override_applied: a.override_applied,
        override_note: showNotes ? a.override_note : null,
        recording: recordingState(a.webrtc_call_id, data.mediaLegs),
        call_page: canOpenCallPage(viewer, a.account_id)
          ? { account_id: a.account_id, campaign_id: a.campaign_id, attempt_id: a.id }
          : null,
      },
    });
    if (a.callback_at) {
      pushCallback({
        channel: 'campaign', id: a.id, accountId: a.account_id, campaign, callbackAt: a.callback_at,
        bookedAt: a.booked_at, bookedBy: a.dispositioned_by_user_id ?? a.agent_user_id,
      });
    }
  }

  for (const m of data.manualCalls) {
    const campaign = m.campaign_id ? campaigns.get(m.campaign_id) ?? null : null;
    const showNotes = canSeeCallNotes(viewer, m.account_id, m.agent_user_id);
    const fields = m.fields && typeof m.fields === 'object' && !Array.isArray(m.fields) ? m.fields : {};
    const hadNotes = (m.notes !== null && m.notes.length > 0) || Object.keys(fields).length > 0
      || m.dnc_override_note !== null || m.hours_override_note !== null;
    const key = `softphone_call:${m.id}`;
    items.push({
      at: m.at, key, root: campaign?.root_id ?? null,
      call: { channel: 'softphone', outcome: m.outcome, code: m.disposition_code, agent: m.agent_user_id },
      entry: {
        key, kind: 'softphone_call', at: toWireInstant(m.at), account_id: m.account_id,
        manual_call_id: m.id,
        campaign: campaign ? campaignWire(campaign) : null,
        contact_id: m.contact_id,
        agent: userOf(m.agent_user_id, names),
        outcome: m.outcome as AgencyAttemptOutcome | null,
        disposition_code: m.disposition_code,
        talk_seconds: m.talk_seconds,
        notes: showNotes ? m.notes : null,
        notes_hidden: !showNotes && hadNotes,
        fields: showNotes ? (fields as Record<string, string | number | boolean | null>) : null,
        dnc_override_note: showNotes ? m.dnc_override_note : null,
        hours_override_note: showNotes ? m.hours_override_note : null,
        callback_at: iso(m.callback_at),
        recording: recordingState(m.webrtc_call_id, data.mediaLegs),
        call_page: canOpenCallPage(viewer, m.account_id) ? { account_id: m.account_id, manual_call_id: m.id } : null,
      },
    });
    if (m.callback_at) {
      pushCallback({
        channel: 'softphone', id: m.id, accountId: m.account_id, campaign, callbackAt: m.callback_at,
        bookedAt: m.booked_at, bookedBy: m.dispositioned_by_user_id ?? m.agent_user_id,
      });
    }
  }

  for (const d of data.dnc) {
    const campaign = d.campaign_id ? campaigns.get(d.campaign_id) ?? null : null;
    const key = `dnc_mark:${d.id}`;
    items.push({
      at: d.at, key, root: campaign?.root_id ?? null, call: null,
      entry: { key, kind: 'dnc_mark', at: toWireInstant(d.at), account_id: d.account_id, entry: dncEntry(d, data) },
    });
  }

  for (const c of data.contacts) {
    const campaign = campaigns.get(c.campaign_id);
    if (!campaign) continue;
    const key = `roster_entry:${c.id}`;
    items.push({
      at: c.at, key, root: campaign.root_id, call: null,
      entry: {
        key, kind: 'roster_entry', at: toWireInstant(c.at), account_id: c.account_id,
        contact_id: c.id,
        campaign: campaignWire(campaign),
        upload_file_name: uploadFileName(c.campaign_id, c.created_at, data.uploads, data.now),
      },
    });
  }

  return items.sort(compareTimeline);
}

/** The entries the filters keep (§4 "Filters"). */
export function filterTimeline(items: readonly TimelineItem[], f: TimelineFilter): TimelineItem[] {
  return items.filter((item) => {
    if (f.campaignRoots && (item.root === null || !f.campaignRoots.has(item.root))) return false;
    if (f.fromAt && item.at < f.fromAt) return false;
    if (f.toAt && item.at >= f.toAt) return false;
    if (!f.callsOnly) return true;
    const call = item.call;
    if (!call) return false;
    if (f.channel && call.channel !== f.channel) return false;
    if (f.connectedOnly && call.outcome !== 'connected') return false;
    if (f.outcomes && (call.outcome === null || !f.outcomes.has(call.outcome))) return false;
    if (f.dispositionCodes && (call.code === null || !f.dispositionCodes.has(call.code))) return false;
    if (f.agentUserIds && (call.agent === null || !f.agentUserIds.has(call.agent))) return false;
    return true;
  });
}

/** One page: every entry strictly after `cursor`, at most `limit`, and the cursor of the next. */
export function pageTimeline(items: readonly TimelineItem[], cursor: TimelinePosition | null, limit: number): CustomerTimelinePage {
  const after = cursor ? items.filter((i) => isAfter(i, cursor)) : items;
  const page = after.slice(0, limit);
  const last = page[page.length - 1];
  return {
    entries: page.map((i) => i.entry),
    next_cursor: after.length > limit && last ? encodeTimelineCursor({ at: last.at, key: last.key }) : null,
  };
}

// ─── The summary ─────────────────────────────────────────────────────────────

const byCreatedDesc = (a: CustomerHistoryContactRow, b: CustomerHistoryContactRow) =>
  (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const isLiveCallState = (state: string) => state !== 'ended';
const isLiveContactState = (state: string) => state === 'in_flight' || state === 'connected';

export function buildSummary(data: CustomerHistoryData): CustomerHistorySummary {
  const { viewer, names, campaigns } = data;

  // CH7: one row per retry chain (`root_contact_id`).
  const chains = new Map<string, CustomerHistoryContactRow[]>();
  for (const c of data.contacts) {
    if (!campaigns.has(c.campaign_id)) continue;
    const list = chains.get(c.root_contact_id) ?? [];
    list.push(c);
    chains.set(c.root_contact_id, list);
  }
  const placedByContact = new Map<string, number>();
  for (const a of data.attempts) {
    if (a.dialed_at) placedByContact.set(a.contact_id, (placedByContact.get(a.contact_id) ?? 0) + 1);
  }

  const contacts: Array<CustomerHistoryContact & { _at: string; _id: string }> = [];
  for (const [rootId, rows] of chains) {
    const ordered = [...rows].sort(byCreatedDesc);
    const newest = ordered[0]!;
    const oldest = ordered[ordered.length - 1]!;
    const campaign = campaigns.get(newest.campaign_id)!;
    const chainCampaigns = [...new Map(ordered.map((r) => [r.campaign_id, campaigns.get(r.campaign_id)!])).values()]
      .sort((a, b) => a.retry_generation - b.retry_generation || (a.id < b.id ? -1 : 1))
      .map(campaignWire);
    contacts.push({
      _at: newest.at, _id: newest.id,
      contact_id: newest.id,
      root_contact_id: rootId,
      account_id: newest.account_id,
      account_name: viewer.accounts.get(newest.account_id)?.name ?? null,
      phone_e164: newest.phone_e164,
      campaign: campaignWire(campaign),
      campaigns: chainCampaigns,
      state: newest.state as AgencyContactState,
      suppressed_reason: newest.suppressed_reason,
      attempt_count: ordered.reduce((n, r) => n + (placedByContact.get(r.id) ?? 0), 0),
      fields: contactFields(newest.context, campaign),
      assigned_to: userOf(newest.assigned_user_id, names),
      entered_at: oldest.created_at.toISOString(),
      upload_file_name: uploadFileName(oldest.campaign_id, oldest.created_at, data.uploads, data.now),
    });
  }
  contacts.sort((a, b) => (a._at < b._at ? 1 : a._at > b._at ? -1 : a._id < b._id ? 1 : -1));

  // Totals: calls placed (either channel), connected, the newest placed call.
  type Placed = { at: Date; channel: CustomerTimelineChannel; agent: string | null; outcome: string | null; code: string | null; id: string };
  const placed: Placed[] = [];
  for (const a of data.attempts) {
    if (a.dialed_at && campaigns.has(a.campaign_id)) {
      placed.push({ at: a.dialed_at, channel: 'campaign', agent: a.agent_user_id, outcome: a.outcome, code: a.disposition_code, id: a.id });
    }
  }
  for (const m of data.manualCalls) {
    if (m.dialed_at) placed.push({ at: m.dialed_at, channel: 'softphone', agent: m.agent_user_id, outcome: m.outcome, code: m.disposition_code, id: m.id });
  }
  placed.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1));
  const last = placed[0];

  // Open callbacks: a contact waiting on one (its last disposition is a callback code of its
  // campaign's catalog, its last call connected) and not live; due at `next_attempt_at`.
  const bookedBy = new Map<string, { at: string; user: string | null }>();
  const noteBooking = (contactId: string | null, at: string, user: string | null) => {
    if (!contactId) return;
    const prev = bookedBy.get(contactId);
    if (!prev || prev.at < at) bookedBy.set(contactId, { at, user });
  };
  for (const a of data.attempts) if (a.callback_at) noteBooking(a.contact_id, a.booked_at, a.dispositioned_by_user_id ?? a.agent_user_id);
  for (const m of data.manualCalls) if (m.callback_at) noteBooking(m.contact_id, m.booked_at, m.dispositioned_by_user_id ?? m.agent_user_id);

  const callbacks: CustomerHistoryOpenCallback[] = [];
  const overrides: CustomerHistoryOpenOverride[] = [];
  for (const c of [...data.contacts].sort(byCreatedDesc)) {
    const campaign = campaigns.get(c.campaign_id);
    if (!campaign) continue;
    const codes = callbackCodes(campaign.disposition_catalog as AgencyDisposition[] | null);
    if (
      c.state === 'pending'
      && c.last_disposition !== null && codes.includes(c.last_disposition)
      && c.last_outcome === 'connected'
      && !isLiveContactState(c.state)
    ) {
      callbacks.push({
        contact_id: c.id,
        campaign: campaignWire(campaign),
        due_at: c.next_attempt_at.toISOString(),
        owner: userOf(c.assigned_user_id, names),
        booked_by: userOf(bookedBy.get(c.id)?.user ?? null, names),
        disposition_code: c.last_disposition,
      });
    }
    if (c.override_disposition) {
      overrides.push({
        contact_id: c.id,
        campaign: campaignWire(campaign),
        disposition_code: c.override_disposition,
        granted_at: (c.override_granted_at ?? c.created_at).toISOString(),
        extra_attempts: c.override_extra_attempts,
        retry_delay: c.override_retry_delay,
        calling_hours: c.override_calling_hours,
      });
    }
  }
  callbacks.sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0));

  const liveCalls: CustomerHistoryLiveCall[] = [];
  for (const a of data.attempts) {
    const campaign = campaigns.get(a.campaign_id);
    if (!campaign || !isLiveCallState(a.state)) continue;
    liveCalls.push({ channel: 'campaign', campaign: campaignWire(campaign), agent: userOf(a.agent_user_id, names), started_at: (a.dialed_at ?? a.created_at).toISOString() });
  }
  for (const m of data.manualCalls) {
    if (!isLiveCallState(m.state)) continue;
    const campaign = m.campaign_id ? campaigns.get(m.campaign_id) ?? null : null;
    liveCalls.push({ channel: 'softphone', campaign: campaign ? campaignWire(campaign) : null, agent: userOf(m.agent_user_id, names), started_at: (m.dialed_at ?? m.created_at).toISOString() });
  }
  liveCalls.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));

  // Filter options: root campaigns, agents, outcomes and codes seen in the history.
  const rootIds = new Set<string>();
  for (const c of data.contacts) { const g = campaigns.get(c.campaign_id); if (g) rootIds.add(g.root_id); }
  for (const m of data.manualCalls) { const g = m.campaign_id ? campaigns.get(m.campaign_id) : undefined; if (g) rootIds.add(g.root_id); }
  for (const d of data.dnc) { const g = d.campaign_id ? campaigns.get(d.campaign_id) : undefined; if (g) rootIds.add(g.root_id); }
  const rootCampaigns = [...rootIds]
    .map((id) => {
      const root = campaigns.get(id);
      if (root) return { id, name: root.name };
      // The root of a visible retry is in the same account; its row is read with it. Fall back
      // to the oldest generation seen.
      const gens = [...campaigns.values()].filter((g) => g.root_id === id).sort((a, b) => a.retry_generation - b.retry_generation);
      return { id, name: gens[0]?.name ?? '' };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const agentIds = new Set<string>();
  const outcomes = new Set<string>();
  const codes = new Set<string>();
  for (const a of data.attempts) {
    if (!campaigns.has(a.campaign_id)) continue;
    if (a.agent_user_id) agentIds.add(a.agent_user_id);
    if (a.outcome) outcomes.add(a.outcome);
    if (a.disposition_code) codes.add(a.disposition_code);
  }
  for (const m of data.manualCalls) {
    agentIds.add(m.agent_user_id);
    if (m.outcome) outcomes.add(m.outcome);
    if (m.disposition_code) codes.add(m.disposition_code);
  }
  const agents = [...agentIds]
    .map((id) => userOf(id, names)!)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.user_id < b.user_id ? -1 : 1));

  const dnc = [...data.dnc]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
    .map((d) => dncEntry(d, data));

  return {
    contacts: contacts.map(({ _at, _id, ...c }) => { void _at; void _id; return c; }),
    totals: {
      calls: placed.length,
      connected: placed.filter((p) => p.outcome === 'connected').length,
      last_contacted: last
        ? {
            at: last.at.toISOString(),
            channel: last.channel,
            agent: userOf(last.agent, names),
            outcome: last.outcome as AgencyAttemptOutcome | null,
            disposition_code: last.code,
          }
        : null,
    },
    dnc,
    open: { callbacks, overrides, live_calls: liveCalls },
    filter_options: {
      campaigns: rootCampaigns,
      agents,
      outcomes: [...outcomes].sort() as AgencyAttemptOutcome[],
      disposition_codes: [...codes].sort(),
    },
  };
}
