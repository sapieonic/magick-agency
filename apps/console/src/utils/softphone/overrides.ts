import { describeIsoDays, hhmm } from '../format/weekdays';
import { DISPLAY_LOCALE } from '../format/number';
import { formatDialNumber } from './phoneInput';
import {
  SOFTPHONE_OVERRIDE_NOTE_MAX,
  SOFTPHONE_OVERRIDE_NOTE_MIN,
  type AgencyManualCallOverridesRequest,
} from '../../types/softphone';
import type { SoftphoneDncListedRefusal, SoftphoneOutsideHoursRefusal } from '../../api/softphone';

/**
 * The two refusals an agent may dial through with a note (SP1 DNC, SP2 calling
 * hours, `docs/softphone.md` §1), and what the override dialog says about each.
 *
 * The dialog's job is to say **exactly what matched** before the agent decides —
 * which DNC entry, how far it reaches, why and since when; which window, in whose
 * timezone, and when it next opens — and that the call will be logged with their
 * name and their reason. A dialog that says only "this number is blocked, call
 * anyway?" trains a reflex click; one that names the entry gives the agent
 * something to weigh.
 */

export type OverrideKind = 'dnc' | 'hours';

export type OverrideNoteBlock = 'too_short' | 'too_long';

/**
 * A note's length as the server and the database count it: characters (code points)
 * after trimming, so an emoji is one, not the two UTF-16 units `.length` reports.
 */
export function overrideNoteLength(note: string): number {
  return [...note.trim()].length;
}

/** The note's length is checked after trimming, as the server does (`override_note_invalid`). */
export function overrideNoteBlock(note: string): OverrideNoteBlock | null {
  const length = overrideNoteLength(note);
  if (length < SOFTPHONE_OVERRIDE_NOTE_MIN) return 'too_short';
  if (length > SOFTPHONE_OVERRIDE_NOTE_MAX) return 'too_long';
  return null;
}

export const OVERRIDE_NOTE_BLOCK_COPY: Record<OverrideNoteBlock, string> = {
  too_short: `Write at least ${SOFTPHONE_OVERRIDE_NOTE_MIN} characters — say why this call has to go ahead.`,
  too_long: `Keep the note to ${SOFTPHONE_OVERRIDE_NOTE_MAX} characters.`,
};

/** The overrides to retry with: what was already given, plus this note under its kind's key. */
export function withOverride(
  current: AgencyManualCallOverridesRequest,
  kind: OverrideKind,
  note: string,
): AgencyManualCallOverridesRequest {
  return { ...current, ...(kind === 'dnc' ? { dnc_note: note.trim() } : { hours_note: note.trim() }) };
}

export interface OverrideDescription {
  title: string;
  /** The facts, one per line, in the order the agent should read them. */
  facts: Array<{ label: string; value: string }>;
  /** What calling anyway does — always said, because it is the cost. */
  consequence: string;
  noteLabel: string;
  confirmLabel: string;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
}

const DNC_SCOPE_COPY = {
  tenant: 'Every campaign and account in this workspace',
  account: 'This account',
} as const;

/**
 * How far a DNC entry reaches, in words. `campaignName` is the campaign the entry is
 * for when the caller knows it (a call logged to that campaign); a campaign entry an
 * UNTAGGED call met is one of the account's campaigns (docs/softphone.md §4.1 step 2),
 * which is all this copy claims.
 */
export function dncEntryReach(
  entry: Pick<SoftphoneDncListedRefusal['entry'], 'scope'>,
  campaignName: string | null,
): string {
  if (entry.scope !== 'campaign') return DNC_SCOPE_COPY[entry.scope];
  return campaignName ? `The campaign ${campaignName}` : 'One of this account’s campaigns';
}

/** An entry's reason and the date it was added, as the dialog and the call detail show them. */
export function dncEntryFacts(
  entry: Pick<SoftphoneDncListedRefusal['entry'], 'reason' | 'created_at'>,
): Array<{ label: string; value: string }> {
  const facts = [{ label: 'Reason', value: entry.reason?.trim() ? entry.reason.trim() : 'No reason was recorded' }];
  const added = formatDate(entry.created_at);
  if (added) facts.push({ label: 'Added', value: added });
  return facts;
}

export function describeDncRefusal(
  refusal: SoftphoneDncListedRefusal,
  context: { number: string; campaignName: string | null },
): OverrideDescription {
  const { entry } = refusal;
  const facts = [
    { label: 'Number', value: formatDialNumber(context.number) || context.number },
    { label: 'Listed for', value: dncEntryReach(entry, context.campaignName) },
    ...dncEntryFacts(entry),
  ];
  return {
    title: 'This number is on the Do Not Call list',
    facts,
    consequence:
      'If you call anyway, the call is logged with your name, this entry and your note, and your supervisor can see it. The number stays on the list.',
    noteLabel: 'Why does this call have to go ahead?',
    confirmLabel: 'Call anyway',
  };
}

/**
 * When the window next opens, read in the window's own zone and named with it:
 * "Mon 2 Nov, 09:00 (Asia/Kolkata)". The agent's own clock is not the one that
 * matters here — the customer's is.
 */
export function formatNextOpening(nextOpenAt: string | null, timezone: string): string | null {
  if (!nextOpenAt) return null;
  const ms = Date.parse(nextOpenAt);
  if (!Number.isFinite(ms)) return null;
  try {
    const text = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    }).format(new Date(ms));
    return `${text} (${timezone})`;
  } catch {
    // An unknown zone name: say the instant in the reader's zone rather than nothing.
    return new Date(ms).toLocaleString(DISPLAY_LOCALE);
  }
}

export function describeHoursRefusal(
  refusal: SoftphoneOutsideHoursRefusal,
  context: { campaignName: string | null },
): OverrideDescription {
  const { window } = refusal;
  const days = describeIsoDays(window.days);
  const campaign = context.campaignName ?? 'This campaign';
  const facts = [
    {
      label: 'Calling hours',
      value: `${hhmm(window.start)}–${hhmm(window.end)}${days ? `, ${days}` : ''}`,
    },
    {
      label: 'Timezone',
      value:
        refusal.timezone_source === 'contact'
          ? `${window.timezone} — the customer’s, from the roster`
          : `${window.timezone} — the campaign’s default; this number isn’t on the roster`,
    },
    {
      label: 'Opens again',
      value:
        formatNextOpening(refusal.next_open_at, window.timezone)
        ?? 'Never — the campaign has no calling days set',
    },
  ];
  return {
    title: `${campaign} is outside its calling hours`,
    facts,
    consequence:
      'If you call anyway, the call is logged with your name and your note, and your supervisor can see it.',
    noteLabel: 'Why does this call have to go ahead now?',
    confirmLabel: 'Call anyway',
  };
}
