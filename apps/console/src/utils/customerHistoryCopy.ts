import type {
  CustomerCallbackStatus,
  CustomerHistoryCampaign,
  CustomerHistoryDncEntry,
  CustomerHistoryErrorCode,
  CustomerHistoryOpenOverride,
  CustomerRecordingState,
  CustomerTimelineChannel,
} from '@magick-agency/contracts/api/agency/customer-history';
import { CUSTOMER_HISTORY_ERROR_CODES } from '@magick-agency/contracts/api/agency/customer-history';
import type { AgencyOverrideKind } from '@magick-agency/contracts/agency/session';
import type { SearchCountry } from '@magick-agency/domain/customer-search-number';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { ApiError } from '../api/client';
import { dateFormatter } from './format/date';

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

/** `summary.contacts_truncated`: the server kept the newest 2,000 roster rows (`CUSTOMER_HISTORY_MAX_CONTACT_ROWS`). */
export const CONTACTS_TRUNCATED_NOTE =
  'Showing the 2,000 most recent roster rows for this number. The timeline still includes every call.';

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

/** `5 Nov 2026, 11:20 am`, on the reader's clock. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateFormatter(WHEN).format(date);
}

export const CHANNEL_LABELS: Record<CustomerTimelineChannel, string> = {
  campaign: 'Campaign call',
  softphone: 'Soft-phone call',
};

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

/** Where a DNC entry applies. */
export function dncScopeLabel(entry: CustomerHistoryDncEntry): string {
  switch (entry.scope) {
    case 'tenant':
      return 'Every account';
    case 'account':
      return `Account: ${entry.account_name ?? 'an account'}`;
    case 'campaign':
      return `Campaign: ${entry.campaign?.name ?? 'a campaign'}${entry.account_name ? ` (${entry.account_name})` : ''}`;
  }
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
