
// The Overview's derivations live in `./agency/overview/`, re-exported so every
// import of this module keeps working. `figure.ts` is shared plumbing: only its
// type is part of this module's surface.
export type { OverviewFigure } from './agency/overview/figure';
export * from './agency/overview/funnel';
export * from './agency/overview/pulse';
export * from './agency/overview/lifecycle';

/**
 * The Overview panel's derivations — the pulse strip, the contact funnel, the
 * live-floor slice of the rail, and the "How it ran" facts.
 *
 * Same reasoning as `agencyCampaignPerformance` and `agencyHealthStrip`: every
 * value below is a claim about the campaign derived from a payload of optional
 * and nullable fields, and a derivation is a place to be confidently wrong. They
 * are pure and tested rather than inlined into JSX and eyeballed.
 *
 * ── The one rule the whole module is built around ───────────────────────────
 * **A missing number is never a zero, and a null rate is never 0%.** The stats
 * payload carries three different absences and they read differently:
 *
 * 1. **`undefined`** — the field did not arrive (an older the server, an older
 *    the API, or a partial read). Renders `—` and `known: false`.
 * 2. **`null`** — the server carried the field and has nothing to measure. Every rate
 *    on this payload is null before its denominator exists. The sub-line that
 *    would have quoted it is **dropped**, rather than printed as `0%`.
 * 3. **A real `0`** — a measurement, and the only one of the three that is a
 *    claim about the campaign. It renders as `0`.
 *
 * ── Every rate names its own denominator ────────────────────────────────────
 * The two rates on this payload are measured against different things on
 * purpose (`connect_rate_pct` over attempts, `success_rate_pct` over connected
 * calls), so neither may appear as a bare percentage. Each sub-line below names
 * what it is out of, and — more importantly — each rate is attached to the cell
 * holding its own NUMERATOR:
 *
 * - `connect_rate_pct` is `human_connects / attempts_total`, so it sits under
 *   **Spoke to a person** (whose value is `human_connects`), not under Reached
 *   someone (`attempts_connected`). Putting it there would pair a percentage
 *   with a number that is not its numerator, and a supervisor reading the two in
 *   one glance would divide one by the other and get a third, wrong figure.
 * - `success_rate_pct` is `attempts_success / attempts_connected`, so its
 *   sub-line names "calls that reached someone" — the label of the cell that
 *   holds its denominator.
 *
 * No rate is re-derived here. A blended connect rate computed from
 * `attempts_connected / attempts_total` would be a second, different connect
 * rate for the same campaign, which is exactly what the server's single wire figure
 * exists to prevent.
 */

// ── Shared shapes ───────────────────────────────────────────────────────────


