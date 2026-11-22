import { dncScopeWords } from './dncScopeWords';
import type {
  CustomerCallbackStatus,
  CustomerHistoryCampaign,
  CustomerHistoryDncEntry,
  CustomerHistoryErrorCode,
  CustomerHistoryOpenOverride,
  CustomerRecordingState,
  CustomerTimelineChannel,
  CustomerTimelineInboundCall,
} from '@magick-agency/contracts/api/agency/customer-history';
import {
  CUSTOMER_HISTORY_ERROR_CODES,
  CUSTOMER_TIMELINE_CHANNEL_LABELS,
} from '@magick-agency/contracts/api/agency/customer-history';
import type { AgencyOverrideKind } from '@magick-agency/contracts/agency/session';
import type { SearchCountry } from '@magick-agency/domain/customer-search-number';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { ApiError } from '../api/client';
import { dateFormatter, upperDayPeriod } from './format/date';
import { followUpWords, inboundWhatHappened } from './agency/callLog';
import { actorName } from './agency/insights/copy';
import { formatTalkTime } from './agencySpineCopy';

/**
 * The words of the customer-history box and page (`docs/customer-history.md`).
 * British English; wire codes are never respelled.
 */

/** The box's two always-visible lines (CH5), the first naming the picked country's code. */
export function customerSearchHelperLines(country: SearchCountry): [string, string] {
  return [
    `Type the full mobile number. You can include or leave out +${country.callingCode}, spaces, dashes or a leading 0.`,
    'For a number from another country, pick the country or start with + and the country code.',
  ];
}

export function customerSearchPreview(formatted: string): string {
  return `We'll search for ${formatted}`;
}

function retryWait(seconds: number | null | undefined): string {
  return seconds != null && Number.isFinite(seconds) && seconds > 0
    ? `Try again in ${Math.ceil(seconds)} ${Math.ceil(seconds) === 1 ? 'second' : 'seconds'}.`
    : 'Try again in a minute.';
}

/** CH11: the per-user search cap, hit by a search. */
function customerSearchRateLimitMessage(seconds: number | null | undefined): string {
  return `You've searched a lot of numbers in a short time. ${retryWait(seconds)}`;
}

/**
 * Which request was refused, for a 429's words. The search cap (`chs:<user id>`,
 * CH11) is charged by `search` and `export`, and the server's 429 on either reads
 * "You've searched a lot of numbers in a short time" (an export is a lookup of
 * the number too), so both say that here. `timeline` pages are not charged to the
 * cap: a 429 there is the general per-user limit and must not blame searching.
 */
export type CustomerHistoryRequestKind = 'search' | 'export' | 'timeline';

function customerHistoryRateLimitMessage(kind: CustomerHistoryRequestKind, seconds: number | null | undefined): string {
  switch (kind) {
    case 'search':
    case 'export':
      return customerSearchRateLimitMessage(seconds);
    case 'timeline':
      return `Too many requests in a short time. ${retryWait(seconds)}`;
  }
}

/**
 * `summary.contacts_truncated`: the history (summary, timeline and export) covers the number's newest 2,000
 * roster rows (`CUSTOMER_HISTORY_MAX_CONTACT_ROWS`, CH14).
 */
export const CONTACTS_TRUNCATED_NOTE =
  'This number is on more than 2,000 roster rows. This history covers the 2,000 most recent.';

const SEARCH_EXPIRED_MESSAGE = 'This search has expired. Search the number again.';

type CustomerHistoryRefusal =
  | { kind: 'rate_limited'; message: string }
  | { kind: 'search_expired'; message: string }
  | { kind: 'refused'; code: CustomerHistoryErrorCode; message: string }
  | { kind: 'other'; message: string };

function isFamilyCode(code: unknown): code is CustomerHistoryErrorCode {
  return typeof code === 'string' && (CUSTOMER_HISTORY_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Any error from `api/customerHistory.ts`, as the words to show. Only
 * `invalid_number`'s message is shown as the server wrote it: it is the shared
 * rule's British-English refusal (`searchNumberErrorMessage`). The other family
 * codes carry a validator's developer text ("from must be before to"), so they
 * show `fallback`.
 */
export function customerHistoryRefusal(
  err: unknown,
  fallback: string,
  kind: CustomerHistoryRequestKind,
): CustomerHistoryRefusal {
  if (err instanceof ApiError) {
    if (err.statusCode === 429) {
      return { kind: 'rate_limited', message: customerHistoryRateLimitMessage(kind, err.retryAfterSeconds) };
    }
    const details = (typeof err.details === 'object' && err.details !== null ? err.details : {}) as Record<string, unknown>;
    const code = details['code'];
    if (code === 'search_expired') return { kind: 'search_expired', message: SEARCH_EXPIRED_MESSAGE };
    if (isFamilyCode(code)) {
      const serverMessage = typeof details['message'] === 'string' ? details['message'] : '';
      const message = code === 'invalid_number' && serverMessage ? serverMessage : fallback;
      return { kind: 'refused', code, message };
    }
  }
  return { kind: 'other', message: getErrorMessage(err, fallback) };
}

const WHEN: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/**
 * `5 Nov 2026, 11:20 AM`, on the reader's clock. AM / PM in capitals, the house style (AS15,
 * `upperDayPeriod`): the page's inbound rows say their times as the Call log does, and one page
 * never mixes the two.
 */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return upperDayPeriod(dateFormatter(WHEN).format(date));
}

/** The contract's words: "Campaign call", "Soft-phone call", "Inbound call". */
export const CHANNEL_LABELS: Record<CustomerTimelineChannel, string> = CUSTOMER_TIMELINE_CHANNEL_LABELS;

/** The Channel filter's choices: every channel (the default), then each alone. */
export const CHANNEL_FILTER_ALL_LABEL = 'Every call type';

/** The summary's line under the totals when no call was ever placed to the number. */
export function neverContactedLabel(inboundCalls: number): string {
  return inboundCalls > 0 ? 'We have not called this number' : 'Never contacted';
}

/**
 * An inbound entry's facts, in the Call log's own words (`inboundWhatHappened`, `followUpWords`,
 * `utils/agency/callLog.ts`): what happened with its detail, who has the call when nobody answered,
 * the number they rang, the voicemail's length, and where the follow-up stands.
 */
export function inboundEntryCopy(entry: CustomerTimelineInboundCall): {
  /** "Answered · waited 0:18", "Missed · nobody free to answer · waited 1:40", or "Missed" alone. */
  happened: string;
  agent: string;
  rang: string;
  voicemail: string | null;
  followUp: string | null;
  calledBack: string | null;
  open: boolean;
} {
  const happened = inboundWhatHappened(entry);
  const followUp = followUpWords({ calledBackAt: entry.called_back_at, arrivedAt: entry.at, followUp: entry.follow_up });
  const assignee = entry.follow_up?.assignee;
  return {
    // A call that could not be answered and left no Missed row has no reason and no wait to add:
    // "Missed", never "Missed · ".
    happened: happened.detail ? `${happened.text} · ${happened.detail}` : happened.text,
    agent: entry.agent
      ? `Answered by ${actorName(entry.agent)}`
      : assignee ? `Nobody answered · assigned to ${actorName(assignee)}` : 'Nobody answered',
    rang: entry.route_name ? `Rang ${entry.line_e164} (${entry.route_name})` : `Rang ${entry.line_e164}`,
    voicemail: entry.voicemail_seconds === null ? null : `Voicemail ${formatTalkTime(entry.voicemail_seconds)}`,
    followUp: followUp.status,
    calledBack: followUp.calledBack,
    open: followUp.open,
  };
}

/** `Calls received 3 · 2 answered`'s second half. */
export function inboundAnsweredLabel(answered: number): string {
  return `${answered} answered`;
}

export const RECORDING_LABELS: Record<CustomerRecordingState, string> = {
  available: 'Recording available',
  not_recorded: 'Not recorded',
  expired: 'Recording expired',
  // The contract: `no_call` means nothing was placed, so there was no call to record.
  no_call: 'No call placed',
};

export const CALLBACK_STATUS_LABELS: Record<CustomerCallbackStatus, string> = {
  kept: 'Kept',
  late: 'Dialled late',
  missed: 'Missed',
  upcoming: 'Upcoming',
  due: 'Due now',
};

/** `October dues (retry 1)`, or the chain: `October dues → October dues (retry 1)`. */
export function campaignChainLabel(campaigns: readonly CustomerHistoryCampaign[]): string {
  return campaigns.map((c) => c.name).join(' → ');
}

/**
 * Where a DNC entry applies, in the words every surface uses (`dncScopeWords`, DS7): `Every
 * campaign`, `North account`, `Campaign: Q4 Renewals`. A campaign entry adds its account in
 * brackets, since the history spans the accounts the caller can see.
 */
export function dncScopeLabel(entry: CustomerHistoryDncEntry): string {
  if (entry.scope === 'account' && !entry.account_name?.trim()) return 'An account';
  const words = dncScopeWords(entry.scope, {
    accountName: entry.account_name,
    campaignName: entry.campaign?.name,
    unnamedCampaign: 'A campaign',
  });
  return entry.scope === 'campaign' && entry.account_name ? `${words} (${entry.account_name})` : words;
}

/** What an unspent override grants: `2 extra attempts, retry delay waived`. */
export function overrideGrantLabel(override: CustomerHistoryOpenOverride): string {
  const parts: string[] = [];
  if (override.extra_attempts > 0) {
    parts.push(`${override.extra_attempts} extra ${override.extra_attempts === 1 ? 'attempt' : 'attempts'}`);
  }
  if (override.retry_delay) parts.push('retry delay waived');
  if (override.calling_hours) parts.push('calling hours waived');
  return parts.length > 0 ? parts.join(', ') : 'no extra allowance';
}

/** An open override's follow-up: when the contact is next due to be dialled. */
export function overrideFollowUpLabel(override: Pick<CustomerHistoryOpenOverride, 'follow_up_at'>): string {
  return override.follow_up_at ? `Follow-up ${formatWhen(override.follow_up_at)}` : 'No follow-up scheduled';
}

const OVERRIDE_APPLIED_WORDS: Record<AgencyOverrideKind, string> = {
  extra_attempts: 'extra attempt',
  retry_delay: 'retry delay waived',
  calling_hours: 'calling hours waived',
};

/** The overrides a campaign call spent. */
export function overrideAppliedLabel(applied: readonly AgencyOverrideKind[]): string {
  return applied.map((a) => OVERRIDE_APPLIED_WORDS[a] ?? a).join(', ');
}

/** A soft-phone call field's value, for display. */
export function fieldValueLabel(value: string | number | boolean | null): string {
  if (value === null) return '--';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
