import type { AgencyAgentState } from '../../../types/agency';
import type {
  AgencyAssignmentMode,
} from '@magick-agency/contracts/agency/assignment';
import type {
  AgencyInsightsActor,
  AgencyPacingIdleReason,
  AgencyReadinessCheck,
  AgencyReadinessCheckCode,
} from '../../../types/agency-insights';
import { DISPLAY_LOCALE, formatCount, plural } from '../../format/number';
import { durationWords } from '../../format/duration';
import { zoneFormatter } from '../../format/zone';
import { agentsLink, contactsLink, contactsUploadLink, settingsLink } from './links';

/**
 * The Insights tab's words. Pure, so each sentence is tested where it is made
 * and a panel only places it. British English throughout; wire codes
 * (`canceled`) are never shown, only their labels.
 */

/** A user reference as a name; a missing user is said as such, never as an id. */
export function actorName(actor: AgencyInsightsActor | null | undefined, system = 'The dialler'): string {
  if (!actor) return system;
  return actor.name ?? 'A former user';
}

/** `3d 4h` past a day, else `durationWords` (`1h 37m`, `4m 10s`). */
export function longDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 86_400) return durationWords(total);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** Seconds from `iso` to `now`, never negative. */
export function secondsSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
}

const ZONED_TIME = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant in the CAMPAIGN's zone: `4 Nov, 15:42`. Every time on the tab is
 * read in one zone, named once in the range bar, so a supervisor in another
 * office never has to convert.
 */
export function formatZoned(iso: string | null | undefined, zone: string, withDate = true): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const safeZone = zoneFormatter(zone) ? zone : 'UTC';
  const key = `${safeZone}|${withDate}`;
  let formatter = ZONED_TIME.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
      timeZone: safeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      ...(withDate ? { day: 'numeric', month: 'short' } : {}),
    });
    ZONED_TIME.set(key, formatter);
  }
  return formatter.format(at);
}

export const AGENT_STATE_LABELS: Record<AgencyAgentState, string> = {
  offline: 'Offline',
  available: 'Available',
  reserved: 'Being connected',
  on_call: 'On a call',
  wrapup: 'Wrap-up',
  break: 'On break',
};

export const ASSIGNMENT_MODE_LABELS: Record<AgencyAssignmentMode, string> = {
  pool: 'Shared pool',
  strict: 'Strict',
  preferred: 'Preferred owner',
};

export const IDLE_REASON_LABELS: Record<AgencyPacingIdleReason | 'outside_calling_hours', string> = {
  no_agents: 'No agents free',
  no_slots: 'At the concurrency limit',
  no_contacts: 'No contacts left to dial',
  no_reservations: 'Could not reserve an agent',
  no_caller_ids: 'No caller ID available',
  nothing_due: 'Nothing due yet',
  outside_calling_hours: 'Outside calling hours',
};

/** Ingest rejection reasons are server codes; unknown ones are shown with underscores spaced. */
export function rejectReasonLabel(code: string): string {
  const known: Record<string, string> = {
    invalid_phone: 'Invalid phone number',
    missing_phone: 'No phone number',
    duplicate: 'Duplicate',
    dnc: 'On Do Not Call',
  };
  return known[code] ?? code.replace(/_/g, ' ');
}

// ── The draft checklist ─────────────────────────────────────────────────────

export const READINESS_LABELS: Record<AgencyReadinessCheckCode, string> = {
  roster_uploaded: 'Roster uploaded',
  phone_column_mapped: 'Phone column mapped',
  outcomes_configured: 'Outcomes configured',
  caller_ids_present: 'Caller IDs present',
  calling_hours_set: 'Calling hours',
  agents_staffed: 'Agents staffed',
  contacts_allocated: 'Contacts allocated',
  abandonment_clip: 'Abandonment clip',
  contacts_on_dnc: 'Already on Do Not Call',
};

function num(detail: AgencyReadinessCheck['detail'], key: string): number | null {
  const value = detail[key];
  return typeof value === 'number' ? value : null;
}

function str(detail: AgencyReadinessCheck['detail'], key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The sentence under one check, from its result, count and detail. */
export function readinessDetail(check: AgencyReadinessCheck, assignmentMode: AgencyAssignmentMode | null): string {
  const { result, count, detail } = check;
  switch (check.code) {
    case 'roster_uploaded': {
      if (!count) return 'No contacts uploaded yet';
      const rejected = num(detail, 'rejected');
      const duplicates = num(detail, 'duplicates');
      const dedupe = str(detail, 'dedupe_column');
      const extra: string[] = [];
      if (rejected !== null) extra.push(`${formatCount(rejected)} rejected`);
      if (duplicates !== null) extra.push(`${formatCount(duplicates)} ${duplicates === 1 ? 'duplicate' : 'duplicates'}${dedupe ? ` on ${dedupe}` : ''}`);
      return extra.length ? `${plural(count, 'contact')} · last upload: ${extra.join(', ')}` : plural(count, 'contact');
    }
    case 'phone_column_mapped': {
      const column = str(detail, 'phone_column');
      if (result === 'pass') return column ? `Column “${column}”` : 'Mapped on the last upload';
      return 'No upload has mapped a phone column';
    }
    case 'outcomes_configured': {
      if (!count) return 'No outcomes: agents cannot record how a call went';
      const overrides = num(detail, 'overrides');
      return overrides ? `${plural(count, 'outcome')}, ${formatCount(overrides)} allow overrides` : plural(count, 'outcome');
    }
    case 'caller_ids_present':
      return count ? plural(count, 'number') : 'No caller IDs: the dialler has nothing to call from';
    case 'calling_hours_set': {
      const window = str(detail, 'window');
      if (result === 'pass') return window ? `Set to ${window}` : 'Set';
      return 'Still on the 09:00–20:00 default';
    }
    case 'agents_staffed':
      return count ? plural(count, 'agent') : 'Nobody is staffed on this campaign';
    case 'contacts_allocated': {
      if (result === 'pass' || !count) return 'Every contact has an owner, or the campaign dials from the pool';
      const tail = assignmentMode === 'strict' ? 'will never be dialled' : 'will be dialled from the shared pool';
      return `${assignmentMode === 'strict' ? 'Strict mode: ' : ''}${formatCount(count)} unassigned ${tail}`;
    }
    case 'abandonment_clip':
      return result === 'pass' ? 'Set' : 'None: abandoned calls hang up silently';
    case 'contacts_on_dnc':
      return count ? `${plural(count, 'contact')} will be skipped` : 'None';
  }
}

/** Where "Fix" goes for one check, and what the link says. */
export function readinessFix(code: AgencyReadinessCheckCode, campaignId: string): { to: string; label: string } {
  switch (code) {
    case 'roster_uploaded':
    case 'phone_column_mapped':
      return { to: contactsUploadLink(campaignId), label: 'Fix' };
    case 'agents_staffed':
    case 'contacts_allocated':
      return { to: agentsLink(campaignId), label: 'Fix' };
    case 'contacts_on_dnc':
      return { to: contactsLink(campaignId), label: 'Review' };
    case 'outcomes_configured':
    case 'caller_ids_present':
    case 'calling_hours_set':
    case 'abandonment_clip':
      return { to: settingsLink(campaignId), label: 'Fix' };
  }
}
