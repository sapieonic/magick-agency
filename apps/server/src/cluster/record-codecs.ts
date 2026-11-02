/**
 * Decoders for the records that cross IPC whole (`docs/scaling.md` §4.2): a dial command
 * (`DialCommand` with its campaign and contact rows: a value, never ids to re-read) and
 * soft-phone call rows. JSON turns every `Date` into an ISO string, so each decoder names
 * the date fields of its record and revives exactly those; a value that is not a valid
 * date, or a missing id, refuses the whole record.
 */
import type { DialCommand } from '../agency/dial-dispatcher.js';
import type { AgencyCampaignRecord, AgencyContactRecord, AgencyManualCallRecord } from '../db/models/agency.model.js';

const CAMPAIGN_DATES = ['paused_at', 'started_at', 'ended_at', 'completed_at', 'created_at', 'updated_at'] as const;
const CONTACT_DATES = ['next_attempt_at', 'created_at', 'updated_at'] as const;
const MANUAL_CALL_DATES = [
  'callback_at', 'dialed_at', 'answered_at', 'bridged_at', 'ended_at', 'dispositioned_at', 'settled_at', 'created_at', 'updated_at',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

/** A copy of `raw` with each named field revived to a `Date` (null and absent kept). Null if one is not a date. */
function revive<T>(raw: unknown, fields: readonly string[]): T | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, unknown> = { ...raw };
  for (const f of fields) {
    const v = out[f];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    out[f] = d;
  }
  return out as T;
}

export function decodeCampaignRecord(raw: unknown): AgencyCampaignRecord | null {
  const r = revive<AgencyCampaignRecord>(raw, CAMPAIGN_DATES);
  return r && isId(r.id) && isId(r.tenant_id) && isId(r.account_id) ? r : null;
}

export function decodeContactRecord(raw: unknown): AgencyContactRecord | null {
  const r = revive<AgencyContactRecord>(raw, CONTACT_DATES);
  return r && isId(r.id) && isId(r.campaign_id) ? r : null;
}

export function decodeManualCallRecord(raw: unknown): AgencyManualCallRecord | null {
  const r = revive<AgencyManualCallRecord>(raw, MANUAL_CALL_DATES);
  return r && isId(r.id) && isId(r.session_id) ? r : null;
}

export function decodeDialCommand(raw: unknown): DialCommand | null {
  if (!isRecord(raw)) return null;
  for (const k of ['attemptId', 'campaignId', 'contactId', 'sessionId', 'ownerReplica', 'tenantId', 'accountId', 'callerId'] as const) {
    if (!isId(raw[k])) return null;
  }
  if (typeof raw['attemptNumber'] !== 'number' || !Number.isInteger(raw['attemptNumber'])) return null;
  const campaign = decodeCampaignRecord(raw['campaign']);
  const contact = decodeContactRecord(raw['contact']);
  if (!campaign || !contact) return null;
  // Exactly the command's fields: anything else (a clearance, which only this side's
  // gates can mint) does not cross.
  return {
    attemptId: raw['attemptId'] as string,
    campaignId: raw['campaignId'] as string,
    contactId: raw['contactId'] as string,
    sessionId: raw['sessionId'] as string,
    ownerReplica: raw['ownerReplica'] as string,
    tenantId: raw['tenantId'] as string,
    accountId: raw['accountId'] as string,
    callerId: raw['callerId'] as string,
    attemptNumber: raw['attemptNumber'],
    campaign,
    contact,
  };
}
