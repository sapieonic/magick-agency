import type { AgencyCampaignStats } from '../types/agency-campaign';

/**
 * Who reads each field of the supervisor stats payload.
 *
 * ── The defect this exists to stop ──────────────────────────────────────────
 * Three separate slices of one payload have now shipped computed by the server,
 * proxied by the API, and **discarded at the last hop**: the health-strip fields,
 * the agent roster, and the derived campaign figures.
 * Each was found by a person happening to read the server's contract beside this console's,
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
 * It does not detect a field **the server added and this console never declared**. That
 * direction cannot be checked from inside the console, and the obvious
 * implementation — scraping the server's source tree from a console test — would
 * tie this suite to the server's file layout. Building that before the mechanism
 * is settled would add maintenance and false confidence. The
 * server-side direction is tracked separately; this half is the half that can be
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
  'src/pages/agency/campaign-detail/useAgencyCampaignDetail.ts',
  'src/pages/agency/AgencyCampaignsPage.tsx',
  'src/pages/agency/campaigns-home/ActiveCampaignCard.tsx',
  'src/pages/agency/campaigns-home/useCampaignsHome.ts',
  'src/components/agency/CampaignHealthStrip.tsx',
  'src/components/agency/CampaignPerformance.tsx',
  'src/components/agency/AgentFloor.tsx',
  'src/components/agency/AgentFloorDrawer.tsx',
  'src/utils/agencyHealthStrip.ts',
  'src/utils/agency/overview/pulse.ts',
  'src/utils/agencyCampaignPerformance.ts',
  'src/utils/agencyAgentFloor.ts',
  'src/pages/agency/AgencyAnalyticsPage.tsx',
  'src/utils/agency/home.ts',
] as const;

export type SupervisorSource = (typeof SUPERVISOR_SOURCES)[number];

/*
  The file named is where the field is READ OFF THE PAYLOAD, which is not always
  where it is rendered. `agencyHealthStrip.ts` composes the strip's copy but is
  handed the stall itself, so `stats.stall` never appears in it — the component
  above it does the reading. Naming the renderer would make the guard
  pass on a file that has no idea the field exists.
*/
/** The campaigns home's list-worked ring. */
const RING = 'src/utils/agency/overview/pulse.ts';
/** The campaigns home's live card. */
const CARD = 'src/pages/agency/campaigns-home/ActiveCampaignCard.tsx';
const STRIP = 'src/components/agency/CampaignHealthStrip.tsx';
const PERFORMANCE = 'src/utils/agencyCampaignPerformance.ts';
const FLOOR = 'src/components/agency/AgentFloor.tsx';
/** Home's rules (B28): the attention list and the floor. */
const HOME = 'src/utils/agency/home.ts';

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

  // ── the campaign counters ────────────────────────────────────────────────────────
  //
  // The Overview panel's derivations (the contact funnel, the pulse strip) were the
  // readers of most of these. The Insights tab replaced that panel (IN1) and they were
  // deleted, so each entry now names a live reader — the campaigns home's list-worked
  // ring and live card, the Analytics page's Performance card — or says it is unread.
  contacts_total: { consumedIn: RING },
  contacts_pending: { consumedIn: CARD },
  contacts_in_flight: {
    unconsumed:
      'Read only by the Overview contact funnel, deleted with the panel. The Insights tab '
      + 'shows contacts on a call from its own summary read (`summary.roster.on_call`).',
  },
  contacts_connected: {
    unconsumed:
      'Read only by the Overview contact funnel, deleted with the panel. The Insights tab '
      + 'shows contacts in wrap-up from its own summary read (`summary.roster.in_wrapup`).',
  },
  contacts_completed: { consumedIn: RING },
  contacts_suppressed: { consumedIn: RING },
  contacts_exhausted: { consumedIn: RING },
  retries_pending: {
    unconsumed:
      'Read only by the Overview funnel\'s retries note, deleted with the panel. The Insights '
      + 'tab shows contacts waiting for a retry from its own read (`summary.roster.waiting_retry`).',
  },
  attempts_total: { consumedIn: PERFORMANCE },
  attempts_connected: { consumedIn: PERFORMANCE },
  // Two readers, and the guard needs only one: the live card renders it, and
  // `agencyCampaignsHome.ts` reads it to decide whether a campaign is still live.
  attempts_live: { consumedIn: CARD },
  // Two readers, and the guard needs only one: the floor uses it to distinguish
  // “the roster did not load” from “nobody is on this campaign”, and the live card
  // on the campaigns home shows it.
  agents_live: { consumedIn: FLOOR },

  // ── the health strip ────────────────────────────────────────────────────
  //
  // The strip is the diagnosis alone now. Its concurrency and abandonment read-outs
  // rendered only in the Overview panel's `mode="readouts"` instance, deleted with
  // the panel (IN1), so the six fields they read are unread here: the Insights tab
  // serves the same figures from its own reads.
  stall: { consumedIn: STRIP },
  other_stalls: { consumedIn: STRIP },
  concurrency_limit: {
    unconsumed:
      'Read only by the health strip\'s concurrency read-out, deleted with the Overview panel. The '
      + 'Insights headline shows the line limit from its own read (`headline.running.concurrency_limit`).',
  },
  concurrency_in_use: {
    unconsumed:
      'Read only by the health strip\'s concurrency read-out, deleted with the Overview panel. The '
      + 'Insights headline shows lines in use from its own read (`headline.running.concurrency_in_use`).',
  },
  // The campaign's place in the account's line limit (decisions MC7). Two readers, and
  // the guard needs only one: the live card on the campaigns home and the detail page's
  // header both render it through `concurrencyLine`.
  concurrency: { consumedIn: CARD },
  abandonment_rate_24h_pct: {
    unconsumed:
      'Read only by the health strip\'s abandonment read-out, deleted with the Overview panel. The '
      + 'Insights tab shows the rolling rate from its own reads (`health.abandonment.rolling_24h`).',
  },
  // Read again by Home (B28): its abandonment rule and the floor's rate, over the guardrail's
  // 24 hours with IN5's sample floor. The strip's read-out that read them first is gone.
  abandonment_ceiling_pct: { consumedIn: HOME },
  abandoned_24h: { consumedIn: HOME },
  answered_24h: { consumedIn: HOME },

  // ── the derived figures ─────────────────────────────────────────────────
  connect_rate_pct: { consumedIn: PERFORMANCE },
  first_dials_placed: { consumedIn: PERFORMANCE },
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

  // ── the agent floor ───────────────────────────────────────────────────────────
  agents: { consumedIn: FLOOR },
  agents_by_state: { consumedIn: FLOOR },

  // ── the workspace redesign's two nice-to-have fields ─────────────
  //
  // Both filled a sub-line of the Overview pulse strip, deleted with the panel.
  attempts_retried: {
    unconsumed:
      'Read only by the Overview pulse strip\'s dial sub-line, deleted with the panel. The '
      + 'Insights tab serves agent retries from its own activity read (`calls.agent_retries`).',
  },
  attempts_redialed: {
    unconsumed:
      'Read only by the Overview pulse strip\'s dial sub-line, deleted with the panel. The '
      + 'Insights tab serves wrap-up redials from its own activity read (`calls.redials.placed`).',
  },
  agents_peak: {
    unconsumed:
      'No producer on `/stats` (the contract declares it optional and the server never '
      + 'sends it). The Insights tab shows the agents online per trend bucket instead '
      + '(`trends.agents_online_peak`).',
  },
};
