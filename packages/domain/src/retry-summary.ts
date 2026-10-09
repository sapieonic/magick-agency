/**
 * ─── THE AGENT'S RETRY BANNER, RENDERED CORE-SIDE ───────────────────────────
 *
 * *Retry 1 of "Q3 Winback" — these contacts were previously voicemail, callback,
 * no answer, busy.*
 *
 * The second half of that line is built HERE, from the frozen
 * `agency_campaigns.retry_selector`, and shipped on `AgencySessionBootstrap`. It
 * is deliberately not composed by the console from the raw selector: the copy the
 * agent reads and the query that actually produced the roster must not be able to
 * disagree, and only core holds the selector that produced it. Migration 108's
 * header makes the same argument for the lifecycle columns — this is the
 * campaign's own fact.
 *
 * A LEAF module: pure functions over the selector and a catalog, no I/O, no
 * repository. Same posture as `spine-filters.ts` and for the same reason — the
 * rendering rules can be exercised without a Fastify instance or a pool.
 */

import type { AgencyAttemptOutcome, AgencyDisposition, AgencyRetrySelector } from '@magick-agency/contracts/agency';
import { RETRY_NO_OUTCOME } from '@magick-agency/contracts/agency';

/**
 * The console's outcome copy, mirrored.
 *
 * ⚠️ **A HAND-MIRRORED TABLE**, like the four the platform already carries
 * (`agency.md` §6.2/§6.4). Its twin is `ATTEMPT_OUTCOME_LABELS` in
 * `magick-comms-cusui/src/types/agency-spine.ts`, and the wire contract §4
 * requires this string to be rendered "with the console's existing outcome copy"
 * so that all three repos read the same sentence.
 *
 * **Drift here is cosmetic, not functional**, which is the one thing that makes
 * a fifth mirror acceptable: nothing keys on these strings, no filter is built
 * from them, and the worst outcome is a banner reading "no answer" where the
 * Contacts tab says "No answer". That is a materially smaller failure than the
 * error-code union's, where a missing member destroys an explanation. Recorded
 * rather than hidden: if a sixth reader appears, this belongs in the S2S
 * fixture instead.
 *
 * `Record<AgencyAttemptOutcome, string>` rather than a partial map, so an outcome
 * added to `contracts.ts` and forgotten here is a build error naming it — the same
 * inverted check `spine-filters.ts`'s `vocabulary()` exists for.
 */
const OUTCOME_COPY: Record<AgencyAttemptOutcome, string> = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  machine: 'Answering machine',
  invalid: 'Invalid number',
  abandoned: 'Abandoned (no agent free)',
  agent_disconnected: 'Agent disconnected',
  orphaned: 'Interrupted by a system fault',
  // Says WHEN it was cancelled, not just that it was, because that is
  // the whole distinction from the two neighbours a supervisor is picking
  // between in the same list: "No answer" means the customer let it ring out,
  // "Abandoned (no agent free)" means they picked up and got nobody, and this
  // means the phone stopped ringing because we stopped it. A bare "Cancelled"
  // would leave a supervisor building a retry list unable to tell the first
  // from the third — which is what these contacts have in common (nothing was
  // learned about the number) and why they are worth re-dialling.
  // **Names the actor, deliberately.** "Cancelled before answer" alone omits WHO,
  // and on a reporting surface the most available reading of "Cancelled" on a phone
  // call is that the CUSTOMER declined — which inverts the retry decision this
  // label exists to inform. A decline is information about the number (they are
  // screening); our own cancel is not, which is the whole basis for re-dialling.
  // Every neighbour here names an actor or a mechanism ("Agent disconnected",
  // "Abandoned (no agent free)"), so this one was the odd entry out.
  canceled: 'Stopped by us before answer',
};

/**
 * One phrase for one fact. `never_attempted: true` and the `__none__` member of
 * the outcome dimension describe the same contact — nobody dialled it — so they
 * render identically, and a selector carrying both says it once.
 */
const NEVER_ATTEMPTED_COPY = 'never attempted';

/** Contact-state copy, for the fallback arm below. Same mirroring note applies. */
const CONTACT_STATE_COPY: Record<string, string> = {
  pending: 'Not yet called',
  in_flight: 'Being called',
  connected: 'Connected',
  completed: 'Completed',
  exhausted: 'Out of attempts',
  suppressed: 'Suppressed',
};

/** Suppression copy, for the fallback arm. `dnc`/`invalid` cannot occur (DR-4). */
const SUPPRESSED_REASON_COPY: Record<string, string> = {
  max_attempts: 'Out of attempts',
  manual: 'Manually suppressed',
};

/**
 * Lower-case the FIRST character only, so the label reads inside a sentence.
 *
 * Not `toLocaleLowerCase()` on the whole token, which is the obvious spelling and
 * is wrong for operator-authored disposition labels: a catalog entry reading
 * "VM Left" or "NRI Callback" would come out as "vm left" / "nri callback". The
 * leading character is the only one that is capitalised *because it starts a
 * label*; every other capital in the string was chosen by whoever wrote it.
 */
function decapitalize(value: string): string {
  return value.length > 0 ? value[0]!.toLocaleLowerCase() + value.slice(1) : value;
}

/**
 * Look up console copy for a key that came out of the DATABASE.
 *
 * `Object.hasOwn` before the index, and that is load-bearing rather than
 * hygiene. `retry_selector` is JSONB holding whatever a past release — or a
 * hand-run `UPDATE` — wrote, so `last_outcome: ['constructor']` is a value this
 * function can genuinely be handed. A bare `MAP[key] ?? key` then resolves the
 * INHERITED `Object` constructor, which is not nullish, so the `??` fallback
 * never fires and `decapitalize` is called on a function: `value.length` is 1,
 * `value[0]` is `undefined`, and `.toLocaleLowerCase()` throws.
 *
 * That would be a `TypeError` on the SESSION BOOTSTRAP — the payload between an
 * agent clicking join and the console rendering — turning a cosmetic banner into
 * a 500 that stops them working. `readSelector` is written to guarantee this
 * function cannot throw; accepting every non-empty string and then indexing a
 * plain object literal was the one hole left in that guarantee.
 *
 * Returns the raw key when the map has no OWN entry, which is the same fallback
 * the call sites already wanted: an unrecognised slug beats a dropped dimension.
 */
function copy(map: Record<string, string>, key: string): string {
  return Object.hasOwn(map, key) ? map[key]! : key;
}

/**
 * Read a `retry_selector` back off the campaign row.
 *
 * The column is JSONB and typed `unknown` on the record, so it holds whatever a
 * past release wrote. Every field is narrowed defensively rather than cast: this
 * runs on the session bootstrap, which is the payload between "an agent clicks
 * join" and "the console renders", and a `TypeError` from an unexpected shape
 * would turn a cosmetic banner into a 500 that stops an agent working. An
 * unreadable field is simply absent from the summary.
 */
function readSelector(value: unknown): AgencyRetrySelector {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const strings = (key: string): string[] | undefined => {
    const list = raw[key];
    if (!Array.isArray(list)) return undefined;
    const kept = list.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return kept.length > 0 ? kept : undefined;
  };
  const state = strings('state');
  const lastOutcome = strings('last_outcome');
  const lastDisposition = strings('last_disposition');
  const suppressedReason = strings('suppressed_reason');
  const gte = typeof raw['attempt_count_gte'] === 'number' ? raw['attempt_count_gte'] : undefined;
  const lte = typeof raw['attempt_count_lte'] === 'number' ? raw['attempt_count_lte'] : undefined;
  return {
    ...(state ? { state: state as AgencyRetrySelector['state'] } : {}),
    ...(lastOutcome ? { last_outcome: lastOutcome as AgencyRetrySelector['last_outcome'] } : {}),
    ...(lastDisposition ? { last_disposition: lastDisposition } : {}),
    ...(suppressedReason ? { suppressed_reason: suppressedReason } : {}),
    ...(typeof raw['never_attempted'] === 'boolean' ? { never_attempted: raw['never_attempted'] } : {}),
    ...(gte !== undefined ? { attempt_count_gte: gte } : {}),
    ...(lte !== undefined ? { attempt_count_lte: lte } : {}),
  };
}

/**
 * Render a frozen selector as the banner's second half.
 *
 * ── The order is fixed by the wire contract (§4) ───────────────────────────
 *
 * Disposition labels first (from the PARENT's catalog where one exists, else the
 * raw code), then outcomes in the console's copy, then `never attempted` —
 * comma-separated. The parent's catalog is used rather than the child's because
 * the selector was authored against the parent's roster, and a code the parent
 * had but the child does not would otherwise render as a bare slug.
 *
 * ── The fallback arm, which the contract does not specify ─────────────────
 *
 * §4's three dimensions do not cover the whole selector: `state`,
 * `suppressed_reason` and the two `attempt_count` bounds are legitimate selectors
 * that render to NOTHING under those rules. `{ state: ['exhausted'] }` is a
 * perfectly ordinary retry, and it would produce the banner *Retry 1 of "Q3
 * Winback" — * with a trailing dash and no reason.
 *
 * So the three contract dimensions are rendered exactly as specified, and the
 * remaining ones are appended ONLY when those three produced nothing. Core is the
 * sole producer of this string (§4 is explicit that it is built core-side), so
 * extending it for a case the contract leaves empty cannot put core out of step
 * with anyone — and an empty summary is the one outcome that is definitely wrong.
 *
 * The empty string remains reachable in exactly one case: a stored selector that
 * narrows to nothing readable (a shape from another release). The caller treats
 * that as "no banner" rather than rendering a dangling sentence.
 */
export function renderSelectionSummary(
  storedSelector: unknown,
  parentCatalog: readonly AgencyDisposition[],
): string {
  const selector = readSelector(storedSelector);
  const parts: string[] = [];

  for (const code of selector.last_disposition ?? []) {
    const entry = parentCatalog.find((d) => d.code === code);
    // The raw code when the catalog has no entry (retired since, or a built-in
    // the operator never listed) — a slug the agent may not recognise still beats
    // silently dropping a dimension that shaped the roster.
    parts.push(decapitalize(entry?.label?.trim() || code));
  }
  for (const outcome of selector.last_outcome ?? []) {
    // `__none__` is a member of this dimension, not an outcome, so it has no
    // entry in `OUTCOME_COPY` — and the raw key is the one string an agent must
    // never be shown. It reads to a human exactly as `never_attempted` does, so
    // it borrows that wording rather than inventing a second phrase for one
    // fact.
    if (outcome === RETRY_NO_OUTCOME) {
      parts.push(NEVER_ATTEMPTED_COPY);
      continue;
    }
    parts.push(decapitalize(copy(OUTCOME_COPY, outcome)));
  }
  // De-duplicated against the `__none__` branch above: a selector carrying both
  // spellings is legal and means one thing.
  if (selector.never_attempted === true && !parts.includes(NEVER_ATTEMPTED_COPY)) {
    parts.push(NEVER_ATTEMPTED_COPY);
  }

  if (parts.length > 0) return parts.join(', ');

  // ── Fallback: the dimensions §4's rules do not name ──────────────────────
  const rest: string[] = [];
  for (const state of selector.state ?? []) {
    rest.push(decapitalize(copy(CONTACT_STATE_COPY, state)));
  }
  for (const reason of selector.suppressed_reason ?? []) {
    rest.push(decapitalize(copy(SUPPRESSED_REASON_COPY, reason)));
  }
  if (selector.never_attempted === false) rest.push('already attempted');
  const { attempt_count_gte: gte, attempt_count_lte: lte } = selector;
  if (gte !== undefined && lte !== undefined) rest.push(`${gte}–${lte} attempts`);
  else if (gte !== undefined) rest.push(`${gte} or more attempts`);
  else if (lte !== undefined) rest.push(`${lte} or fewer attempts`);

  return rest.join(', ');
}
