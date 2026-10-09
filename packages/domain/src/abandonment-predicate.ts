/**
 * ─── WHAT "ABANDONED" MEANS, AS DATA (`AD-P2-C-06`) ─────────────────────────
 *
 * Deliberately a leaf module: no repository, no metrics registry, no imports at
 * all. Both the SQL that reads the window and the code that publishes it need
 * these definitions, and if they lived with either one the other would have to
 * import through it — which is how the "independent audit" half of this ticket
 * would quietly acquire a dependency on the thing it audits.
 */

/**
 * `N` from test-plan §10: how long after the carrier answers a bridge may still
 * arrive before the call counts as abandoned.
 *
 * 1000ms, per §10's recommendation and the interval its SQL is written with. It
 * is a **business threshold**, so it lives here as a named constant and is
 * interpolated into the predicate — never expressed as a key TTL (§6.1).
 */
export const ABANDONMENT_BRIDGE_GRACE_MS = 1000;

/** The regulatory window. Ofcom and the design's default ceiling both use 24h. */
export const ABANDONMENT_WINDOW_HOURS = 24;

/**
 * The single definition of "this attempt was abandoned", as SQL over raw columns.
 *
 * Exported so the metric's numerator and any audit query are the *same* predicate
 * — a second copy is how two numbers that should be identical drift. It reads
 * `outcome`, `bridged_at` and `answered_at` directly and depends on no counter,
 * no cache and no in-process state, which is what makes it usable as an
 * independent audit of `agency_abandoned_total`.
 *
 * ⚠️ **This adds `state = 'ended'` to §10's predicate as written, and that needs
 * QA's agreement rather than my say-so.** §10's version has no terminal filter, so
 * its `bridged_at IS NULL` arm is true of an attempt that is answered and *still
 * being bridged*, and of one mid-apology on the abandoned path. Without the
 * filter, live traffic inflates the compliance rate in real time and the
 * `AD-P4-C-02` auto-pause would fire on a healthy campaign at concurrency —
 * pausing a campaign for calls that were about to connect. Abandonment is a
 * property of a call that is OVER, so only terminal attempts are counted. Flagged
 * because QA's cross-check query must match this or the two disagree for a reason
 * that is not a bug.
 */
export const ABANDONED_ATTEMPT_PREDICATE_SQL = `
  state = 'ended'
  AND answered_at IS NOT NULL
  AND (
    outcome = 'abandoned'
    OR bridged_at IS NULL
    OR bridged_at - answered_at > interval '${ABANDONMENT_BRIDGE_GRACE_MS} milliseconds'
  )
`;

/**
 * The facts the predicate needs, as an attempt's own in-process record.
 *
 * `answeredAt`/`bridgedAt` are `null` for "not stamped", mirroring the columns.
 */
export interface AbandonedAttemptFacts {
  answeredAt: Date | null;
  bridgedAt: Date | null;
  outcome: string | null;
}

/**
 * {@link ABANDONED_ATTEMPT_PREDICATE_SQL}, evaluated in process.
 *
 * **The two must agree on the arms they share — which is NOT all of them — and
 * living beside each other is the only reason they will.** An earlier draft of this
 * header said "byte-for-byte equivalent", which is false eight lines below its own
 * claim (`state = 'ended'` has no counterpart here) and is exactly the sentence a
 * reviewer would lean on while editing one side. The accurate statement:
 * `answered_at`, `bridged_at`, `outcome` and the grace comparison must match
 * exactly; the terminal filter is the SQL's alone, and the paragraph below says why
 * that is safe rather than an omission.
 *
 * They exist because `agency_abandoned_total` has to
 * be keyed on the same DEFINITION the table is, not on the classifier's label:
 * `outcome === 'abandoned'` is stamped only by `abandonAnsweredCall`, which runs
 * only when no live station owns the agent at answer time, so an answered call
 * whose bridge failed for any *other* reason (bridge failure, carrier hangup
 * between answer and bridge, a socket that died in the same window) was abandoned
 * in the table and invisible to the counter — under-reporting in the direction
 * that looks compliant.
 *
 * `state = 'ended'` is deliberately **not** a field here: the sole caller is the
 * settle site, which by construction is the moment the attempt becomes terminal.
 * Adding a `state` parameter would invite a call from somewhere that is not that
 * moment, which is the arm of the SQL predicate that keeps live traffic out of the
 * compliance rate.
 *
 * ⚠️ **What this can and cannot see.** Its inputs are one replica's in-process
 * record of an attempt it owns, so it is exact for every attempt settled by the
 * owning replica's `ended` handler and blind to any attempt settled by a path with
 * no in-process record — the reaper's orphan sweep after a crash, most of all.
 * That residue is irreducible for a process-local counter and is the reason the
 * SQL window gauge, not this, is what `AD-P4-C-02`'s auto-pause reads.
 */
export function isAbandonedAttempt(facts: AbandonedAttemptFacts): boolean {
  // No carrier answer ⇒ nothing was abandoned. This is the arm that keeps a call
  // that merely rang out of the numerator, and it mirrors `answered_at IS NOT NULL`.
  if (facts.answeredAt === null) return false;
  if (facts.outcome === 'abandoned') return true;
  if (facts.bridgedAt === null) return true;
  return facts.bridgedAt.getTime() - facts.answeredAt.getTime() > ABANDONMENT_BRIDGE_GRACE_MS;
}

/** One campaign's slice of the rolling window. */
export interface AbandonmentWindowRow {
  tenant_id: string;
  campaign_id: string;
  answered: number;
  abandoned: number;
}

/**
 * A window row joined to the campaign it belongs to (`AD-P4-C-02`).
 *
 * The guardrail needs two campaign facts the attempts table cannot supply — is
 * the campaign still `running`, and what is ITS ceiling — and it must read them
 * from **the same aggregate** the metrics gauges are published from. A second
 * query would be a second definition of "the window", and this codebase already
 * carries the scar from that: `ABANDONED_ATTEMPT_PREDICATE_SQL` exists as one
 * exported string precisely so the audited number and the product number cannot
 * drift. The guardrail firing on a rate that disagrees with the gauge a
 * compliance alert reads would be invisible until someone reconciled them by
 * hand.
 *
 * Both fields are nullable because the join is a LEFT JOIN: attempts can outlive
 * the campaign row. Metrics still publish for such a row; the guardrail skips it,
 * because there is nothing left to pause.
 */
export interface AgencyAbandonmentWindowRow extends AbandonmentWindowRow {
  status: string | null;
  ceiling_pct: number | null;
}

/**
 * The rate for one window row, as a percentage.
 *
 * **Zero answered calls is `null`, not `0`.** A campaign that has answered nothing
 * has no abandonment rate — reporting 0% would tell a supervisor the campaign is
 * compliant when it has no evidence either way, and reporting 100% off a single
 * call would trip the guardrail. Callers decide what to do with `null`; the
 * guardrail's answer is "do not pause on it".
 */
export function abandonmentRatePct(row: Pick<AbandonmentWindowRow, 'answered' | 'abandoned'>): number | null {
  if (row.answered <= 0) return null;
  return (row.abandoned / row.answered) * 100;
}
