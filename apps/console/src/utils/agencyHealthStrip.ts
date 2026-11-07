import type { AgencyStall, AgencyStallCode } from '../types/agency-campaign';
import type { CarrierAccountPauseReason } from '@magick-agency/contracts/agency';
import { formatCount, pct, plural } from './format/number';
import { ceilingPctText } from './agency/abandonmentCeiling';

/**
 * The supervisor health strip and the two read-outs beside it — as pure functions, because every sentence here is derived from wire
 * evidence and every derivation is a place to be confidently wrong.
 *
 * ── Why a module and not JSX ────────────────────────────────────────────────
 * The strip's whole value is that it names the campaign's own numbers back to
 * the supervisor. That makes the copy a *function of the payload*, not a
 * template — and the ranking decides which single sentence they read at all.
 * Both are testable propositions, so they are tested rather than eyeballed.
 *
 * ── One diagnosis ───────────────────────────────────────────────────────────
 * The server sends one `stall` plus the codes that also matched. A supervisor reading
 * five simultaneous problems acts on none of them, so the strip shows the top
 * one and files the rest behind a count.
 */

/**
 * Priority order, first match wins — mirrored from the server's
 * `AGENCY_STALL_PRIORITY` (`src/agency/contracts.ts`).
 *
 * The ranking is by **what a supervisor should do about it**, not by severity: a
 * compliance stop outranks a staffing problem, which outranks a capacity one,
 * because acting on the wrong one wastes the minutes the strip exists to save.
 *
 * This is the console's own copy of the order and it is used to SORT
 * `other_stalls` rather than trusting the array's arrival order. The server does send
 * them ranked; relying on that would mean a producer-side reorder silently
 * changes what a supervisor reads, with nothing here going red.
 */
export const AGENCY_STALL_PRIORITY: readonly AgencyStallCode[] = [
  'auto_paused_abandonment',
  'auto_paused_carrier',
  'no_dialable_caller_ids',
  'no_carrier_capacity',
  'dnc_unavailable',
  'no_agents_available',
  'concurrency_saturated',
  'outside_calling_hours',
  'list_exhausted_retries_pending',
  // There is no `credits_low` stall code: there are no credits yet, and it comes
  // back with metering.
  'elevated_failure_rate',
] as const;

/** Short names for the "more issues" disclosure. One line each, no evidence. */
export const AGENCY_STALL_LABELS: Record<AgencyStallCode, string> = {
  auto_paused_abandonment: 'Paused by the abandonment limit',
  auto_paused_carrier: 'Paused: the carrier account cannot place calls',
  no_dialable_caller_ids: 'No caller ID available on the carrier account',
  no_carrier_capacity: 'No call capacity on this carrier',
  dnc_unavailable: 'Do Not Call check unavailable',
  no_agents_available: 'No agents available',
  concurrency_saturated: 'At the concurrency limit',
  outside_calling_hours: 'Outside calling hours',
  list_exhausted_retries_pending: 'Waiting on scheduled retries',
  elevated_failure_rate: 'Unusually many failed calls',
};

/**
 * Sort codes into the priority order and drop anything unrecognised.
 *
 * Unknown codes are dropped rather than appended: a code this build has no label
 * for renders as nothing useful, and a supervisor counting "3 more issues" and
 * finding two names would trust the strip less than one that says two. A newer
 * server adding a ninth condition is a console change, not a runtime surprise.
 */
export function sortStallCodes(codes: readonly AgencyStallCode[]): AgencyStallCode[] {
  const rank = new Map(AGENCY_STALL_PRIORITY.map((code, index) => [code, index]));
  return codes
    .filter((code) => rank.has(code))
    .slice()
    .sort((a, b) => rank.get(a)! - rank.get(b)!);
}

/**
 * One fact in the evidence run.
 *
 * `text` is the whole fact and is the only thing anybody READS — `emphasis` is a
 * substring of it that the eye should land on (a count, a rate, an instant), and
 * is presentational only. Deliberately a substring rather than a separate field:
 * it cannot desynchronise from the sentence, and a substring that fails to match
 * degrades to an unemphasised fact rather than to a wrong or missing one.
 */
export interface StallFact {
  text: string;
  emphasis?: string;
}

/** `text` split around its emphasised value, ready to wrap in a `<strong>`. */
export interface EmphasisedFact {
  before: string;
  value: string;
  after: string;
}

/**
 * Split a fact at its emphasised value. An absent or unmatched `emphasis`
 * returns the whole sentence as `before` with an empty `value`, so a renderer
 * never has to decide what to do about a miss.
 */
export function splitFact(fact: StallFact): EmphasisedFact {
  const { text, emphasis } = fact;
  if (!emphasis) return { before: text, value: '', after: '' };
  const at = text.indexOf(emphasis);
  if (at === -1) return { before: text, value: '', after: '' };
  return { before: text.slice(0, at), value: emphasis, after: text.slice(at + emphasis.length) };
}

/**
 * One diagnosis, rendered.
 *
 * `headline` is the sentence; `facts` are the campaign's own numbers restated so
 * the supervisor can check the claim, as a run of short items rather than a
 * paragraph; `advice` is what to do, and is omitted where there is nothing
 * honest to suggest.
 *
 * `evidence` is `facts` joined — the same words, as one string, for a caller
 * that wants a sentence. It is derived from `facts` and can never disagree
 * with them.
 */
export interface StallCopy {
  headline: string;
  facts: StallFact[];
  evidence: string;
  advice?: string;
}

/** The visual gap between facts, as a character, for the joined `evidence`. */
const FACT_JOIN = ' · ';

function joined(facts: StallFact[]): string {
  return facts.map((fact) => fact.text).join(FACT_JOIN);
}

function diagnosis(parts: { headline: string; facts: StallFact[]; advice?: string }): StallCopy {
  return { ...parts, evidence: joined(parts.facts) };
}

/** The emphasised form of a number — the exact substring a fact leads with. */
const num = formatCount;

/** A count and its noun, agreeing (`format/number.ts`'s `plural`). */
const count = plural;

/** Break codes to a readable clause: "5 on break (lunch 3, training 2)". */
function breakClause(byReason: Record<string, number>): string | null {
  const entries = Object.entries(byReason).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  // Largest first — the reason holding the most agents is the one worth acting
  // on, and a supervisor scanning under pressure reads the head of the list.
  const detail = entries
    .slice()
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  return `${total} on break (${detail})`;
}

/**
 * What an automatic carrier-account pause says on the strip, by its reason (decisions PL2,
 * PL3). Keyed by the contract's `CarrierAccountPauseReason`, so a new automatic carrier
 * pause fails the typecheck until it has its sentence here, and that is all it needs.
 *
 * Who can fix a carrier account is the service's support, not the workspace's own
 * administrators: the advice says "contact support".
 */
export const CARRIER_PAUSE_STALL_COPY: Record<CarrierAccountPauseReason, { headline: string; advice: string }> = {
  carrier_auth: {
    headline: 'Paused automatically — the carrier refused this campaign’s carrier account.',
    advice: 'Contact support to check the carrier account’s credentials, then resume the campaign.',
  },
  carrier_account_unavailable: {
    headline: 'Paused automatically — this campaign’s carrier account is no longer active.',
    advice: 'Contact support to re-enable the carrier account, or move the campaign to another carrier in its settings, then resume it.',
  },
};

/** For a reason this build has no sentence for (a newer server): still true, still actionable. */
const CARRIER_PAUSE_FALLBACK = {
  headline: 'Paused automatically — this campaign’s carrier account cannot place calls.',
  advice: 'Contact support about the campaign’s carrier account, then resume the campaign.',
};

/**
 * The diagnosis for one stall, derived only from that arm's own evidence.
 *
 * `formatInstant` is injected rather than imported so the caller owns the
 * locale/timezone decision (and so a test can pin the output without pinning the
 * host's clock formatting).
 */
export function stallCopy(
  stall: AgencyStall,
  formatInstant: (iso: string) => string,
): StallCopy {
  switch (stall.code) {
    case 'auto_paused_abandonment': {
      const pausedAt = formatInstant(stall.paused_at);
      return diagnosis({
        headline: `Paused automatically — abandonment reached ${pct(stall.measured_pct)}, over your ${ceilingPctText(stall.ceiling_pct)} limit.`,
        // "Measured at", never "currently": The server freezes this figure at the
        // instant the guardrail fired (`paused_at` / `pause_abandonment_rate_pct`). Presenting a frozen
        // number as a live one means a supervisor who has since staffed up sees
        // no improvement and concludes the fix did not work.
        facts: [
          {
            text: `Measured at ${pausedAt}, when the limit was hit. It is not a live rate and will not move while the campaign is paused.`,
            emphasis: pausedAt,
          },
        ],
        advice: 'Get more agents on shift before resuming, or the guardrail will pause it again.',
      });
    }

    case 'auto_paused_carrier': {
      const pausedAt = formatInstant(stall.paused_at);
      const copy = (CARRIER_PAUSE_STALL_COPY as Partial<Record<string, { headline: string; advice: string }>>)[stall.reason]
        ?? CARRIER_PAUSE_FALLBACK;
      return diagnosis({
        headline: copy.headline,
        facts: [{ text: `Paused at ${pausedAt}. No calls are placed until it is resumed.`, emphasis: pausedAt }],
        advice: copy.advice,
      });
    }

    case 'no_dialable_caller_ids':
      return diagnosis({
        headline: 'Not dialling — none of this campaign’s caller IDs is available on its carrier account any more.',
        facts: [
          {
            text: `${count(stall.caller_ids_stored, 'caller ID')} chosen, none still available.`,
            emphasis: num(stall.caller_ids_stored),
          },
        ],
        advice: 'Choose numbers that are still available in the campaign’s settings, or contact support if numbers are missing.',
      });

    case 'no_carrier_capacity':
      return diagnosis({
        headline: 'Not dialling — this account has no call capacity on the campaign’s carrier.',
        facts: [{ text: 'Every call on this carrier is refused until capacity is added.' }],
        advice: 'Contact support to add capacity for this carrier, or move the campaign to another carrier in its settings.',
      });

    case 'dnc_unavailable':
      return diagnosis({
        headline: 'Dialing has stopped — the Do Not Call check is unavailable.',
        facts: [
          {
            text: stall.tenant_wide
              ? 'The Do Not Call list is shared across this whole workspace, so every campaign in it is stopped by the same fault.'
              : 'The Do Not Call list could not be read.',
          },
        ],
        advice: 'Nothing to change here — dialing resumes on its own once the check is back. Contact support if it persists.',
      });

    case 'no_agents_available': {
      const breaks = breakClause(stall.on_break_by_reason);
      const facts: StallFact[] = [
        { text: `${count(stall.agents_on_shift, 'agent')} on shift`, emphasis: num(stall.agents_on_shift) },
        // `num()` like every other count on this run. A raw interpolation drops
        // the thousands separator, so a large floor read "1234 on a call" beside
        // "1,234 agents on shift" — and the emphasis substring then failed to
        // match the formatted text it was supposed to bolden.
        { text: `${num(stall.on_call)} on a call`, emphasis: num(stall.on_call) },
      ];
      if (breaks) facts.push({ text: breaks, emphasis: breaks.split(' ')[0] });
      // `last_dial_at: null` is "never dialed", which is a different problem
      // from "stopped dialing an hour ago" and points at a different fix.
      //
      // This is EVIDENCE, not advice: it is a fact about the campaign the
      // supervisor can check, and it sat in `advice` — a field whose whole
      // contract is "what to do" — only because there was nowhere else to put
      // it. What to do about an empty floor is now the "Open the floor" link,
      // which is a real affordance rather than a sentence.
      facts.push(
        stall.last_dial_at
          ? {
              text: `Last call placed at ${formatInstant(stall.last_dial_at)}`,
              emphasis: formatInstant(stall.last_dial_at),
            }
          : { text: 'This campaign has never placed a call' },
      );
      return diagnosis({ headline: 'Nobody is free to take a call.', facts });
    }

    case 'concurrency_saturated':
      return diagnosis({
        headline: `At your concurrency limit — ${stall.in_use} of ${stall.limit} lines in use.`,
        facts: [
          { text: 'The limit is account-wide, so other calls in this workspace count against it too.' },
        ],
        // `shift_seconds`: there is no tenant-facing setter, so the honest advice names who
        // can change it rather than implying the supervisor can.
        advice: 'Calls resume as lines free up. Raising the limit is a support request.',
      });

    case 'outside_calling_hours':
      return diagnosis({
        headline: 'Outside calling hours for everyone left on the list.',
        facts: [
          {
            text: `${count(stall.contacts_waiting, 'contact')} waiting for their local calling window.`,
            emphasis: num(stall.contacts_waiting),
          },
        ],
        advice: stall.next_window_opens_at
          ? `The next window opens at ${formatInstant(stall.next_window_opens_at)}.`
          : 'No upcoming window resolves for these contacts — check the campaign’s calling days and timezone.',
      });

    case 'list_exhausted_retries_pending':
      return diagnosis({
        headline: 'Nothing to dial right now — everything left is waiting on a retry.',
        facts: [
          {
            text: `${count(stall.retries_pending, 'retry', 'retries')} scheduled.`,
            emphasis: num(stall.retries_pending),
          },
        ],
        advice: stall.next_retry_at
          ? `The next one is due at ${formatInstant(stall.next_retry_at)}.`
          : 'No retry time is set — add contacts if you need this campaign dialing now.',
      });

    // There is no `credits_low` arm ("Credit is running low.", "Top up before
    // the balance runs out…"): there is no such stall code while there are no
    // credits yet.

    case 'elevated_failure_rate':
      return diagnosis({
        headline: `${pct(stall.failed_pct)} of recent calls failed.`,
        facts: [
          {
            text: `${count(stall.attempts, 'attempt')} in the last ${count(stall.window_minutes, 'minute')}.`,
            emphasis: num(stall.attempts),
          },
        ],
        advice: 'Often a carrier problem rather than the list. Check the caller IDs on this campaign, then contact support.',
      });
  }
}
