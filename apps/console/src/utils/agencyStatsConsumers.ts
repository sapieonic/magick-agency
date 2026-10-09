import type { AgencyCampaignStats } from '../types/agency-campaign';

/**
 * Who reads each field of the supervisor stats payload — MAG-151 acceptance (3).
 *
 * ── The defect this exists to stop ──────────────────────────────────────────
 * Three separate slices of one payload have now shipped computed by core,
 * proxied by master, and **discarded at the last hop**: the health-strip fields
 * (MAG-71), the agent roster (MAG-148), and §C.3's derived figures (MAG-151).
 * Each was found by a person happening to read core's contract beside cusui's,
 * and each time the review step that should have caught it did not, because
 * there was nothing to catch it *with* — a field nobody consumes produces no
 * error, no warning, and no failing test. It produces a blank space on a screen
 * that nobody is looking at yet.
 *
 * ── How this catches it ─────────────────────────────────────────────────────
 * The map is `Record<keyof AgencyCampaignStats, …>` and therefore **exhaustive
 * at compile time**. Declaring a new field on the payload type without saying
 * who reads it is a type error in `npm run lint`, not a discovery six weeks
 * later. The accompanying test then checks the claims are true: a field marked
 * `consumedIn` must actually appear in that file's code, and a field marked
 * `unconsumed` must appear in none of the supervisor surface.
 *
 * ── What "consumed" proves, exactly ─────────────────────────────────────────
 * That the field is **read**, not that the value reaches the screen. The check
 * is syntactic: a file that keeps `const n = stats?.human_connects` and then
 * renders a hardcoded `0` still satisfies it. That is a deliberate limit rather
 * than an oversight — proving a read reaches rendered output needs dataflow
 * analysis, and the thing it would guard is already covered by the component
 * tests, which assert on the DOM. This map guards the failure those tests
 * cannot see: a field with no reader at all, which no test ever thinks to write
 * because nothing references it.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * It does not detect a field **core added and cusui never declared**. That
 * direction cannot be checked from inside this repo, and the obvious
 * implementation — scraping a sibling `magic-voice-core` checkout — is a
 * pattern already known to be broken: master's equivalent guard reads the
 * sibling's *working tree*, so its result depends on which branch someone else
 * has checked out, and it skips silently in CI where no sibling exists
 * (MAG-143). Building a second copy of that before MAG-143 settles the
 * mechanism would double the maintenance and the false confidence. The
 * cross-repo direction is tracked there; this half is the half that can be
 * enforced everywhere, including CI.
 */

export type StatsFieldConsumer =
  /** A source file whose code must mention this field. */
  | { readonly consumedIn: SupervisorSource }
  /** Nothing reads it, on purpose. The reason is the whole point of the entry. */
  | { readonly unconsumed: string };

/**
 * The supervisor surface: every file that renders this payload.
 *
 * The list is closed rather than "anything under `src/`" so that an
 * `unconsumed` claim means something. `campaign_id` as a string appears all
 * over the agency API modules for unrelated reasons, and a repo-wide search
 * would call that a consumer.
 */
export const SUPERVISOR_SOURCES = [
  'src/pages/agency/AgencyCampaignDetailPage.tsx',
  'src/components/agency/CampaignHealthStrip.tsx',
  'src/components/agency/CampaignPerformance.tsx',
  'src/components/agency/AgentFloor.tsx',
  'src/components/agency/AgentFloorDrawer.tsx',
  'src/utils/agencyHealthStrip.ts',
  'src/utils/agencyCampaignOverview.ts',
  'src/utils/agencyCampaignPerformance.ts',
  'src/utils/agencyAgentFloor.ts',
] as const;

export type SupervisorSource = (typeof SUPERVISOR_SOURCES)[number];

/*
  The file named is where the field is READ OFF THE PAYLOAD, which is not always
  where it is rendered. `agencyHealthStrip.ts` composes most of the strip's copy
  but takes primitives, so `abandonment_rate_24h_pct` never appears in it — the
  component above it does the reading. Naming the renderer would make the guard
  pass on a file that has no idea the field exists.
*/
const OVERVIEW = 'src/utils/agencyCampaignOverview.ts';
const STRIP = 'src/components/agency/CampaignHealthStrip.tsx';
const PERFORMANCE = 'src/utils/agencyCampaignPerformance.ts';
const FLOOR = 'src/components/agency/AgentFloor.tsx';

export const AGENCY_STATS_FIELD_CONSUMERS: Record<
  keyof AgencyCampaignStats,
  StatsFieldConsumer
> = {
  // ── Deliberately unread ────────────────────────────────────────────────────
  campaign_id: {
    unconsumed:
      'The campaign id is the route parameter. Reading a second copy off the stats '
      + 'body would give the page two sources for one fact and no way to notice them '
      + 'disagreeing.',
  },
  status: {
    unconsumed:
      'The badge and the lifecycle controls read `campaign.status`, which is fetched '
      + 'alongside and is the object the transition endpoint returns. A page that '
      + 'trusted the stats copy could show "Running" beside a Start button that 409s.',
  },

  // ── §C.1's counters ────────────────────────────────────────────────────────
  //
  // These moved off the page and into `agencyCampaignOverview` (MAG-167): the
  // Overview panel no longer renders one tile per field, so every one of them
  // is now read by a derivation — the funnel's proportions, the "list worked"
  // ring, or a cell of the pulse strip — rather than by a `formatMetric` call
  // in JSX. The reader moving is exactly the staleness this map is here to
  // catch, so the entries move with it.
  contacts_total: { consumedIn: OVERVIEW },
  contacts_pending: { consumedIn: OVERVIEW },
  contacts_in_flight: { consumedIn: OVERVIEW },
  contacts_completed: { consumedIn: OVERVIEW },
  contacts_suppressed: { consumedIn: OVERVIEW },
  contacts_exhausted: { consumedIn: OVERVIEW },
  retries_pending: { consumedIn: OVERVIEW },
  attempts_total: { consumedIn: OVERVIEW },
  attempts_connected: { consumedIn: OVERVIEW },
  // Two readers, and the guard needs only one: the pulse strip renders it, and
  // the page's poll predicate reads it to decide whether the numbers are still
  // moving.
  attempts_live: { consumedIn: OVERVIEW },
  // Two readers, and the guard needs only one: the floor uses it to distinguish
  // “the roster did not load” from “nobody is on this campaign”, and the
  // Overview rail falls back to it when `agents_by_state` is absent — a total
  // with no breakdown, which draws no bar and claims nothing about who is free.
  agents_live: { consumedIn: FLOOR },

  // ── §C.2's health strip ────────────────────────────────────────────────────
  stall: { consumedIn: STRIP },
  other_stalls: { consumedIn: STRIP },
  concurrency_limit: { consumedIn: STRIP },
  concurrency_in_use: { consumedIn: STRIP },
  abandonment_rate_24h_pct: { consumedIn: STRIP },
  abandonment_ceiling_pct: { consumedIn: STRIP },
  abandoned_24h: { consumedIn: STRIP },
  answered_24h: { consumedIn: STRIP },

  // ── §C.3's derived figures ─────────────────────────────────────────────────
  connect_rate_pct: { consumedIn: PERFORMANCE },
  human_connects: { consumedIn: PERFORMANCE },
  machine_connects: { consumedIn: PERFORMANCE },
  unclassified_connects: { consumedIn: PERFORMANCE },
  machine_connects_available: { consumedIn: PERFORMANCE },
  aht_seconds_including_machine: { consumedIn: PERFORMANCE },
  avg_wrapup_seconds: { consumedIn: PERFORMANCE },
  // Two consumers: the handle-time readout renders it, and the floor uses it as
  // rank 2's threshold. One is enough for the guard.
  aht_seconds: { consumedIn: PERFORMANCE },
  // Conversion. `is_success` had been a settable-but-unread field on every
  // campaign's disposition catalog since the builder shipped — the same
  // producer-with-no-consumer defect in a third direction — and these two are
  // its first reader anywhere in the product.
  attempts_success: { consumedIn: PERFORMANCE },
  success_rate_pct: { consumedIn: PERFORMANCE },

  // ── §C.4's floor ───────────────────────────────────────────────────────────
  agents: { consumedIn: FLOOR },
  agents_by_state: { consumedIn: FLOOR },

  // ── MAG-167: the workspace redesign's two nice-to-have fields ─────────────
  //
  // Both are read by a derivation in the Overview module rather than by a
  // `formatMetric` call in JSX, which is the pattern every §C.1 counter moved to
  // — and the reason those entries moved with their readers.
  //
  // Neither has a fallback and neither needs one: an absent field drops the one
  // sentence it fills. That is what let them ship as the lower-priority half of
  // the contract, and it is also why this map is the only thing standing between
  // "core sends it" and "nobody notices it stopped arriving".
  attempts_retried: { consumedIn: OVERVIEW },
  agents_peak: { consumedIn: OVERVIEW },
};
