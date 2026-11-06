/**
 * The customer-history export (`POST /proxy/agency/customers/export`): the timeline the caller can
 * see, under the filters, as CSV. PURE. Headers are British English; wire codes (outcomes,
 * disposition codes) are written as they are, never respelled. Every cell goes through
 * `escapeCsvValue` (RFC 4180 quoting plus the spreadsheet-formula guard, `agency-csv.ts`): the
 * file leaves the organisation and carries agent-typed notes.
 *
 * What the caller cannot see in the page is not in the file either (CH8): hidden notes read
 * "Hidden", no call-page link, no DNC reason without `agency.dnc.read`.
 */
import type { CustomerTimelineEntry } from '@magick-agency/contracts/api/agency/customer-history';
import { toCsvLine } from '../agency-csv.js';

export const CUSTOMER_HISTORY_CSV_HEADERS = [
  'When (UTC)',
  'Entry',
  'Number',
  'Account',
  'Campaign',
  'Agent',
  'Outcome',
  'Outcome code',
  'Talk time (seconds)',
  'Notes',
  'Callback due (UTC)',
  'Callback status',
  'Recording',
  'Details',
] as const;

const KIND_LABELS: Record<CustomerTimelineEntry['kind'], string> = {
  campaign_call: 'Campaign call',
  softphone_call: 'Soft-phone call',
  callback: 'Callback booked',
  dnc_mark: 'Marked do-not-call',
  roster_entry: 'Added to roster',
};

const RECORDING_LABELS = {
  available: 'Available',
  not_recorded: 'Not recorded',
  expired: 'Recording expired',
  no_call: 'No call',
} as const;

const CALLBACK_LABELS = {
  kept: 'Kept',
  late: 'Late',
  missed: 'Missed',
  upcoming: 'Upcoming',
  due: 'Due now',
} as const;

const DNC_SCOPE_LABELS = { tenant: 'Whole workspace', account: 'Account', campaign: 'Campaign' } as const;

const s = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

function notesCell(notes: string | null, hidden: boolean): string {
  if (hidden) return 'Hidden';
  return s(notes);
}

/** One CSV row for one entry. `accountName` resolves an account id to its name. */
function customerHistoryCsvRow(
  entry: CustomerTimelineEntry,
  number: string,
  accountName: (id: string | null) => string | null,
): string[] {
  const base = [entry.at, KIND_LABELS[entry.kind], number, s(accountName(entry.account_id))];
  switch (entry.kind) {
    case 'campaign_call': {
      const details: string[] = [`Attempt ${entry.attempt_number}`];
      if (entry.redial_number > 0) details.push(`Wrap-up redial ${entry.redial_number}`);
      if (entry.override_applied.length > 0) details.push(`Overrides: ${entry.override_applied.join(', ')}`);
      if (entry.override_note) details.push(`Override note: ${entry.override_note}`);
      return [
        ...base, entry.campaign.name, s(entry.agent?.name ?? entry.agent?.user_id), s(entry.outcome),
        s(entry.disposition_code), s(entry.talk_seconds), notesCell(entry.notes, entry.notes_hidden),
        s(entry.callback_at), '', RECORDING_LABELS[entry.recording], details.join('; '),
      ];
    }
    case 'softphone_call': {
      const details: string[] = [];
      if (entry.fields) {
        for (const [k, v] of Object.entries(entry.fields)) details.push(`${k}: ${v === null ? '' : String(v)}`);
      }
      if (entry.dnc_override_note) details.push(`Called despite do-not-call: ${entry.dnc_override_note}`);
      if (entry.hours_override_note) details.push(`Called outside calling hours: ${entry.hours_override_note}`);
      return [
        ...base, s(entry.campaign?.name), s(entry.agent?.name ?? entry.agent?.user_id), s(entry.outcome),
        s(entry.disposition_code), s(entry.talk_seconds), notesCell(entry.notes, entry.notes_hidden),
        s(entry.callback_at), '', RECORDING_LABELS[entry.recording], details.join('; '),
      ];
    }
    case 'callback':
      return [
        ...base, s(entry.campaign?.name), s(entry.booked_by?.name ?? entry.booked_by?.user_id), '', '', '', '',
        entry.due_at, CALLBACK_LABELS[entry.status], '',
        entry.dialled_at ? `Next call ${entry.dialled_at}` : '',
      ];
    case 'dnc_mark': {
      const e = entry.entry;
      const details = [`Level: ${DNC_SCOPE_LABELS[e.scope]}`, `Source: ${e.source}`];
      if (e.added_by) details.push(`Added by: ${e.added_by}`);
      if (e.reason) details.push(`Reason: ${e.reason}`);
      return [...base, s(e.campaign?.name), '', '', '', '', '', '', '', '', details.join('; ')];
    }
    case 'roster_entry':
      return [
        ...base, entry.campaign.name, '', '', '', '', '', '', '', '',
        entry.upload_file_name ? `Upload: ${entry.upload_file_name}` : '',
      ];
  }
}

/** The whole file: header line, then one line per entry. */
export function customerHistoryCsv(
  entries: readonly CustomerTimelineEntry[],
  number: string,
  accountName: (id: string | null) => string | null,
): string {
  let out = toCsvLine([...CUSTOMER_HISTORY_CSV_HEADERS]);
  for (const e of entries) out += toCsvLine(customerHistoryCsvRow(e, number, accountName));
  return out;
}
