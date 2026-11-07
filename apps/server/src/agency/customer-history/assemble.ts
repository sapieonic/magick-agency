/**
 * The customer-history answer, assembled from the rows the repository read
 * (`docs/customer-history.md` §3 the summary, §4 the timeline). PURE: no I/O. The rows are already
 * scoped to the visible accounts in SQL (CH2), filtered and cut at the cursor in SQL; this file
 * applies what is shown of each row (CH8), groups retry chains (CH7), judges callbacks and
 * recordings, merges the sources' heads into one page in one order, and builds the summary from
 * the SQL aggregates.
 *
 * ── The order ───────────────────────────────────────────────────────────────────
 * `at DESC, key DESC` over every source: `at` is the entry's instant at microsecond precision,
 * `key` is `<kind>:<id>`. Each source statement returns the rows strictly after the cursor in that
 * order (`sourceBound`), so the top `n` of the merged heads is the page, and a page never skips or
 * repeats an entry, whatever the filters; entries sharing one instant are split by `key` alone.
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
  CustomerTimelineEntry,
  CustomerTimelineKind,
  CustomerTimelinePage,
} from '@magick-agency/contracts/api/agency/customer-history';
import type {
  AgencyAttemptOutcome,
  AgencyCampaignStatus,
  AgencyContactState,
  AgencyDisposition,
  AgencyOverrideKind,
} from '@magick-agency/contracts/agency';
import type { DncSource } from '@magick-agency/contracts/api/agency/dnc';
import { AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES } from '@magick-agency/contracts/api/agency/insights';
import { contextValueText, heroColumnsFor } from '@magick-agency/domain/context-hero';
import type {
  CustomerHistoryAttemptRow,
  CustomerHistoryCallbackRow,
  CustomerHistoryCallStatsRow,
  CustomerHistoryCampaignRow,
  CustomerHistoryContactRow,
  CustomerHistoryDncRow,
  CustomerHistoryLastPlacedRow,
  CustomerHistoryLiveCallRow,
  CustomerHistoryManualCallRow,
  CustomerHistorySummaryContactRow,
  CustomerHistoryUploadRow,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes, isOverrideUnspent, UUID_MAX, UUID_NIL } from '../../db/repositories/agency.repository.js';
import { dncEntryScope } from '../dnc-registry.js';
import { userIdOf } from '../insights/shared.js';
import { compareTimeline, encodeTimelineCursor, toWireInstant, type TimelinePosition } from './cursor.js';
import { canOpenCallPage, canSeeCallNotes, canSeeDncDetail, type CustomerHistoryViewer } from './visibility.js';

/** A callback is kept when the next call is placed by its time plus this (inclusive; insights IN4). */
const CALLBACK_ON_TIME_MS = AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES * 60_000;

// ─── Small pieces ────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function userOf(id: string | null | undefined, names: ReadonlyMap<string, string | null>): CustomerHistoryUser | null {
  if (!id) return null;
  return { user_id: id, name: names.get(id) ?? null };
}

function campaignWire(row: CustomerHistoryCampaignRow): CustomerHistoryCampaign {
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
 * The recording state (§4): `no_call` with no media leg; a leg that still exists is `available`
 * with a recording, else `not_recorded`; a leg retention purged (its `agency_calls` row is gone)
 * is `expired` only when the call asked for a recording (`recorded`: the campaign's
 * `record_calls`, a soft-phone call's `recording_requested`), else `not_recorded`: retention purges
 * every old leg, recorded or not, and "Recording expired" must not claim a recording existed.
 */
export function recordingState(
  webrtcCallId: string | null,
  legs: ReadonlyMap<string, { recording_url: string | null }>,
  recorded: boolean,
): CustomerRecordingState {
  if (!webrtcCallId) return 'no_call';
  const leg = legs.get(webrtcCallId);
  if (!leg) return recorded ? 'expired' : 'not_recorded';
  return leg.recording_url ? 'available' : 'not_recorded';
}

/**
 * Whether a booked callback was kept (§4), from the next call placed to the number after the
 * booking (`nextDialledAtMs`, NULL when none yet): placed by `due + 15 min` (inclusive, an early
 * call included) → `kept`; later → `late`; none yet: `upcoming` before `due`, `due` within 15
 * minutes after it, `missed` past that.
 */
export function callbackStatus(input: {
  dueAtMs: number;
  nextDialledAtMs: number | null;
  nowMs: number;
}): CustomerCallbackStatus {
  const deadline = input.dueAtMs + CALLBACK_ON_TIME_MS;
  if (input.nextDialledAtMs !== null) return input.nextDialledAtMs <= deadline ? 'kept' : 'late';
  if (input.nowMs < input.dueAtMs) return 'upcoming';
  if (input.nowMs <= deadline) return 'due';
  return 'missed';
}

/** The columns of a row's import, newest import first: the row's campaign's, else its chain root's. */
function columnOrderFor(campaign: CustomerHistoryCampaignRow | null, uploads: readonly CustomerHistoryUploadRow[]): string[] | null {
  if (!campaign) return null;
  for (const id of [campaign.id, campaign.root_id]) {
    const own = uploads.filter((u) => u.campaign_id === id && Array.isArray(u.context_columns) && u.context_columns.length > 0);
    const newest = own[own.length - 1];
    if (newest) return newest.context_columns;
  }
  return null;
}

/**
 * The row's hero fields (`heroColumnsFor`, `packages/domain/src/context-hero.ts`): the campaign's
 * `context_display.hero`, else the heuristic, else its first columns in the import's order, never
 * a `hidden` column; columns with no value are left out.
 */
export function contactFields(
  context: Record<string, unknown> | null,
  campaign: CustomerHistoryCampaignRow | null,
  columnOrder: readonly string[] | null = null,
): CustomerHistoryField[] {
  const ctx = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const out: CustomerHistoryField[] = [];
  for (const column of heroColumnsFor(ctx, campaign?.context_display ?? null, columnOrder)) {
    const value = contextValueText(ctx[column]);
    if (value !== null && value.trim().length > 0) out.push({ column, value });
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

/**
 * One DNC entry as the caller sees it. Its account is its own, else its campaign's (a campaign
 * mark is written with no account); who added it and why need `agency.dnc.read` in THAT account
 * (CH8), or, for a tenant-wide entry, in any account the caller sees (the registry's own read).
 */
function dncEntry(
  row: CustomerHistoryDncRow,
  viewer: CustomerHistoryViewer,
  campaigns: ReadonlyMap<string, CustomerHistoryCampaignRow>,
  names: ReadonlyMap<string, string | null>,
): CustomerHistoryDncEntry {
  const accountId = row.effective_account_id;
  const detail = canSeeDncDetail(viewer, accountId);
  const campaign = row.campaign_id ? campaigns.get(row.campaign_id) ?? null : null;
  return {
    id: row.id,
    scope: dncEntryScope(row),
    account_id: accountId,
    account_name: accountId ? viewer.accounts.get(accountId)?.name ?? null : null,
    campaign: row.campaign_id ? { id: row.campaign_id, name: campaign?.name ?? null } : null,
    source: row.source as DncSource,
    reason: detail ? row.reason : null,
    added_by: detail ? dncAddedBy(row.added_by, names) : null,
    created_at: row.created_at.toISOString(),
  };
}

// ─── Timeline pages ──────────────────────────────────────────────────────────

/** One page's rows, each source already cut at the cursor and filtered in SQL. */
export interface TimelineSourceRows {
  attempts: readonly CustomerHistoryAttemptRow[];
  manualCalls: readonly CustomerHistoryManualCallRow[];
  callbacks: readonly CustomerHistoryCallbackRow[];
  dnc: readonly CustomerHistoryDncRow[];
  contacts: readonly CustomerHistoryContactRow[];
}

export const EMPTY_SOURCES: TimelineSourceRows = { attempts: [], manualCalls: [], callbacks: [], dnc: [], contacts: [] };

/**
 * Where a source of `kind` resumes after `cursor`: its rows strictly after the cursor in
 * `at DESC, key DESC` are `(at, id) < (cursor.at, id)` with `id` the cursor's own id when the
 * cursor is of this kind; at the cursor's instant, every row of a kind that sorts before the
 * cursor's (its keys are smaller: {@link UUID_MAX}) and none of a kind after it ({@link UUID_NIL}).
 * No cursor: everything.
 */
export function sourceBound(kind: CustomerTimelineKind, cursor: TimelinePosition | null): { at: string; id: string } {
  if (!cursor) return { at: 'infinity', id: UUID_MAX };
  const sep = cursor.key.indexOf(':');
  const cursorKind = cursor.key.slice(0, sep);
  if (kind === cursorKind) return { at: cursor.at, id: cursor.key.slice(sep + 1) };
  return { at: cursor.at, id: kind < cursorKind ? UUID_MAX : UUID_NIL };
}

/** An entry's `key`: `<kind>:<id>`. */
const keyOf = (kind: CustomerTimelineKind, id: string): string => `${kind}:${id}`;

/** The timeline kind of each source's rows. */
const SOURCE_KINDS = {
  attempts: 'campaign_call',
  manualCalls: 'softphone_call',
  callbacks: 'callback',
  dnc: 'dnc_mark',
  contacts: 'roster_entry',
} as const satisfies Record<keyof TimelineSourceRows, CustomerTimelineKind>;

const positionsOf = (rows: TimelineSourceRows): TimelinePosition[] =>
  (Object.keys(SOURCE_KINDS) as Array<keyof TimelineSourceRows>)
    .flatMap((source) => rows[source].map((r) => ({ at: r.at, key: keyOf(SOURCE_KINDS[source], r.id) })));

/**
 * The page out of each source's head: the first `limit` entries of the merge, the rows behind
 * them, the last one's position, and whether anything follows. Each source returned up to
 * `limit + 1` rows after the cursor, so more than `limit` merged means a next page exists.
 */
export function cutPage(rows: TimelineSourceRows, limit: number): { rows: TimelineSourceRows; last: TimelinePosition | null; hasMore: boolean } {
  const all = positionsOf(rows).sort(compareTimeline);
  const kept = all.slice(0, limit);
  const keys = new Set(kept.map((p) => p.key));
  const keep = <R extends { id: string }>(source: keyof TimelineSourceRows, list: readonly R[]): R[] =>
    list.filter((r) => keys.has(keyOf(SOURCE_KINDS[source], r.id)));
  return {
    rows: {
      attempts: keep('attempts', rows.attempts),
      manualCalls: keep('manualCalls', rows.manualCalls),
      callbacks: keep('callbacks', rows.callbacks),
      dnc: keep('dnc', rows.dnc),
      contacts: keep('contacts', rows.contacts),
    },
    last: kept[kept.length - 1] ?? null,
    hasMore: all.length > limit,
  };
}

/** What one page's entries are built from: the page's rows and what they name. */
export interface TimelinePageData extends TimelineSourceRows {
  now: Date;
  viewer: CustomerHistoryViewer;
  campaigns: ReadonlyMap<string, CustomerHistoryCampaignRow>;
  /** Media legs that still exist (`agency_calls`), by id. */
  mediaLegs: ReadonlyMap<string, { recording_url: string | null }>;
  uploads: readonly CustomerHistoryUploadRow[];
  /** Display names by user id (NULL when unresolved). */
  names: ReadonlyMap<string, string | null>;
  /** Each callback's next placed call to the number, by booking call id (NULL: none yet). */
  callbackNext: ReadonlyMap<string, Date | null>;
}

/** Every user id a page names, for one name lookup. */
export function pageUserIds(rows: TimelineSourceRows): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => { if (id) ids.add(id); };
  for (const a of rows.attempts) add(a.agent_user_id);
  for (const m of rows.manualCalls) add(m.agent_user_id);
  for (const c of rows.callbacks) add(c.booked_by_user_id);
  for (const d of rows.dnc) add(userIdOf(d.added_by));
  return [...ids];
}

/** The campaigns a page names. */
export function pageCampaignIds(rows: TimelineSourceRows): string[] {
  const ids = new Set<string>();
  for (const a of rows.attempts) ids.add(a.campaign_id);
  for (const m of rows.manualCalls) if (m.campaign_id) ids.add(m.campaign_id);
  for (const c of rows.callbacks) if (c.campaign_id) ids.add(c.campaign_id);
  for (const d of rows.dnc) if (d.campaign_id) ids.add(d.campaign_id);
  for (const c of rows.contacts) ids.add(c.campaign_id);
  return [...ids];
}

/** The page's entries, in the timeline's order (`at DESC, key DESC`). */
export function buildTimeline(data: TimelinePageData): CustomerTimelineEntry[] {
  const { viewer, names, campaigns } = data;
  const items: Array<{ at: string; key: string; entry: CustomerTimelineEntry }> = [];
  const nowMs = data.now.getTime();

  for (const a of data.attempts) {
    const campaign = campaigns.get(a.campaign_id);
    if (!campaign) continue;
    const showNotes = canSeeCallNotes(viewer, a.account_id, a.agent_user_id);
    const hadNotes = (a.notes !== null && a.notes.length > 0) || (a.override_note !== null && a.override_note.length > 0);
    const key = keyOf('campaign_call', a.id);
    items.push({
      at: a.at, key,
      entry: {
        key, kind: 'campaign_call', at: toWireInstant(a.at), account_id: a.account_id,
        attempt_id: a.id,
        contact_id: a.contact_id,
        campaign: campaignWire(campaign),
        attempt_number: a.attempt_number,
        agent: userOf(a.agent_user_id, names),
        outcome: a.outcome as AgencyAttemptOutcome | null,
        disposition_code: a.disposition_code,
        // Not gated like the notes: a catalog code the campaign chose, as `disposition_code` is.
        auto_disposition_code: a.auto_disposition_code,
        talk_seconds: a.talk_seconds,
        notes: showNotes ? a.notes : null,
        notes_hidden: !showNotes && hadNotes,
        callback_at: iso(a.callback_at),
        redial_of_attempt_id: a.redial_of_attempt_id,
        chain_attempt_id: a.chain_attempt_id,
        redial_number: a.redial_number,
        override_applied: a.override_applied as AgencyOverrideKind[],
        override_note: showNotes ? a.override_note : null,
        recording: recordingState(a.webrtc_call_id, data.mediaLegs, a.record_calls),
        call_page: canOpenCallPage(viewer, a.account_id)
          ? { account_id: a.account_id, campaign_id: a.campaign_id, attempt_id: a.id }
          : null,
      },
    });
  }

  for (const m of data.manualCalls) {
    const campaign = m.campaign_id ? campaigns.get(m.campaign_id) ?? null : null;
    const showNotes = canSeeCallNotes(viewer, m.account_id, m.agent_user_id);
    const fields = m.fields && typeof m.fields === 'object' && !Array.isArray(m.fields) ? m.fields : {};
    const hadNotes = (m.notes !== null && m.notes.length > 0) || Object.keys(fields).length > 0
      || m.dnc_override_note !== null || m.hours_override_note !== null;
    const key = keyOf('softphone_call', m.id);
    items.push({
      at: m.at, key,
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
        recording: recordingState(m.webrtc_call_id, data.mediaLegs, m.recording_requested),
        call_page: canOpenCallPage(viewer, m.account_id) ? { account_id: m.account_id, manual_call_id: m.id } : null,
      },
    });
  }

  for (const c of data.callbacks) {
    const campaign = c.campaign_id ? campaigns.get(c.campaign_id) ?? null : null;
    const next = data.callbackNext.get(c.id) ?? null;
    const key = keyOf('callback', c.id);
    items.push({
      at: c.at, key,
      entry: {
        key, kind: 'callback', at: toWireInstant(c.at), account_id: c.account_id,
        source: { channel: c.channel, id: c.id },
        campaign: campaign ? campaignWire(campaign) : null,
        due_at: c.callback_at.toISOString(),
        booked_by: userOf(c.booked_by_user_id, names),
        status: callbackStatus({ dueAtMs: c.callback_at.getTime(), nextDialledAtMs: next ? next.getTime() : null, nowMs }),
        dialled_at: iso(next),
      },
    });
  }

  for (const d of data.dnc) {
    const key = keyOf('dnc_mark', d.id);
    items.push({
      at: d.at, key,
      entry: { key, kind: 'dnc_mark', at: toWireInstant(d.at), account_id: d.effective_account_id, entry: dncEntry(d, viewer, campaigns, names) },
    });
  }

  for (const c of data.contacts) {
    const campaign = campaigns.get(c.campaign_id);
    if (!campaign) continue;
    const key = keyOf('roster_entry', c.id);
    items.push({
      at: c.at, key,
      entry: {
        key, kind: 'roster_entry', at: toWireInstant(c.at), account_id: c.account_id,
        contact_id: c.id,
        campaign: campaignWire(campaign),
        upload_file_name: uploadFileName(c.campaign_id, c.created_at, data.uploads, data.now),
      },
    });
  }

  return items.sort(compareTimeline).map((i) => i.entry);
}

/** The wire page: the entries and, when more follow, the cursor after the last one. */
export function timelinePage(entries: CustomerTimelineEntry[], cut: { last: TimelinePosition | null; hasMore: boolean }): CustomerTimelinePage {
  return {
    entries,
    next_cursor: cut.hasMore && cut.last ? encodeTimelineCursor(cut.last) : null,
  };
}

// ─── The summary ─────────────────────────────────────────────────────────────

/** Everything the summary is built from: roster rows and the SQL aggregates over the calls. */
export interface CustomerHistorySummaryData {
  now: Date;
  viewer: CustomerHistoryViewer;
  /** Newest first, at most the cap. */
  contacts: readonly CustomerHistorySummaryContactRow[];
  contactsTruncated: boolean;
  campaigns: ReadonlyMap<string, CustomerHistoryCampaignRow>;
  stats: CustomerHistoryCallStatsRow;
  lastPlaced: CustomerHistoryLastPlacedRow | null;
  liveCalls: readonly CustomerHistoryLiveCallRow[];
  /** Who booked each contact's latest callback, by contact id. */
  bookings: ReadonlyMap<string, string | null>;
  dnc: readonly CustomerHistoryDncRow[];
  uploads: readonly CustomerHistoryUploadRow[];
  names: ReadonlyMap<string, string | null>;
}

/** `at DESC, id DESC`: newest first, as the repository reads rows. */
const byAtIdDesc = (a: { at: string; id: string }, b: { at: string; id: string }) =>
  (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Every user id the summary names except the callbacks' bookers (named with their bookings), for one name lookup. */
export function summaryUserIds(data: Pick<CustomerHistorySummaryData, 'contacts' | 'stats' | 'lastPlaced' | 'liveCalls' | 'dnc'>): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => { if (id) ids.add(id); };
  for (const c of data.contacts) add(c.assigned_user_id);
  for (const id of data.stats.agent_ids) add(id);
  add(data.lastPlaced?.agent_user_id);
  for (const l of data.liveCalls) add(l.agent_user_id);
  for (const d of data.dnc) add(userIdOf(d.added_by));
  return [...ids];
}

/** The campaigns the summary names (their chain roots are read with them). */
export function summaryCampaignIds(data: Pick<CustomerHistorySummaryData, 'contacts' | 'stats' | 'liveCalls' | 'dnc'>): string[] {
  const ids = new Set<string>(data.stats.campaign_ids);
  for (const c of data.contacts) ids.add(c.campaign_id);
  for (const l of data.liveCalls) if (l.campaign_id) ids.add(l.campaign_id);
  for (const d of data.dnc) if (d.campaign_id) ids.add(d.campaign_id);
  return [...ids];
}

/**
 * The contacts with an open callback, whose booking is looked up: waiting to be dialled, and its
 * last call connected with a callback code of its campaign's catalog.
 */
export function contactsAwaitingCallback(
  contacts: readonly CustomerHistoryContactRow[],
  campaigns: ReadonlyMap<string, CustomerHistoryCampaignRow>,
): CustomerHistoryContactRow[] {
  return contacts.filter((c) => {
    const campaign = campaigns.get(c.campaign_id);
    if (!campaign || c.state !== 'pending' || c.last_outcome !== 'connected' || c.last_disposition === null) return false;
    return callbackCodes(campaign.disposition_catalog as AgencyDisposition[] | null).includes(c.last_disposition);
  });
}

/** CH7: one row per retry chain (`root_contact_id`), the newest chain first. `sorted` is newest first. */
function chainContacts(sorted: readonly CustomerHistorySummaryContactRow[], data: CustomerHistorySummaryData): CustomerHistoryContact[] {
  const { viewer, names, campaigns } = data;
  // Each chain's rows stay newest first, and the chains are in the order of their newest rows.
  const chains = new Map<string, CustomerHistorySummaryContactRow[]>();
  for (const c of sorted) {
    if (!campaigns.has(c.campaign_id)) continue;
    const list = chains.get(c.root_contact_id);
    if (list) list.push(c);
    else chains.set(c.root_contact_id, [c]);
  }
  return [...chains].map(([rootId, rows]) => {
    const newest = rows[0]!;
    const oldest = rows[rows.length - 1]!;
    const campaign = campaigns.get(newest.campaign_id)!;
    const chainCampaigns = [...new Map(rows.map((r) => [r.campaign_id, campaigns.get(r.campaign_id)!])).values()]
      .sort((a, b) => a.retry_generation - b.retry_generation || (a.id < b.id ? -1 : 1))
      .map(campaignWire);
    return {
      contact_id: newest.id,
      root_contact_id: rootId,
      account_id: newest.account_id,
      account_name: viewer.accounts.get(newest.account_id)?.name ?? null,
      phone_e164: newest.phone_e164,
      campaign: campaignWire(campaign),
      campaigns: chainCampaigns,
      state: newest.state as AgencyContactState,
      suppressed_reason: newest.suppressed_reason,
      attempt_count: rows.reduce((n, r) => n + r.placed, 0),
      fields: contactFields(newest.context, campaign, columnOrderFor(campaign, data.uploads)),
      assigned_to: userOf(newest.assigned_user_id, names),
      entered_at: oldest.created_at.toISOString(),
      upload_file_name: uploadFileName(oldest.campaign_id, oldest.created_at, data.uploads, data.now),
    };
  });
}

/** Open callbacks ({@link contactsAwaitingCallback}), soonest due first; due at `next_attempt_at`. */
function openCallbacks(sorted: readonly CustomerHistorySummaryContactRow[], data: CustomerHistorySummaryData): CustomerHistoryOpenCallback[] {
  const { names, campaigns } = data;
  return contactsAwaitingCallback(sorted, campaigns)
    .map((c) => ({
      contact_id: c.id,
      campaign: campaignWire(campaigns.get(c.campaign_id)!),
      due_at: c.next_attempt_at.toISOString(),
      owner: userOf(c.assigned_user_id, names),
      booked_by: userOf(data.bookings.get(c.id) ?? null, names),
      disposition_code: c.last_disposition,
    }))
    .sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0));
}

/**
 * Open overrides: a grant that still grants something (the dialer's own rule, `isOverrideUnspent`);
 * its follow-up is the contact's next dial while it waits for one.
 */
function openOverrides(sorted: readonly CustomerHistorySummaryContactRow[], campaigns: CustomerHistorySummaryData['campaigns']): CustomerHistoryOpenOverride[] {
  const overrides: CustomerHistoryOpenOverride[] = [];
  for (const c of sorted) {
    const campaign = campaigns.get(c.campaign_id);
    if (!campaign || !isOverrideUnspent(c)) continue;
    overrides.push({
      contact_id: c.id,
      campaign: campaignWire(campaign),
      disposition_code: c.override_disposition,
      granted_at: (c.override_granted_at ?? c.created_at).toISOString(),
      follow_up_at: c.state === 'pending' ? c.next_attempt_at.toISOString() : null,
      extra_attempts: c.override_extra_attempts,
      retry_delay: c.override_retry_delay,
      calling_hours: c.override_calling_hours,
    });
  }
  return overrides;
}

/** Filter options: root campaigns, agents, outcomes and codes seen in the history. */
function filterOptions(data: CustomerHistorySummaryData): CustomerHistorySummary['filter_options'] {
  const { names, campaigns } = data;
  const rootIds = new Set<string>();
  for (const id of data.stats.campaign_ids) { const g = campaigns.get(id); if (g) rootIds.add(g.root_id); }
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
  const agents = data.stats.agent_ids
    .map((id) => userOf(id, names)!)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.user_id < b.user_id ? -1 : 1));
  return {
    campaigns: rootCampaigns,
    agents,
    outcomes: [...data.stats.outcomes].sort() as AgencyAttemptOutcome[],
    disposition_codes: [...data.stats.disposition_codes].sort(),
  };
}

export function buildSummary(data: CustomerHistorySummaryData): CustomerHistorySummary {
  const { viewer, names, campaigns } = data;
  const sorted = [...data.contacts].sort(byAtIdDesc);

  const liveCalls: CustomerHistoryLiveCall[] = data.liveCalls
    .map((l) => {
      const campaign = l.campaign_id ? campaigns.get(l.campaign_id) ?? null : null;
      return { channel: l.channel, campaign: campaign ? campaignWire(campaign) : null, agent: userOf(l.agent_user_id, names), started_at: l.started_at.toISOString() };
    })
    .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));

  const last = data.lastPlaced;
  return {
    contacts: chainContacts(sorted, data),
    ...(data.contactsTruncated ? { contacts_truncated: true as const } : {}),
    totals: {
      calls: data.stats.calls,
      connected: data.stats.connected,
      last_contacted: last
        ? {
            at: last.dialed_at.toISOString(),
            channel: last.channel,
            agent: userOf(last.agent_user_id, names),
            outcome: last.outcome as AgencyAttemptOutcome | null,
            disposition_code: last.disposition_code,
          }
        : null,
    },
    dnc: [...data.dnc].sort(byAtIdDesc).map((d) => dncEntry(d, viewer, campaigns, names)),
    open: { callbacks: openCallbacks(sorted, data), overrides: openOverrides(sorted, campaigns), live_calls: liveCalls },
    filter_options: filterOptions(data),
  };
}

/**
 * How many timeline entries the caller can see (the audit's `result_count`, the search's and the
 * export's): the covered roster rows, the calls, the callbacks booked on them and the DNC entries.
 */
export function entryCount(stats: CustomerHistoryCallStatsRow, dncRows: number): number {
  return stats.contact_entries + stats.call_entries + stats.callback_entries + dncRows;
}
