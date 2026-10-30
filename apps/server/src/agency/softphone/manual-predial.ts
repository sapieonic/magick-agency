/**
 * The soft phone's pre-dial (docs/softphone.md §4.1 step 2; rulings SP1, SP2, SP6).
 *
 * In order, cheapest first, and none of it dials:
 *
 *  1. Override notes, when given: `SOFTPHONE_OVERRIDE_NOTE_MIN`–`_MAX` characters
 *     after trimming, else `override_note_invalid`. Checked up front — a note is
 *     USED only when its refusal would otherwise fire, but a malformed one is
 *     refused whether or not it would have been needed.
 *  2. The number: `normalizePhoneToE164` with the default region (the ingest's
 *     normaliser), then the dial-time canonical form (`normalizeE164`), else
 *     `invalid_number`.
 *  3. The caller ID, in the allowed set: tagged, the campaign's `caller_ids`
 *     (`usableCallerIds`, the pacing engine's definition); untagged, the account's
 *     assigned numbers (`findAvailableForAccount`). Absent: tagged, the pool's
 *     round-robin pick (`pickCallerId`, as pacing dials); untagged, the settings'
 *     `default_caller_id` when it is still allowed, else the account's default
 *     number (the first of `findAvailableForAccount`, which orders `is_default`
 *     first). Not allowed → `caller_id_not_allowed` with the set.
 *  4. Tagged only — the roster match (`findForManualMatch`): any match `in_flight`
 *     refuses `contact_in_flight`, no override; else the oldest `pending` match is
 *     the one to claim, else the oldest match is linked.
 *  5. Tagged only — the calling window, in the matched contact's timezone, else
 *     the campaign default (`resolveCallingWindow`): closed → `outside_calling_hours`
 *     with the window and its next opening, unless `hours_note` overrides it. A
 *     window that cannot be evaluated (an unusable timezone) is closed with no
 *     next opening — overridable like any closed window.
 *  6. DNC (tenant, account, tag): `DncRegistry.checkEntry` — a hit is `dnc_listed`
 *     with the entry unless `dnc_note` overrides it; a lookup failure is
 *     `dnc_unavailable` and is NEVER overridable (fail closed, SP1).
 *
 * Then what the dial uses: recording (the tag's `record_calls`, else the settings')
 * and the analysis profile (the tag's, else the settings', else null — the
 * analysis hook falls back to the account default).
 */
import {
  SOFTPHONE_OVERRIDE_NOTE_MAX,
  SOFTPHONE_OVERRIDE_NOTE_MIN,
  type AgencySoftphoneSettings,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../../db/models/agency.model.js';
import { normalizePhoneToE164 } from '../../utils/phone-normalizer.js';
import { normalizeE164, type DncRegistry } from '../dnc-registry.js';
import { callingWindowState, nextWindowOpen, resolveCallingWindow } from '../calling-hours.js';
import { pickCallerId, usableCallerIds } from '../pacing/caller-id-pool.js';
import type { SoftphoneRefusal } from './types.js';

/** What the dial uses, once every gate has passed. */
export interface ManualDialPlan {
  destinationE164: string;
  callerId: string;
  /** The roster contact to claim (when `pending`) or link; null when untagged or no match. */
  contact: AgencyContactRecord | null;
  /** SP1: the trimmed note and the entry it overrode. */
  dncOverride: { note: string; entryId: string } | null;
  /** SP2: the trimmed note. */
  hoursOverrideNote: string | null;
  recordingRequested: boolean;
  analysisProfileId: string | null;
}

export interface ManualPredialInput {
  tenantId: string;
  accountId: string;
  /** As typed. */
  to: unknown;
  /** Digits, no `+` (`defaultPhoneCountryCode()`). */
  defaultCountryCode: string;
  requestedCallerId?: unknown;
  /** The tag, already resolved and checked taggable; null = untagged. */
  tag: AgencyCampaignRecord | null;
  /** Untagged calls: the account's assigned numbers, default first. */
  accountNumbers: readonly string[];
  settings: AgencySoftphoneSettings;
  overrides?: { dnc_note?: unknown; hours_note?: unknown } | null;
  now: Date;
}

export interface ManualPredialDeps {
  dnc: Pick<DncRegistry, 'checkEntry'>;
  findRosterMatches: (campaignId: string, phoneE164: string) => Promise<AgencyContactRecord[]>;
}

type Refused = { ok: false; refusal: SoftphoneRefusal };

/** An override note: absent → null; out of bounds → the refusal; else the trimmed text. */
export function validateOverrideNote(
  raw: unknown,
  field: 'dnc_note' | 'hours_note',
): { ok: true; note: string | null } | Refused {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (typeof raw !== 'string' || note.length < SOFTPHONE_OVERRIDE_NOTE_MIN || note.length > SOFTPHONE_OVERRIDE_NOTE_MAX) {
    return {
      ok: false,
      refusal: {
        code: 'override_note_invalid',
        details: [{
          path: `overrides.${field}`,
          message: `must be ${SOFTPHONE_OVERRIDE_NOTE_MIN}–${SOFTPHONE_OVERRIDE_NOTE_MAX} characters`,
        }],
      },
    };
  }
  return { ok: true, note };
}

/** The dialled number, normalised as the roster stores numbers; null when not dialable. */
export function normalizeDialledNumber(to: unknown, defaultCountryCode: string): string | null {
  if (typeof to !== 'string') return null;
  const local = normalizePhoneToE164(to, { defaultCountryCode });
  return normalizeE164(local);
}

/** Step 3: the allowed set and the caller ID the dial uses. */
export function selectCallerId(input: {
  tag: AgencyCampaignRecord | null;
  accountNumbers: readonly string[];
  settingsDefault: string | null;
  requested: unknown;
}): { ok: true; callerId: string } | Refused {
  const allowed = input.tag
    ? usableCallerIds(input.tag)
    : input.accountNumbers.filter((n) => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim());
  const refuse: Refused = { ok: false, refusal: { code: 'caller_id_not_allowed', allowed_codes: [...allowed] } };
  if (input.requested !== undefined && input.requested !== null && input.requested !== '') {
    if (typeof input.requested !== 'string') return refuse;
    const requested = input.requested.trim();
    return allowed.includes(requested) ? { ok: true, callerId: requested } : refuse;
  }
  if (input.tag) {
    const picked = pickCallerId(allowed, 0);
    return picked ? { ok: true, callerId: picked } : refuse;
  }
  if (input.settingsDefault && allowed.includes(input.settingsDefault)) {
    return { ok: true, callerId: input.settingsDefault };
  }
  return allowed[0] ? { ok: true, callerId: allowed[0] } : refuse;
}

/**
 * Step 4's rule over the matches (oldest first, as `findForManualMatch` answers):
 * any `in_flight` refuses; else the oldest `pending`; else the oldest.
 */
export function pickRosterContact(
  campaignId: string,
  matches: readonly AgencyContactRecord[],
): { ok: true; contact: AgencyContactRecord | null } | Refused {
  const inFlight = matches.find((c) => c.state === 'in_flight');
  if (inFlight) {
    return { ok: false, refusal: { code: 'contact_in_flight', campaign_id: campaignId, contact_id: inFlight.id } };
  }
  return { ok: true, contact: matches.find((c) => c.state === 'pending') ?? matches[0] ?? null };
}

export async function runManualPredial(
  input: ManualPredialInput,
  deps: ManualPredialDeps,
): Promise<{ ok: true; plan: ManualDialPlan } | Refused> {
  // 1. Notes.
  const dncNote = validateOverrideNote(input.overrides?.dnc_note, 'dnc_note');
  if (!dncNote.ok) return dncNote;
  const hoursNote = validateOverrideNote(input.overrides?.hours_note, 'hours_note');
  if (!hoursNote.ok) return hoursNote;

  // 2. The number.
  const destinationE164 = normalizeDialledNumber(input.to, input.defaultCountryCode);
  if (!destinationE164) return { ok: false, refusal: { code: 'invalid_number' } };

  // 3. The caller ID.
  const caller = selectCallerId({
    tag: input.tag,
    accountNumbers: input.accountNumbers,
    settingsDefault: input.settings.default_caller_id,
    requested: input.requestedCallerId,
  });
  if (!caller.ok) return caller;

  // 4. The roster match.
  let contact: AgencyContactRecord | null = null;
  if (input.tag) {
    const picked = pickRosterContact(input.tag.id, await deps.findRosterMatches(input.tag.id, destinationE164));
    if (!picked.ok) return picked;
    contact = picked.contact;
  }

  // 5. The calling window (tagged).
  let hoursOverrideNote: string | null = null;
  if (input.tag) {
    const window = resolveCallingWindow(input.tag, { timezone: contact?.timezone ?? null });
    if (callingWindowState(window, input.now) !== 'open') {
      if (hoursNote.note === null) {
        const next = nextWindowOpen(window, input.now);
        return {
          ok: false,
          refusal: {
            code: 'outside_calling_hours',
            window: { start: window.start, end: window.end, days: [...window.days], timezone: window.timezone },
            timezone_source: window.timezoneSource,
            next_open_at: next ? next.toISOString() : null,
          },
        };
      }
      hoursOverrideNote = hoursNote.note;
    }
  }

  // 6. DNC. Fails closed, and the failure has no override.
  let dncOverride: ManualDialPlan['dncOverride'] = null;
  const dnc = await deps.dnc.checkEntry(input.tenantId, destinationE164, {
    accountId: input.accountId,
    campaignId: input.tag?.id ?? null,
  });
  if (dnc.result === 'unavailable') return { ok: false, refusal: { code: 'dnc_unavailable' } };
  if (dnc.result === 'unverifiable') return { ok: false, refusal: { code: 'invalid_number' } };
  if (dnc.result === 'suppressed') {
    if (dncNote.note === null) {
      return {
        ok: false,
        refusal: {
          code: 'dnc_listed',
          entry: {
            id: dnc.entry.id,
            scope: dnc.entry.scope,
            reason: dnc.entry.reason,
            created_at: dnc.entry.created_at.toISOString(),
          },
        },
      };
    }
    dncOverride = { note: dncNote.note, entryId: dnc.entry.id };
  }

  return {
    ok: true,
    plan: {
      destinationE164,
      callerId: caller.callerId,
      contact,
      dncOverride,
      hoursOverrideNote,
      recordingRequested: input.tag ? input.tag.record_calls === true : input.settings.record_calls === true,
      analysisProfileId: input.tag
        ? (input.tag.analysis_profile_id ?? input.settings.analysis_profile_id ?? null)
        : (input.settings.analysis_profile_id ?? null),
    },
  };
}
