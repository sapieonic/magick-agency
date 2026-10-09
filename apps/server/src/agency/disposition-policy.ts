import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { RetryDecision } from './retry-policy.js';

/**
 * ─── AGENCY DIALER — DISPOSITION SEMANTICS (§2.4, `AD-P3-C-02`) ──────────────
 *
 * `AD-P2-C-04` landed disposition *capture*; this is the half that decides what a
 * captured disposition MEANS for the contact. §2.4 fixes the precedence in one
 * sentence:
 *
 * > a disposition's `retry`/`terminal`/`suppress` always overrides the outcome
 * > policy; the outcome policy applies only when no disposition was recorded
 * > (every non-answered call, plus the reaper's `no_disposition`).
 *
 * So {@link resolveRetryDecision} and {@link resolveDispositionDecision} are
 * siblings returning the same {@link RetryDecision}, and the caller picks by
 * asking one question — was a disposition recorded — rather than by merging two
 * partial answers. Deliberately: a precedence rule implemented as a merge is one
 * nobody can read off the code.
 *
 * Pure. No clock beyond an injected `now`, no I/O, no repository — for the same
 * reason `retry-policy.ts` is: a delay computed off an ambient clock cannot be
 * asserted with an exact value (§16.6).
 */

/**
 * §2.4's three named codes, as the semantics they are supposed to carry.
 *
 * ⚠️ **This is a reference set, NOT a fallback, and the difference was decided
 * against my own recommendation — read this before "fixing" it into a merge.**
 *
 * §2.4 says these three *"cannot be removed from a catalog … because the retry
 * engine, the scheduler and the DNC path each depend on one of them existing."*
 * **That justification is false, and it was falsified the only way it could be —
 * by grepping for consumers.** No mechanism keys on a code STRING; every one keys
 * on a FLAG:
 *
 *  - disposition-driven retry reads {@link AgencyDisposition.retry};
 *  - the callback scheduler reads `requires_datetime` / the submitted `callback_at`;
 *  - suppression reads `suppress`, and the real DNC path is the dedicated
 *    `attempts/:id/dnc` route, which never consults the catalog at all.
 *
 * A search for these three as code-string comparisons in `src/` returns nothing
 * outside prose. So **an empty catalog is a legitimate configuration** — it means
 * "outcome-driven retry, with no human write-up step" — and merging these in would
 * have deleted that capability platform-wide while contradicting `MAG-88`, which
 * preserves the no-write-up campaign on purpose.
 *
 * The finding that *led* to the near-miss is still real and still open, it just
 * belongs one layer up: `agency_campaigns.disposition_catalog` is `JSONB NOT NULL
 * DEFAULT '[]'` (migration 072) and **master never sends the field**, so every
 * campaign today has no disposition step and every submission 400s with
 * `allowed_codes: []`. That is the same shape as `retry_policy` defaulting to
 * `'{}'` in `AD-P3-C-01` — but the fix is for **master's campaign-config surface to
 * default a NEW campaign's catalog to these three** (`M-04`), not for core to
 * synthesise them on read. Defaults belong to the layer that owns configuration;
 * core's read path must keep reporting what the operator actually configured.
 *
 * Hence exported: this is the canonical wording of what that default should be, so
 * master and cusui are copying from one place rather than three.
 *
 * **The hazard this set does NOT currently guard**, stated because it is created by
 * the finding above rather than removed by it: since nothing keys on the code
 * string, a catalog entry `{code: 'do_not_call', label: 'Do not call'}` **with no
 * `suppress: true`** is a button labelled "Do not call" that does not suppress
 * anything. The customer asks never to be called again, the agent clicks the
 * obvious control, and the contact is retried on schedule. Routed as a finding
 * rather than fixed here, because a compliance floor that overrides operator
 * config is a decision, not an implementation detail.
 */
export const BUILT_IN_DISPOSITIONS: readonly AgencyDisposition[] = Object.freeze([
  // The only signal a call was answered by a machine. With AMD off (D1) the
  // carrier reports `connected`, so voicemail retry cannot be an outcome rule and
  // has to be this.
  Object.freeze({
    code: 'voicemail',
    label: 'Voicemail',
    retry: { delay_minutes: 240, max_attempts: 2 },
  }),
  // The scheduler's dependency. `requires_datetime` is what makes the console
  // collect a time, and the time is what the contact is re-queued for.
  Object.freeze({
    code: 'callback',
    label: 'Callback',
    requires_datetime: true,
  }),
  // The DNC path's dependency. `suppress` is immediate and irreversible from the
  // dialer's side.
  Object.freeze({
    code: 'do_not_call',
    label: 'Do not call',
    suppress: true,
  }),
]) as readonly AgencyDisposition[];

/** The built-in codes, as a set, for callers that only need membership. */
export const BUILT_IN_DISPOSITION_CODES: ReadonlySet<string> = new Set(
  BUILT_IN_DISPOSITIONS.map((d) => d.code),
);

/**
 * Built-in codes in a catalog whose entry is missing the flag that makes the name
 * mean anything.
 *
 * Advisory and pure — it changes no behaviour. It exists so the hazard named in
 * {@link BUILT_IN_DISPOSITIONS} is *detectable* by whoever decides what to do about
 * it (a campaign-write validator, master's `M-04` config surface, or a compliance
 * floor), rather than living only in a comment. Returns the offending codes paired
 * with the flag they lack.
 *
 * Deliberately does **not** flag a built-in code carrying different *values* —
 * `voicemail` with `max_attempts: 1` instead of 2 is an operator's business. Only a
 * missing flag is reported, because that is the case where the label promises a
 * behaviour the entry cannot deliver.
 */
export function builtInSemanticMismatches(
  catalog: AgencyDisposition[] | null | undefined,
): Array<{ code: string; missing: 'retry' | 'requires_datetime' | 'suppress' }> {
  const out: Array<{ code: string; missing: 'retry' | 'requires_datetime' | 'suppress' }> = [];
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry !== 'object' || typeof entry.code !== 'string') continue;
    if (entry.code === 'voicemail' && !entry.retry) out.push({ code: 'voicemail', missing: 'retry' });
    if (entry.code === 'callback' && entry.requires_datetime !== true) {
      out.push({ code: 'callback', missing: 'requires_datetime' });
    }
    if (entry.code === 'do_not_call' && entry.suppress !== true) {
      out.push({ code: 'do_not_call', missing: 'suppress' });
    }
  }
  return out;
}

/** Why a disposition sent the contact where it did. Distinct from `RetryReason`. */
export type DispositionReason =
  /** `suppress` — the `do_not_call` mechanism. Beats everything. */
  | 'disposition_suppressed'
  /** `terminal` — the contact is done regardless of attempts remaining. */
  | 'disposition_terminal'
  /** A callback datetime was supplied; the contact is re-queued for it. */
  | 'callback_scheduled'
  /** The disposition's own `retry` allows another attempt. */
  | 'disposition_retry_scheduled'
  /** `retry.max_attempts` is spent. */
  | 'disposition_attempts_reached'
  /** `retry: {max_attempts: 0}` — this disposition is explicitly never retried. */
  | 'disposition_not_retryable'
  /** A plain label with no `retry`/`terminal`/`suppress` and no callback. */
  | 'disposition_recorded';

/** {@link RetryDecision} with the disposition's own vocabulary for `reason`. */
export interface DispositionDecision extends Omit<RetryDecision, 'reason'> {
  reason: DispositionReason;
}

/**
 * What a recorded disposition does to the contact.
 *
 * @param entry        the resolved catalog entry — already validated against the
 *                     effective catalog by the caller.
 * @param now          injected clock; the base for a `retry` delay.
 * @param attemptsUsed attempts consumed **including the attempt just dispositioned**.
 *
 * ⚠️ `attemptsUsed` is the parameter to get wrong, and its correct value here is
 * the OPPOSITE of the dial path's. The dial path bumps `attempt_count` as part of
 * ending the attempt and passes the post-bump count; the disposition route runs
 * *after* that bump and must **not** bump again, so it passes the stored count
 * unchanged. Bumping in both places charges a contact twice for one dial and, at
 * `max_attempts: 3`, exhausts someone after two real conversations.
 *
 * @param callbackAt   the validated callback instant, or null. Kept a separate
 *                     parameter rather than re-derived from `entry.requires_datetime`
 *                     because the requirement and the value are different facts:
 *                     an operator code may accept an optional callback without
 *                     demanding one, and a code that demands one has already been
 *                     rejected by `validateDispositionFields` if it is missing.
 */
export function resolveDispositionDecision(
  entry: AgencyDisposition,
  opts: { now: Date; attemptsUsed: number; callbackAt: Date | null },
): DispositionDecision {
  // ── 1. `suppress` — strongest, and checked first on purpose. ──────────────
  // A contact who said "do not call me again" must not be re-queued because the
  // same submission also carried a callback time or the code also reads
  // `terminal`. The order is the whole safety property: every other arm can put
  // the contact back in the roster, and this one is the only arm that must be able
  // to stop that. `dnc`, not `manual` — migration 073's column comment enumerates
  // `dnc | invalid | max_attempts | manual`, and an agent recording `do_not_call`
  // on a live call IS the DNC path's entry point.
  if (entry.suppress === true) {
    return {
      contactState: 'suppressed',
      nextAttemptAt: null,
      suppressedReason: 'dnc',
      reason: 'disposition_suppressed',
    };
  }

  // ── 2. `terminal` — done, regardless of attempts left. ────────────────────
  // Ahead of the callback arm: a code that is both `terminal` and carries a
  // datetime is a contradictory catalog, and resolving it toward "stop calling"
  // is the direction that cannot annoy a customer.
  if (entry.terminal === true) {
    return {
      contactState: 'completed', nextAttemptAt: null, suppressedReason: null,
      reason: 'disposition_terminal',
    };
  }

  // ── 3. A callback the customer asked for. ─────────────────────────────────
  // Keyed on a datetime being PRESENT, not on the code being literally
  // `callback`: any operator code carrying `requires_datetime` means the same
  // thing, and hardcoding the code would make the built-in a special case the
  // rest of the catalog could not express.
  //
  // **Deliberately not subject to any attempts arithmetic.** A customer who named
  // a time is owed that call even if the outcome policy's budget is spent —
  // dropping it would have the agent promise a call that never comes, which is the
  // failure `AD-P3-C-03` exists to prevent one step later. The bound on repetition
  // is that each callback becomes a new attempt with its own disposition, so a loop
  // is an operator-visible pattern rather than an invisible one. If that turns out
  // to need a ceiling it belongs in the catalog as an explicit `retry` on the
  // callback code, not as a silent cap here.
  //
  // The caller may DEFER this instant into the contact's calling window
  // (`AD-P3-C-03`) — that is I/O and stays in the route. What is returned here is
  // what the customer was promised.
  if (opts.callbackAt !== null) {
    return {
      contactState: 'pending', nextAttemptAt: opts.callbackAt, suppressedReason: null,
      reason: 'callback_scheduled',
    };
  }

  // ── 4. The disposition's own retry — how voicemail retry works under D1. ──
  if (entry.retry) {
    const maxAttempts = Number.isFinite(entry.retry.max_attempts)
      ? Math.max(0, Math.trunc(entry.retry.max_attempts))
      : 0;

    // `max_attempts: 0` is "never retried", which is NOT the fact of having run
    // out — nothing was used up. Same distinction `resolveRetryDecision` keeps, and
    // for the same reason: `exhausted` tells a supervisor the list was worked and
    // `completed` tells them it was not retryable.
    if (maxAttempts === 0) {
      return {
        contactState: 'completed', nextAttemptAt: null, suppressedReason: null,
        reason: 'disposition_not_retryable',
      };
    }
    if (opts.attemptsUsed >= maxAttempts) {
      return {
        contactState: 'exhausted', nextAttemptAt: null, suppressedReason: null,
        reason: 'disposition_attempts_reached',
      };
    }
    // A missing `delay_minutes` is 0 — "as soon as the roster reaches it" — not a
    // fabricated default. `claimDialable` gates on `next_attempt_at <= now()`, so
    // that is re-claimable on the next tick, which is §4.2's stated behaviour.
    const delayMinutes = Number.isFinite(entry.retry.delay_minutes)
      ? Math.max(0, entry.retry.delay_minutes!)
      : 0;
    return {
      contactState: 'pending',
      nextAttemptAt: new Date(opts.now.getTime() + delayMinutes * 60_000),
      suppressedReason: null,
      reason: 'disposition_retry_scheduled',
    };
  }

  // ── 5. A plain label. ─────────────────────────────────────────────────────
  // `completed`: a disposition was recorded, so per §2.4 the outcome policy does
  // NOT get a second say — and the contact must not be left `pending` with no
  // scheduled retry, which `claimDialable` would re-dial on the next tick.
  //
  // ⚠️ This CONVERGES with the outcome path by construction, and that is worth
  // knowing before trusting a test here: a dispositioned attempt's outcome is
  // `connected`, whose default policy is `max_attempts: 0` ⇒ `completed`. So
  // asserting `contactState` alone cannot tell "the disposition decided" from "the
  // outcome policy decided" on this arm. `reason` is the only field that can, which
  // is why it is returned rather than logged.
  return {
    contactState: 'completed', nextAttemptAt: null, suppressedReason: null,
    reason: 'disposition_recorded',
  };
}
