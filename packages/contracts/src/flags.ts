/**
 * The three agency feature flags: keys, defaults, scopes, `envVar` names,
 * `clientExposed`, owners and descriptions. Super-admins can override them per
 * tenant and account.
 *
 * Data and types only. A registry that registers into a module-level `Map` and an
 * env resolver that reads `process.env` do not belong in a package two browser
 * apps import, so the registry and the env resolution are the server's to build
 * on top of {@link AGENCY_FLAGS}. `FlagDefinition` has no `validate` predicate
 * (a function), and none of these three flags needs one.
 */

export type FlagScope = 'global' | 'tenant' | 'account';
export type FlagType = 'boolean' | 'number' | 'string' | 'json';

/** A flag definition, without `validate` (see the module note). */
export interface FlagDefinition<T = unknown> {
  /** Unique catalog key (matches the `feature_flag_overrides.flag_key`). */
  key: string;
  type: FlagType;
  /** Resolved fallback when no override row and no env default apply. */
  default: T;
  description: string;
  /** Owning team/domain. */
  owner: string;
  /** Which override scopes are permitted for this flag. */
  scopes: FlagScope[];
  /** Optional boot-time default override env var (e.g. staging = on). */
  envVar?: string;
  /** May be returned to tenant-facing clients (the `/api/v1/feature-flags` surface). */
  clientExposed?: boolean;
  /** Future: deterministic percentage bucketing by tenant. */
  rollout?: { percentByTenant?: boolean };
}

/**
 * The definitions, frozen as the dialer runtime's `defineFlag` freezes each one
 *. Keyed by flag key.
 */
export const AGENCY_FLAGS = Object.freeze({
  /*
   * The agency product's own analysis switch. Agency legs are `webrtc_calls` rows
   * too, so before this flag existed the end-of-call gate applied
   * `dialer_call_analysis` to them — which meant a tenant enabling softphone
   * analysis silently started paying for transcription on every campaign call,
   * and a tenant turning it off lost agency analysis it had bought separately.
   * Two products, two switches.
   *
   * Deliberately a sibling of `dialer_call_analysis` rather than a child: the
   * `dialer_analysis_*` config block and the analysis worker are shared
   * machinery, and an agency tenant that runs no softphone must be able to turn
   * this on without turning that on.
   *
   * ── `default: false` is right, and is NOT what makes the split a regression ─
   *
   * Do not "fix" this default to true. It looks like the thing that would
   * silently turn agency analysis off on the day the split ships — every tenant
   * whose agency calls were being analysed under `dialer_call_analysis` resolves
   * a brand-new flag that has no override rows, so gate 2 returns, nothing is
   * enqueued, and `analysis_status` stays NULL with no error anywhere. But
   * flipping the default fixes that by enabling a metered, consent-sensitive
   * feature for every tenant that never asked for it, including every tenant
   * created afterwards. Analysis is a per-call transcription cost, so that blast
   * radius is a bill.
   *
   * The existing state is carried forward as DATA instead, where it can be
   * scoped, attributed and removed:
   * `src/db/migrations/107_agency_call_analysis_backfill.sql` seeds this flag
   * true at exactly the scopes where agency analysis was already running —
   * tenants that have agency campaigns and whose `dialer_call_analysis` resolved
   * true — and false where an operator had explicitly turned softphone analysis
   * off. Every seeded row carries a `reason` saying so, so a super-admin reading
   * it later knows why it exists and that deleting it is safe.
   *
   * The one layer that backfill cannot reach is this `envVar`. An environment
   * with `FF_DIALER_CALL_ANALYSIS` set truthy resolves `dialer_call_analysis`
   * true for every tenant with no override row for a migration to find, so
   * `FF_AGENCY_CALL_ANALYSIS` has to be set alongside it there. The migration
   * header carries that as a deploy obligation.
   *
   * There is no softphone and no `dialer_call_analysis` here, so the "two
   * products" argument is historical. The `default: false` reasoning (metered,
   * consent-sensitive) still holds.
   */
  agency_call_analysis: {
    key: 'agency_call_analysis',
    type: 'boolean',
    // Gated: costs money, consent-sensitive. Pre-split behaviour is preserved by
    // migration 107's backfill, NOT by this default — see above.
    default: false,
    envVar: 'FF_AGENCY_CALL_ANALYSIS', // staging: FF_AGENCY_CALL_ANALYSIS=true
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console shows/hides the agency analysis UI
    owner: 'voice',
    description: 'Post-call analysis (transcript + summary + dimensions) for agency campaign calls',
  },

  // ── Agency dialer (human-agent outbound power dialing) ──────────────────────
  // Off by default. v1 has no settlement, so the flag is the per-tenant /
  // per-account kill switch for the dialer.
  agency_dialer_enabled: {
    key: 'agency_dialer_enabled',
    type: 'boolean',
    default: false,
    envVar: 'FF_AGENCY_DIALER', // staging: FF_AGENCY_DIALER=true
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true, // the console shows/hides the Agent + Supervisor consoles
    owner: 'voice',
    description: 'Agency dialer: human-agent outbound power dialing (campaigns, agent stations, pacing engine)',
  },

  // ── Late binding: attach the agent at the ANSWER, not before the dial ───────
  //
  // Off changes nothing: `executeDial` writes the `reserved` panel to the agent's
  // socket and attaches it to the bridge before the carrier is dialed, so the
  // agent watches the call ring. On, the panel is built at dial time but held, the
  // leg is placed with no browser socket at all, and both the panel and the socket
  // are delivered synchronously at the carrier answer — so a dial that rings out,
  // is busy, fails or finds an unreachable handset reaches the console as
  // *nothing*. A dial answered by VOICEMAIL still reaches the agent: the carrier
  // reports it `answered` like any other, and D1 puts AMD out of scope, so
  // nothing can tell a machine from a human before the bind (see
  // `contracts.ts` on `AgencyAttemptOutcome`). Shortening that greeting is a
  // wrap-up problem, not a binding one.
  //
  // Two things it is NOT, because both would be reasonable guesses:
  //
  //  1. **It is not over-dialing.** The pacing tick still places at most one dial
  //     per idle agent (`pacing-engine.ts`'s `to_dial`), so the fan-out is
  //     unchanged. Late binding fixes the idle *experience*; only over-dialing
  //     moves idle *time*, and that is blocked on a carrier that can cancel a
  //     ringing leg (`ProviderCapabilities.cancelRinging`) and on a floor of five
  //     or more agents — at two the marginal-abandonment arithmetic allows no
  //     extra dials at all.
  //  2. **It is not provider-gated in code.** VoiceLink is the intended first
  //     cohort, because that is where a cancelled ring silently keeps ringing and
  //     answers into a dismissed console — but the gate is this flag and the
  //     adapter capability, never a branch on a provider name. A per-provider
  //     branch here is how the next carrier gets the wrong behaviour by default.
  //
  // ⚠️ The bind runs INSIDE the 1s `ABANDONMENT_BRIDGE_GRACE_MS` budget
  // (`src/agency/abandonment-predicate.ts`): everything after the answer and
  // before the socket is attached is time the compliance predicate counts as a
  // call that reached nobody. That is why the bind path is synchronous and why the
  // panel's contact context is fetched at dial time rather than at the answer.
  // Anything added to it — an AMD dwell, a second round trip — spends that budget.
  agency_late_binding: {
    key: 'agency_late_binding',
    type: 'boolean',
    default: false,
    envVar: 'FF_AGENCY_LATE_BINDING', // staging: FF_AGENCY_LATE_BINDING=true
    scopes: ['global', 'tenant', 'account'],
    // NOT client-exposed: the console receives the same frames in the same order,
    // just later, so there is nothing for the console to show or hide. A flag the client
    // can read is a flag the client can branch on, and the whole point here is
    // that the console needs no knowledge of when the bind happened.
    owner: 'voice',
    description: 'Agency dialer: bind the agent to a campaign call at the carrier answer instead of before the dial',
  },
} satisfies Record<string, FlagDefinition<boolean>>);

/** The three agency flag keys. */
export type AgencyFlagKey = keyof typeof AGENCY_FLAGS;

export const AGENCY_FLAG_KEYS = [
  'agency_dialer_enabled',
  'agency_late_binding',
  'agency_call_analysis',
] as const satisfies readonly AgencyFlagKey[];

type MissingFlagKey = Exclude<AgencyFlagKey, (typeof AGENCY_FLAG_KEYS)[number]>;
const _allFlagKeysListed: MissingFlagKey extends never ? true : MissingFlagKey = true;
void _allFlagKeysListed;

/** Flags whose resolved values may reach a browser (`clientExposed: true`). */
export type ClientExposedAgencyFlagKey = {
  [K in AgencyFlagKey]: (typeof AGENCY_FLAGS)[K] extends { clientExposed: true } ? K : never;
}[AgencyFlagKey];

/**
 * The client-exposed flag map the console reads (the agency successor of
 * `GET /proxy/feature-flags` → the console `FeatureFlagMap`), narrowed to agency's
 * exposed keys. `agency_late_binding` is deliberately absent — see its comment.
 */
export type AgencyClientFlagMap = Record<ClientExposedAgencyFlagKey, boolean>;
